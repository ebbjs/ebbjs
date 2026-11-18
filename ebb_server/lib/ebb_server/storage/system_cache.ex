defmodule EbbServer.Storage.SystemCache do
  @moduledoc """
  Supervisor that owns the in-memory state used on the hot paths:
  permission checks, dirty entity tracking, entity membership, the derived
  component and incoming-edge indexes, and the GSN counter. The watermark's
  resolution frontier lives in the sibling `WatermarkTracker`; the in-flight
  action-id guard that makes retries idempotent lives in the sibling
  `InFlightActions`.

  ## Why this exists

  A single Writer GenServer and a single SQLite connection wouldn't be
  a bottleneck for 1k writes/s, but `POST /sync/actions` is not the only
  reader — SSE fan-out reads GSN counters, `GET /entities/:id` hits
  permission checks, `GET /sync/groups/:gid` reads group membership.
  Putting all that state in ETS + `:atomics` lets the single Writer be
  the only serialized path (correctness) while everything else reads in
  parallel with no contention.

  ## Lifecycle

  On init, the supervisor rebuilds the derived component existence index and
  the incoming-edge index from `cf_actions`, then populates `GrantCache`,
  `MembershipCache` and `GroupAppsCache` from the system entities before
  returning. The same pass re-marks every modeled row dirty; dirty marks are
  in-memory and would otherwise be lost on a restart, leaving patch-only rows
  clean-but-stale and never-materialized rows missing (#564). The eager
  system-type populators clear their marks by materializing; user types stay
  marked until their first read. The outer `Storage.Supervisor`
  uses `rest_for_one` so RocksDB is up before any cache child starts; the
  supervision tree blocks accepting connections until this returns. If
  population raises, `init/1` tears down the cache children and fails the
  start rather than reporting health over a half-populated cache.
  """

  use GenServer

  require Logger

  alias EbbServer.Storage.{
    ActionFormat,
    CacheTables,
    ComponentEntityIndex,
    DirtyTracker,
    EntityModelCache,
    EntityStore,
    GrantCache,
    GroupAppsCache,
    LinkTargetIndex,
    MembershipCache,
    RocksDB,
    RowMutations,
    SystemComponent
  }

  alias EbbServer.Telemetry

  # Boot re-marking writes one mark per indexed entity, so the batches are
  # bounded to keep a large index from ever being collected into one list.
  @dirty_mark_chunk_size 1_000

  @empty_measurements %{
    entity_models: 0,
    grants: 0,
    memberships: 0,
    group_apps: 0
  }

  @populate_opt_keys [
    :rocks_name,
    :table,
    :grants_by_id,
    :grants_by_group,
    :memberships,
    :memberships_by_id,
    :memberships_by_group,
    :group_apps,
    :entity_models,
    :component_index,
    :component_entity_labels,
    :link_targets,
    :link_target_labels
  ]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Emits `[:ebb, :system_cache, :populated]` with per-cache counts and a
  native `duration`, and metadata `outcome` (`:ok` or `:error`). On a
  failed rebuild the counts reached so far are included, so a partially
  populated cache is observable before the raise propagates.
  """

  @spec populate_system_caches(keyword()) :: :ok
  def populate_system_caches(opts \\ []) do
    started = System.monotonic_time()

    case do_populate_system_caches(opts) do
      {:ok, measurements} ->
        emit_populate_telemetry(started, measurements, %{outcome: :ok})
        :ok

      {:error, measurements, kind, reason, stacktrace} ->
        emit_populate_telemetry(started, measurements, %{
          outcome: :error,
          reason: telemetry_reason(kind, reason)
        })

        :erlang.raise(kind, reason, stacktrace)
    end
  end

  # Failures before the first phase (table-name resolution, the marker
  # read) must not escape without an event, so wrap the whole rebuild and
  # report zero progress for them. All counted work must stay inside
  # `phase/3`; anything that raises out here is reported as zero progress.
  defp do_populate_system_caches(opts) do
    rocks_name = Keyword.get(opts, :rocks_name, EbbServer.Storage.RocksDB)
    dirty_set = Keyword.get(opts, :dirty_set) || DirtyTracker.dirty_set_name()

    populate_caches_from_indexes(rocks_name, populate_tables(opts), dirty_set, opts)
  rescue
    e -> {:error, @empty_measurements, :error, e, __STACKTRACE__}
  catch
    kind, reason -> {:error, @empty_measurements, kind, reason, __STACKTRACE__}
  end

  # Resolve every table before the rebuild starts so one pass is pinned to a
  # single cache set; a concurrent publish cannot split it across instances.
  defp populate_tables(opts) do
    {default_component_index, default_component_entity_labels} = ComponentEntityIndex.tables()
    {default_link_targets, default_link_target_labels} = LinkTargetIndex.tables()

    %{
      grants: table_opt(opts, :table, CacheTables.grants()),
      grants_by_id: table_opt(opts, :grants_by_id, CacheTables.grants_by_id()),
      grants_by_group: table_opt(opts, :grants_by_group, CacheTables.grants_by_group()),
      memberships: table_opt(opts, :memberships, CacheTables.memberships()),
      memberships_by_id: table_opt(opts, :memberships_by_id, CacheTables.memberships_by_id()),
      memberships_by_group:
        table_opt(opts, :memberships_by_group, CacheTables.memberships_by_group()),
      group_apps: table_opt(opts, :group_apps, CacheTables.group_apps()),
      entity_models: table_opt(opts, :entity_models, CacheTables.entity_models()),
      component_index: table_opt(opts, :component_index, default_component_index),
      component_entity_labels:
        table_opt(opts, :component_entity_labels, default_component_entity_labels),
      link_targets: table_opt(opts, :link_targets, default_link_targets),
      link_target_labels: table_opt(opts, :link_target_labels, default_link_target_labels)
    }
  end

  defp table_opt(opts, key, default), do: Keyword.get(opts, key) || default

  @impl true
  def init(opts) do
    # Trapping exits lets `terminate/2` stop the `Children` supervisor
    # synchronously. The escalation path kills SystemCache, and
    # `Storage.Supervisor` restarts it immediately; if the old cache
    # children (registered GenServers) were still alive, the restart
    # would fail with `already started` and eventually take down the
    # whole storage tree.
    Process.flag(:trap_exit, true)

    dirty_set_opts = Keyword.take(opts, [:dirty_set])
    group_cache_opts = Keyword.take(opts, [:table, :grants_by_id, :grants_by_group])

    membership_cache_opts =
      Keyword.take(opts, [:memberships, :memberships_by_id, :memberships_by_group])

    group_apps_cache_opts = Keyword.take(opts, [:group_apps])
    entity_model_cache_opts = Keyword.take(opts, [:entity_models])
    component_index_opts = Keyword.take(opts, [:component_index, :component_entity_labels])
    link_index_opts = Keyword.take(opts, [:link_targets, :link_target_labels])

    children = [
      {DirtyTracker, dirty_set_opts},
      {ComponentEntityIndex, component_index_opts},
      {GrantCache, group_cache_opts},
      {MembershipCache, membership_cache_opts},
      {GroupAppsCache, group_apps_cache_opts},
      {EntityModelCache, entity_model_cache_opts},
      {LinkTargetIndex, link_index_opts}
    ]

    case Supervisor.start_link(__MODULE__.Children, {:start_children, children}) do
      {:ok, sup_pid} ->
        try do
          gsn_counter = setup_gsn_counter(opts)
          :ok = populate_system_caches(Keyword.take(opts, @populate_opt_keys))

          {:ok, %{sup_pid: sup_pid, gsn_counter: gsn_counter}}
        catch
          kind, reason ->
            # A partial start must not serve reads: stop the children this
            # init started (init never reaches terminate/2 on failure) and
            # let the supervisor see a failed start.
            Logger.error(Exception.format(kind, reason, __STACKTRACE__))
            stop_children(sup_pid)
            {:stop, {:system_cache_init_failed, reason}}
        end

      {:error, reason} ->
        {:stop, reason}
    end
  end

  # The Writer escalates a post-commit cache failure with
  # `Process.exit(SystemCache, :cache_update_failed)`, and a `Children`
  # crash arrives the same way. Either way the caches are gone, so the
  # tree must rebuild.
  @impl true
  def handle_info({:EXIT, _pid, reason}, state) do
    {:stop, reason, state}
  end

  @impl true
  def terminate(_reason, state) do
    stop_children(state.sup_pid)
    :ok
  end

  # `Supervisor.stop/3` blocks until every cache child has terminated,
  # freeing their registered names and ETS tables before
  # `Storage.Supervisor` starts the replacement SystemCache.
  defp stop_children(sup_pid) do
    if Process.alive?(sup_pid) do
      try do
        Supervisor.stop(sup_pid, :shutdown, 5_000)
      catch
        :exit, reason ->
          Logger.error(
            "SystemCache stopped with cache children still running: #{inspect(reason)}"
          )

          :ok
      end
    end

    :ok
  end

  defmodule Children do
    @moduledoc false
    use Supervisor

    def init({:start_children, children}) do
      Supervisor.init(children, strategy: :one_for_all)
    end
  end

  defp setup_gsn_counter(opts) do
    counter =
      case Keyword.get(opts, :gsn_counter) do
        nil -> :atomics.new(1, signed: false)
        existing -> existing
      end

    case Keyword.get_lazy(opts, :initial_gsn, fn -> RocksDB.get_max_gsn() end) do
      n when n > 0 -> :atomics.put(counter, 1, n)
      _ -> :ok
    end

    counter
  end

  # Each phase counts its progress through a shared `:atomics` counter that
  # is read even when the phase raises, so a partial rebuild reports how far
  # it got before failing. Phases are ordered because the component index and
  # `entity_models` must be reconstructed from the log before the prefix walks
  # read them.
  defp populate_caches_from_indexes(rocks_name, tables, dirty_set, opts) do
    sqlite_opts = Keyword.take(opts, [:sqlite_name])

    with {:ok, _models, m1} <-
           phase(@empty_measurements, :entity_models, fn counter ->
             seed_component_entities(
               rocks_name,
               tables.entity_models,
               component_index_opts(tables),
               link_index_opts(tables),
               dirty_set,
               counter
             )
           end),
         {:ok, _grants, m2} <-
           phase(m1, :grants, fn counter ->
             populate_grants(rocks_name, tables, dirty_set, sqlite_opts, counter)
           end),
         {:ok, _memberships, m3} <-
           phase(m2, :memberships, fn counter ->
             populate_memberships(rocks_name, tables, dirty_set, sqlite_opts, counter)
           end),
         {:ok, _group_apps, m4} <-
           phase(m3, :group_apps, fn counter ->
             populate_group_apps(rocks_name, tables, dirty_set, sqlite_opts, counter)
           end) do
      {:ok, m4}
    else
      {:error, _measurements, _kind, _reason, _stacktrace} = error -> error
    end
  end

  defp component_index_opts(tables) do
    [
      component_index: tables.component_index,
      component_entity_labels: tables.component_entity_labels
    ]
  end

  defp link_index_opts(tables) do
    [
      link_targets: tables.link_targets,
      link_target_labels: tables.link_target_labels
    ]
  end

  defp phase(measurements, key, fun) do
    counter = :atomics.new(1, signed: false)

    try do
      value = fun.(counter)
      {:ok, value, Map.put(measurements, key, :atomics.get(counter, 1))}
    rescue
      e ->
        {:error, Map.put(measurements, key, :atomics.get(counter, 1)), :error, e, __STACKTRACE__}
    catch
      kind, reason ->
        {:error, Map.put(measurements, key, :atomics.get(counter, 1)), kind, reason,
         __STACKTRACE__}
    end
  end

  defp populate_grants(rocks_name, tables, dirty_set, sqlite_opts, counter) do
    populate_component(
      SystemComponent.component(:grant),
      rocks_name,
      dirty_set,
      &put_grant(&1, tables),
      component_index_opts(tables) ++ sqlite_opts,
      counter
    )
  end

  defp put_grant(entity_data, tables) do
    data = entity_data.data || %{}

    member = %{
      id: entity_data.id,
      actor_id: SystemComponent.path(data, :grant, "actor_id"),
      group_id: SystemComponent.path(data, :grant, "group_id"),
      permissions: SystemComponent.path(data, :grant, "permissions")
    }

    GrantCache.put_grant(member,
      grants: tables.grants,
      grants_by_id: tables.grants_by_id,
      grants_by_group: tables.grants_by_group
    )
  end

  defp populate_memberships(rocks_name, tables, dirty_set, sqlite_opts, counter) do
    populate_component(
      SystemComponent.component(:membership),
      rocks_name,
      dirty_set,
      &put_membership(&1, tables),
      component_index_opts(tables) ++ sqlite_opts,
      counter
    )
  end

  defp put_membership(entity_data, tables) do
    data = entity_data.data || %{}

    MembershipCache.put_membership(
      %{
        id: entity_data.id,
        entity_id: SystemComponent.path(data, :membership, "entity_id"),
        group_id: SystemComponent.path(data, :membership, "group_id")
      },
      memberships: tables.memberships,
      memberships_by_id: tables.memberships_by_id,
      memberships_by_group: tables.memberships_by_group
    )
  end

  # Entity reads otherwise materialize group rows lazily; the handshake
  # needs every group's app scope at boot, so the same type walk fills the
  # cache here instead of materializing a row per handshake.
  defp populate_group_apps(rocks_name, tables, dirty_set, sqlite_opts, counter) do
    populate_component(
      SystemComponent.component(:group),
      rocks_name,
      dirty_set,
      &put_group_apps(&1, tables),
      component_index_opts(tables) ++ sqlite_opts,
      counter
    )
  end

  defp put_group_apps(entity_data, tables) do
    data = entity_data.data || %{}

    GroupAppsCache.put_group_apps(
      entity_data.id,
      SystemComponent.group_apps(data),
      group_apps: tables.group_apps
    )
  end

  # The model `ebb` would project all three of its kinds into every cache.
  defp populate_component(component, rocks_name, dirty_set, insert_fn, opts, counter) do
    sqlite_name = Keyword.get(opts, :sqlite_name, EbbServer.Storage.SQLite)

    ComponentEntityIndex.each_component_entry_id(
      component,
      fn entity_id ->
        case EntityStore.materialize(
               entity_id,
               rocks_name: rocks_name,
               sqlite_name: sqlite_name,
               dirty_set: dirty_set
             ) do
          {:ok, entity} ->
            insert_fn.(entity)
            :atomics.add(counter, 1, 1)

          error ->
            Logger.warning("Failed to materialize entity #{entity_id}: #{inspect(error)}")
        end
      end,
      opts
    )
  end

  defp seed_component_entities(
         rocks_name,
         entity_models_table,
         index_opts,
         link_opts,
         dirty_set,
         counter
       ) do
    models =
      rocks_name
      |> action_log()
      |> Stream.chunk_every(@dirty_mark_chunk_size)
      |> Enum.reduce(%{}, fn chunk, models ->
        before = map_size(models)
        models = replay_actions(chunk, models, entity_models_table, index_opts, link_opts)
        :atomics.add(counter, 1, map_size(models) - before)
        models
      end)

    Enum.each(models, fn {entity_id, model} ->
      EntityModelCache.put_model(entity_id, model, entity_models: entity_models_table)
    end)

    mark_dirty_in_chunks(
      Enum.map(models, fn {entity_id, model} -> {entity_id, model} end),
      dirty_set
    )

    models
  end

  defp mark_dirty_in_chunks(marks, dirty_set) do
    marks
    |> Enum.chunk_every(@dirty_mark_chunk_size)
    |> Enum.each(&DirtyTracker.mark_dirty_batch(&1, dirty_set))
  end

  # Both derived indexes are rebuilt in the same pass, so one walk of the log
  # maintains them and each action's ops reach it in log order.
  defp replay_actions(actions, models, entity_models_table, index_opts, link_opts) do
    {models, {ops, link_ops}} =
      Enum.reduce(actions, {models, {[], []}}, fn action, {models, {ops, link_ops}} ->
        updates = Enum.map(action["updates"] || [], &RowMutations.from_stored/1)

        {models, action_ops} = replay_action(updates, models, entity_models_table)

        {models, {[action_ops | ops], [LinkTargetIndex.update_ops(updates) | link_ops]}}
      end)

    ComponentEntityIndex.apply_ops(ops |> Enum.reverse() |> :lists.append(), index_opts)
    LinkTargetIndex.apply_ops(link_ops |> Enum.reverse() |> :lists.append(), link_opts)
    models
  end

  # The replay carries the last model each id was committed under, so a delete
  # that names no component still writes the model entry. Model resolution is
  # the same fold the live Writer runs, against the models the log has named so
  # far, so boot and live agree on which row an `ebb/*` overlay belongs to.
  defp replay_action(updates, models, entity_models_table) do
    folded =
      RowMutations.fold(updates,
        model_resolver: fn subject_id ->
          Map.get(models, subject_id) ||
            EntityModelCache.get_model(subject_id, entity_models_table)
        end
      )

    models =
      Enum.reduce(folded, models, fn mutation, acc ->
        if mutation.model,
          do: Map.put(acc, mutation.subject_id, mutation.model),
          else: acc
      end)

    entries = Enum.map(folded, &{&1.model, &1.subject_id})

    {models, ComponentEntityIndex.action_ops(updates, entries)}
  end

  defp action_log(rocks_name) do
    rocks_name
    |> RocksDB.cf_actions()
    |> RocksDB.range_iterator(
      <<0::unsigned-big-integer-size(64)>>,
      <<0xFFFFFFFFFFFFFFFF::unsigned-big-integer-size(64)>>,
      name: rocks_name
    )
    |> Stream.map(fn {gsn_key, action_etf} ->
      ActionFormat.decode_payload(action_etf, RocksDB.decode_gsn_key(gsn_key))
    end)
  end

  defp emit_populate_telemetry(started, measurements, metadata) do
    duration = System.monotonic_time() - started

    Telemetry.execute(
      [:system_cache, :populated],
      Map.put(measurements, :duration, duration),
      metadata
    )
  end

  # Metadata must not carry entity content, and a raised exception or a
  # `GenServer.call` exit reason can embed the terms that triggered it.
  # Report only the failure class: the exception module, or the atom the
  # exit/throw carried.
  defp telemetry_reason(:error, reason) when is_exception(reason), do: reason.__struct__

  defp telemetry_reason(:exit, {{reason, _stacktrace}, {GenServer, :call, _args}})
       when is_exception(reason),
       do: reason.__struct__

  defp telemetry_reason(_kind, reason) when is_atom(reason), do: reason
  defp telemetry_reason(kind, _reason), do: kind
end
