defmodule EbbServer.Storage.SystemCache do
  @moduledoc """
  Supervisor that owns the in-memory state used on the hot paths:
  permission checks, dirty entity tracking, entity/relationship
  membership, and the GSN counter. The watermark's resolution frontier
  lives in the sibling `WatermarkTracker`; the in-flight action-id guard
  that makes retries idempotent lives in the sibling `InFlightActions`.

  ## Why this exists

  A single Writer GenServer and a single SQLite connection wouldn't be
  a bottleneck for 1k writes/s, but `POST /sync/actions` is not the only
  reader — SSE fan-out reads GSN counters, `GET /entities/:id` hits
  permission checks, `GET /sync/groups/:gid` reads group membership.
  Putting all that state in ETS + `:atomics` lets the single Writer be
  the only serialized path (correctness) while everything else reads in
  parallel with no contention.

  ## Children

    - `DirtyTracker`      — the set of `entity_id`s whose materialized form is stale.
    - `GroupCache`        — per-group member sets; permission checks read this on every write.
    - `EntityGroupCache`  — entity → group membership; reaches in for fan-out and entity reads.
    - `GroupAppsCache`    — each group's app scope, projected for the handshake.
    - `EntityTypeCache`   — entity id → committed model; the authorizer resolves an existing
                            entity's type from here for membership permissions (#264).
    - `RelationshipCache` — domain relationship edges; reaches in for relationship resolution.

  `SystemCache` itself is a `GenServer` that owns these children under an
  inner `one_for_all` supervisor. It also creates the GSN counter — an
  `:atomics` reference stored in `:persistent_term`, not a process child —
  and repopulates the caches from RocksDB on `init/1`.

  `WatermarkTracker` and `InFlightActions` are *not* children here. They
  are siblings under `Storage.Supervisor`, started after `SystemCache` and
  before the Writer.

  ## Lifecycle

  On init, the supervisor rebuilds the derived component existence index
  from `cf_actions`, then populates `GroupCache`, `EntityGroupCache`,
  `GroupAppsCache` and `RelationshipCache` from the system entities before
  returning. The same pass re-marks every modeled row dirty; dirty marks are
  in-memory and would otherwise be lost on a restart, leaving patch-only rows
  clean-but-stale and never-materialized rows missing (#564). The eager
  system-type populators clear their marks by materializing; user types stay
  marked until their first read. The outer `Storage.Supervisor`
  uses `rest_for_one` so RocksDB is up before any cache child starts; the
  supervision tree blocks accepting connections until this returns. If
  population raises, `init/1` tears down the cache children and fails the
  start rather than reporting health over a half-populated cache.

  ## Load-bearing decisions

  - **Inner `one_for_all`, outer `rest_for_one`.** The cache children
    above share the same lifecycle: if one dies the `Children` supervisor
    restarts them all together against the live RocksDB. The *outer*
    `Storage.Supervisor` deliberately uses `rest_for_one` instead — a
    `SystemCache` failure must rebuild the caches, the watermark, and the
    Writer (which reconciles from the log), because a cache that diverged
    from RocksDB cannot be trusted to serve the write path.
  - **No message-passing API.** All read paths are pure ETS reads from
    `GenServer`-less modules; the GSN counter is an `:atomics` reference
    and `WatermarkTracker` / `InFlightActions` coordinate through their own
    ETS (plus `:atomics` for the frontier), so none of them adds mailbox
    traffic to the write path.
  - **Populate-on-startup only.** The caches are loaded once from RocksDB
    on `init/1` and then mutated in-memory by the Writer; they do not
    re-read from RocksDB on each access. The same boot walk marks every
    indexed entity dirty so a read after a restart still sees a mark and
    replays its delta instead of trusting a possibly-stale SQLite row.
  - **Boot re-mark, not a persisted dirty set.** The dirty set can hold
    every lazily materialized entity after a boot, but persisting it would
    add write amplification and wiping SQLite would lose the cache #421
    rebuilds. Re-marking on the walk that already fills the type cache
    costs no extra RocksDB scan. The replay source is the existing
    `EntityStore` materializer and its coalesced `cf_entity_actions` rows;
    this fix deliberately adds no second reconcile source. The horizon is the
    row's `last_gsn`; #123
    owns how far the log retains the deltas.
  - **Fail loud, never half-populated.** A raise during population
    propagates out of `init/1`; there is no rescue that turns a partial
    rebuild into a healthy-looking cache. The Writer then cannot serve
    reads derived from a diverged cache.
  - **The component index is rebuilt every boot.** It is derived state: the
    `cf_actions` walk is its constructor, not a migration, and there is no
    durable copy to reconcile against. The walk is O(all Updates) by design;
    #849 accepted that against the resident-set gate, and a checkpoint is the
    answer if boot becomes a measured problem.

  ## Child start arguments

  All child modules accept optional keyword arguments to override default ETS table names:
  - `:dirty_set` - defaults to `:ebb_dirty_set`
  - `:table` (GroupCache) - defaults to `:ebb_group_members`
  - `:group_members_by_group` (GroupCache) - defaults to `:ebb_group_members_by_group`
  - `:entity_groups` - defaults to `:ebb_entity_groups`
  - `:entity_groups_by_id` - defaults to `:ebb_entity_groups_by_id`
  - `:entity_groups_by_group` - defaults to `:ebb_entity_groups_by_group`
  - `:group_apps` - defaults to `:ebb_group_apps`
  - `:entity_types` - defaults to `:ebb_entity_types`
  - `:relationships` - defaults to `:ebb_relationships`
  - `:relationships_by_id` - defaults to `:ebb_relationships_by_id`

  ## Example

      SystemCache.start_link([])
  """

  use GenServer

  require Logger

  alias EbbServer.Storage.{
    ActionFormat,
    CacheTables,
    ComponentEntityIndex,
    DirtyTracker,
    EntityGroupCache,
    EntityStore,
    EntityTypeCache,
    GroupAppsCache,
    GroupCache,
    RelationshipCache,
    RocksDB,
    RowMutations,
    SystemComponent
  }

  alias EbbServer.Telemetry

  @default_gsn_counter_name :ebb_gsn_counter

  # Boot re-marking writes one mark per indexed entity, so the batches are
  # bounded to keep a large index from ever being collected into one list.
  @dirty_mark_chunk_size 1_000

  @empty_measurements %{
    entity_types: 0,
    group_members: 0,
    entity_groups: 0,
    group_apps: 0,
    relationships: 0
  }

  @populate_opt_keys [
    :rocks_name,
    :table,
    :group_members_by_id,
    :group_members_by_group,
    :relationships,
    :relationships_by_id,
    :entity_groups,
    :entity_groups_by_id,
    :entity_groups_by_group,
    :group_apps,
    :entity_types,
    :component_index,
    :component_entity_labels
  ]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Public entry point for the startup cache-rebuild flow, and what
  `init/1` runs. It rebuilds the derived component index and `EntityTypeCache`
  from `cf_actions`, then materializes every system entity into `GroupCache`,
  `EntityGroupCache`, `GroupAppsCache` and `RelationshipCache`.

  Emits `[:ebb, :system_cache, :populated]` with per-cache counts and a
  native `duration`, and metadata `outcome` (`:ok` or `:error`). On a
  failed rebuild the counts reached so far are included, so a partially
  populated cache is observable before the raise propagates.

  Accepts the same keyword options as `init/1` (`:rocks_name`,
  `:table`, `:relationships`, `:relationships_by_id`,
  `:sqlite_name`) so callers can drive the rebuild against isolated
  stores without relying on global `:persistent_term` state.
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

    %{
      group_members: table_opt(opts, :table, CacheTables.group_members()),
      group_members_by_id:
        table_opt(opts, :group_members_by_id, CacheTables.group_members_by_id()),
      group_members_by_group:
        table_opt(opts, :group_members_by_group, CacheTables.group_members_by_group()),
      relationships: table_opt(opts, :relationships, CacheTables.relationships()),
      relationships_by_id:
        table_opt(opts, :relationships_by_id, CacheTables.relationships_by_id()),
      entity_groups: table_opt(opts, :entity_groups, CacheTables.entity_groups()),
      entity_groups_by_id:
        table_opt(opts, :entity_groups_by_id, CacheTables.entity_groups_by_id()),
      entity_groups_by_group:
        table_opt(opts, :entity_groups_by_group, CacheTables.entity_groups_by_group()),
      group_apps: table_opt(opts, :group_apps, CacheTables.group_apps()),
      entity_types: table_opt(opts, :entity_types, CacheTables.entity_types()),
      component_index: table_opt(opts, :component_index, default_component_index),
      component_entity_labels:
        table_opt(opts, :component_entity_labels, default_component_entity_labels)
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

    gsn_counter_name = Keyword.get(opts, :gsn_counter_name, @default_gsn_counter_name)

    dirty_set_opts = Keyword.take(opts, [:dirty_set])
    group_cache_opts = Keyword.take(opts, [:table, :group_members_by_id, :group_members_by_group])

    rel_cache_opts = Keyword.take(opts, [:relationships, :relationships_by_id])

    entity_group_cache_opts =
      Keyword.take(opts, [:entity_groups, :entity_groups_by_id, :entity_groups_by_group])

    group_apps_cache_opts = Keyword.take(opts, [:group_apps])
    entity_type_cache_opts = Keyword.take(opts, [:entity_types])
    component_index_opts = Keyword.take(opts, [:component_index, :component_entity_labels])

    children = [
      {DirtyTracker, dirty_set_opts},
      {ComponentEntityIndex, component_index_opts},
      {GroupCache, group_cache_opts},
      {EntityGroupCache, entity_group_cache_opts},
      {GroupAppsCache, group_apps_cache_opts},
      {EntityTypeCache, entity_type_cache_opts},
      {RelationshipCache, rel_cache_opts}
    ]

    case Supervisor.start_link(__MODULE__.Children, {:start_children, children}) do
      {:ok, sup_pid} ->
        try do
          gsn_counter = setup_gsn_counter(opts, gsn_counter_name)
          :ok = populate_system_caches(Keyword.take(opts, @populate_opt_keys))

          {:ok, %{sup_pid: sup_pid, gsn_counter: gsn_counter, gsn_counter_name: gsn_counter_name}}
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

  defp setup_gsn_counter(opts, gsn_counter_name) do
    counter =
      case Keyword.get(opts, :gsn_counter) do
        nil -> :atomics.new(1, signed: false)
        existing -> existing
      end

    :persistent_term.put(gsn_counter_name, counter)

    case Keyword.get_lazy(opts, :initial_gsn, fn -> RocksDB.get_max_gsn() end) do
      n when n > 0 -> :atomics.put(counter, 1, n)
      _ -> :ok
    end

    counter
  end

  # Each phase counts its progress through a shared `:atomics` counter that
  # is read even when the phase raises, so a partial rebuild reports how far
  # it got before failing. Phases are ordered because the component index and
  # `entity_types` must be reconstructed from the log before the prefix walks
  # read them.
  defp populate_caches_from_indexes(rocks_name, tables, dirty_set, opts) do
    sqlite_opts = Keyword.take(opts, [:sqlite_name])

    with {:ok, _models, m1} <-
           phase(@empty_measurements, :entity_types, fn counter ->
             seed_component_entities(
               rocks_name,
               tables.entity_types,
               component_index_opts(tables),
               dirty_set,
               counter
             )
           end),
         {:ok, _group_members, m2} <-
           phase(m1, :group_members, fn counter ->
             populate_group_members(rocks_name, tables, dirty_set, sqlite_opts, counter)
           end),
         {:ok, _entity_groups, m3} <-
           phase(m2, :entity_groups, fn counter ->
             populate_entity_groups(rocks_name, tables, dirty_set, sqlite_opts, counter)
           end),
         {:ok, _group_apps, m4} <-
           phase(m3, :group_apps, fn counter ->
             populate_group_apps(rocks_name, tables, dirty_set, sqlite_opts, counter)
           end),
         {:ok, _relationships, m5} <-
           phase(m4, :relationships, fn counter ->
             populate_relationships(rocks_name, tables, dirty_set, sqlite_opts, counter)
           end) do
      {:ok, m5}
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

  defp populate_group_members(rocks_name, tables, dirty_set, sqlite_opts, counter) do
    populate_type(
      SystemComponent.component(:grant),
      rocks_name,
      dirty_set,
      &put_group_member(&1, tables),
      component_index_opts(tables) ++ sqlite_opts,
      counter
    )
  end

  defp put_group_member(entity_data, tables) do
    data = entity_data.data || %{}

    member = %{
      id: entity_data.id,
      actor_id: SystemComponent.path(data, :grant, "actor_id"),
      group_id: SystemComponent.path(data, :grant, "group_id"),
      permissions: SystemComponent.path(data, :grant, "permissions")
    }

    GroupCache.put_group_member(member,
      group_members: tables.group_members,
      group_members_by_id: tables.group_members_by_id,
      group_members_by_group: tables.group_members_by_group
    )
  end

  defp populate_entity_groups(rocks_name, tables, dirty_set, sqlite_opts, counter) do
    populate_type(
      SystemComponent.component(:membership),
      rocks_name,
      dirty_set,
      &put_entity_group(&1, tables),
      component_index_opts(tables) ++ sqlite_opts,
      counter
    )
  end

  defp put_entity_group(entity_data, tables) do
    data = entity_data.data || %{}

    EntityGroupCache.put_entity_group(
      %{
        id: entity_data.id,
        entity_id: SystemComponent.path(data, :membership, "entity_id"),
        group_id: SystemComponent.path(data, :membership, "group_id")
      },
      entity_groups: tables.entity_groups,
      entity_groups_by_id: tables.entity_groups_by_id,
      entity_groups_by_group: tables.entity_groups_by_group
    )
  end

  # Entity reads otherwise materialize group rows lazily; the handshake
  # needs every group's app scope at boot, so the same type walk fills the
  # cache here instead of materializing a row per handshake.
  defp populate_group_apps(rocks_name, tables, dirty_set, sqlite_opts, counter) do
    populate_type(
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

  defp populate_relationships(rocks_name, tables, dirty_set, sqlite_opts, counter) do
    populate_type(
      SystemComponent.component(:link),
      rocks_name,
      dirty_set,
      &put_relationship(&1, tables),
      component_index_opts(tables) ++ sqlite_opts,
      counter
    )
  end

  defp put_relationship(entity_data, tables) do
    data = entity_data.data || %{}

    RelationshipCache.put_relationship(
      %{
        id: entity_data.id,
        source_id: SystemComponent.path(data, :link, "source_id"),
        target_id: SystemComponent.path(data, :link, "target_id"),
        type: SystemComponent.path(data, :link, "type"),
        field: SystemComponent.path(data, :link, "field")
      },
      relationships: tables.relationships,
      relationships_by_id: tables.relationships_by_id
    )
  end

  # Each phase selects the **component** label, not the `ebb` model label:
  # every platform row commits under one model, so a model selector would
  # project all four kinds into every cache.
  defp populate_type(component, rocks_name, dirty_set, insert_fn, opts, counter) do
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

  # The index is derived state: rebuild both key kinds from the action log on
  # every boot, in GSN order, with the Writer's own rules. Applying each
  # Action's ops directly keeps the last write per key without holding a
  # second full copy of the index; the log is the source of truth, so this is
  # construction, not a migration.
  #
  # The same pass fills `EntityTypeCache` from the model entries the authorizer
  # resolves, and collects every modeled id so the boot re-mark can dirty it.
  # Marks are ETS-only, so without this a restart leaves a row clean-but-stale
  # or missing (#564). Eager models are marked too; their populators run next
  # and clear the marks by materializing, so a surviving mark is a genuine
  # repair candidate.
  defp seed_component_entities(
         rocks_name,
         entity_types_table,
         index_opts,
         dirty_set,
         counter
       ) do
    models =
      rocks_name
      |> action_log()
      |> Stream.chunk_every(@dirty_mark_chunk_size)
      |> Enum.reduce(%{}, fn chunk, models ->
        before = map_size(models)
        models = replay_actions(chunk, models, entity_types_table, index_opts)
        :atomics.add(counter, 1, map_size(models) - before)
        models
      end)

    Enum.each(models, fn {entity_id, model} ->
      EntityTypeCache.put_type(entity_id, model, entity_types: entity_types_table)
    end)

    mark_dirty_in_chunks(
      Enum.map(models, fn {entity_id, model} -> {entity_id, model} end),
      dirty_set
    )

    models
  end

  # One generation per chunk. The boundary only bounds the batch applied to
  # the index and the dirty marks it implies.
  defp mark_dirty_in_chunks(marks, dirty_set) do
    marks
    |> Enum.chunk_every(@dirty_mark_chunk_size)
    |> Enum.each(&DirtyTracker.mark_dirty_batch(&1, dirty_set))
  end

  defp replay_actions(actions, models, entity_types_table, index_opts) do
    {models, ops} =
      Enum.reduce(actions, {models, []}, fn action, {models, acc} ->
        {models, action_ops} = replay_action(action["updates"] || [], models, entity_types_table)
        {models, [action_ops | acc]}
      end)

    ComponentEntityIndex.apply_ops(ops |> Enum.reverse() |> :lists.append(), index_opts)
    models
  end

  # The replay carries the last model each id was committed under, so a delete
  # that names no component still writes the model entry. An id the log never
  # modeled falls back to a record already in `EntityTypeCache`; an id nothing
  # knows has no entry to rebuild.
  #
  # A platform component's prefix is the model `ebb`, which is the committed
  # model of every platform row: a user row cannot carry one (`ActionValidator`
  # refuses two component prefixes on one subject), so the prefix is never a
  # relabel here.
  defp replay_action(raw_updates, models, entity_types_table) do
    updates = Enum.map(raw_updates, &RowMutations.from_stored/1)

    models =
      Enum.reduce(updates, models, fn update, models ->
        model =
          update.model || Map.get(models, update.subject_id) ||
            EntityTypeCache.get_type(update.subject_id, entity_types_table)

        if model, do: Map.put(models, update.subject_id, model), else: models
      end)

    folded =
      updates
      |> Enum.map(& &1.subject_id)
      |> Enum.uniq()
      |> Enum.map(&{Map.get(models, &1), &1})

    {models, ComponentEntityIndex.action_ops(updates, folded)}
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
      # The seed only needs the Updates, so it decodes the payload half of the
      # frame and skips the delivery scopes.
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
