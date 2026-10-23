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
    - `EntityTypeCache`   — entity id → `subject_type`; the authorizer resolves an existing
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

  On init, the supervisor populates `GroupCache`, `EntityGroupCache` and
  `RelationshipCache` from the system entities in RocksDB before returning. The
  same `cf_type_entities` walk re-marks every indexed row dirty; dirty marks
  are in-memory and would otherwise be lost on a restart, leaving patch-only
  rows clean-but-stale and never-materialized rows missing (#564). The eager
  system-type populators clear their marks by materializing; `group` and user
  types stay marked until their first read. The outer `Storage.Supervisor`
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
    `EntityStore` materializer and its `cf_entity_actions` scan; #575 is
    still deciding that index's shape, so this fix deliberately adds no
    second reconcile source. The horizon is the row's `last_gsn`; #123
    owns how far the log retains the deltas.
  - **Fail loud, never half-populated.** A raise during population
    propagates out of `init/1`; there is no rescue that turns a partial
    rebuild into a healthy-looking cache. The Writer then cannot serve
    reads derived from a diverged cache.
  - **One-time type-entities backfill.** The `cf_actions` walk that
    repairs `cf_type_entities` is a migration, not a per-boot step: a
    successful run writes a durable marker in the default column family
    and later boots skip the scan (which is O(all Updates) and a memory
    cliff for the append-only log).

  ## Child start arguments

  All child modules accept optional keyword arguments to override default ETS table names:
  - `:dirty_set` - defaults to `:ebb_dirty_set`
  - `:table` (GroupCache) - defaults to `:ebb_group_members`
  - `:group_members_by_group` (GroupCache) - defaults to `:ebb_group_members_by_group`
  - `:entity_groups` - defaults to `:ebb_entity_groups`
  - `:entity_groups_by_id` - defaults to `:ebb_entity_groups_by_id`
  - `:entity_groups_by_group` - defaults to `:ebb_entity_groups_by_group`
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
    DirtyTracker,
    EntityGroupCache,
    EntityStore,
    EntityTypeCache,
    Fields,
    GroupCache,
    RelationshipCache,
    RocksDB
  }

  alias EbbServer.Telemetry

  @default_gsn_counter_name :ebb_gsn_counter

  # Durable marker written once a full type-entities backfill has
  # completed, in the default column family so the migration adds no
  # column family and an older binary can still open the database. Its
  # presence is what makes later boots skip the action-log scan; the value
  # is the migration version, so bumping it forces the backfill to run
  # again.
  @type_entities_backfill_marker "system_cache:type_entities_backfill"
  @type_entities_backfill_version "v1"

  # Boot re-marking writes one mark per indexed entity, so the batches are
  # bounded to keep a large index from ever being collected into one list.
  @dirty_mark_chunk_size 1_000

  @empty_measurements %{
    entity_types: 0,
    group_members: 0,
    entity_groups: 0,
    relationships: 0,
    backfilled: 0
  }

  @populate_opt_keys [
    :rocks_name,
    :table,
    :relationships,
    :relationships_by_id,
    :entity_groups,
    :entity_groups_by_id,
    :entity_groups_by_group,
    :entity_types
  ]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Public entry point for the startup cache-rebuild flow, and what
  `init/1` runs. It fills `EntityTypeCache` from `cf_type_entities`,
  runs the one-time `cf_type_entities` backfill if this database has
  never completed it, then materializes every system entity into
  `GroupCache`, `EntityGroupCache` and `RelationshipCache`.

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
    gm_table = Keyword.get(opts, :table) || CacheTables.group_members()

    rel_table =
      Keyword.get(opts, :relationships) || CacheTables.relationships()

    rbi_table =
      Keyword.get(opts, :relationships_by_id) || CacheTables.relationships_by_id()

    eg_table =
      Keyword.get(opts, :entity_groups) || CacheTables.entity_groups()

    egbid_table =
      Keyword.get(opts, :entity_groups_by_id) || CacheTables.entity_groups_by_id()

    egbg_table =
      Keyword.get(opts, :entity_groups_by_group) || CacheTables.entity_groups_by_group()

    entity_types_table =
      Keyword.get(opts, :entity_types) || CacheTables.entity_types()

    dirty_set = Keyword.get(opts, :dirty_set) || DirtyTracker.dirty_set_name()

    tables = %{
      group_members: gm_table,
      relationships: rel_table,
      relationships_by_id: rbi_table,
      entity_groups: eg_table,
      entity_groups_by_id: egbid_table,
      entity_groups_by_group: egbg_table,
      entity_types: entity_types_table
    }

    populate_caches_from_indexes(rocks_name, tables, dirty_set, opts)
  rescue
    e -> {:error, @empty_measurements, :error, e, __STACKTRACE__}
  catch
    kind, reason -> {:error, @empty_measurements, kind, reason, __STACKTRACE__}
  end

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

    entity_type_cache_opts = Keyword.take(opts, [:entity_types])

    children = [
      {DirtyTracker, dirty_set_opts},
      {GroupCache, group_cache_opts},
      {EntityGroupCache, entity_group_cache_opts},
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
  # it got before failing. Phases are ordered because `entity_types` must
  # finish (and, on a first boot, backfill must run) before the prefix walks
  # read the index.
  defp populate_caches_from_indexes(rocks_name, tables, dirty_set, opts) do
    sqlite_opts = Keyword.take(opts, [:sqlite_name])
    backfilled? = type_entities_backfilled?(rocks_name)

    with {:ok, existing_keys, m1} <-
           phase(@empty_measurements, :entity_types, fn counter ->
             populate_entity_types(
               rocks_name,
               tables.entity_types,
               not backfilled?,
               dirty_set,
               counter
             )
           end),
         {:ok, _backfilled, m2} <-
           phase(m1, :backfilled, fn counter ->
             maybe_backfill_type_entities(
               backfilled?,
               rocks_name,
               tables.entity_types,
               existing_keys,
               dirty_set,
               counter
             )
           end),
         {:ok, _group_members, m3} <-
           phase(m2, :group_members, fn counter ->
             populate_group_members(rocks_name, tables, dirty_set, sqlite_opts, counter)
           end),
         {:ok, _entity_groups, m4} <-
           phase(m3, :entity_groups, fn counter ->
             populate_entity_groups(rocks_name, tables, dirty_set, sqlite_opts, counter)
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

  defp maybe_backfill_type_entities(
         true,
         _rocks_name,
         _entity_types_table,
         _existing_keys,
         _dirty_set,
         _counter
       ),
       do: :ok

  defp maybe_backfill_type_entities(
         false,
         rocks_name,
         entity_types_table,
         existing_keys,
         dirty_set,
         counter
       ) do
    count = backfill_type_entities(rocks_name, entity_types_table, existing_keys, dirty_set)
    :atomics.add(counter, 1, count)
    mark_type_entities_backfilled(rocks_name)
    :ok
  end

  defp populate_group_members(rocks_name, tables, dirty_set, sqlite_opts, counter) do
    populate_type(
      "groupMember",
      rocks_name,
      dirty_set,
      &put_group_member(&1, tables.group_members),
      sqlite_opts,
      counter
    )
  end

  defp put_group_member(entity_data, table) do
    data = entity_data.data || %{}

    member = %{
      id: entity_data.id,
      actor_id: Fields.get(data, "actor_id"),
      group_id: Fields.get(data, "group_id"),
      permissions: Fields.get(data, "permissions")
    }

    GroupCache.put_group_member(member, table)
  end

  defp populate_entity_groups(rocks_name, tables, dirty_set, sqlite_opts, counter) do
    populate_type(
      "entityGroup",
      rocks_name,
      dirty_set,
      &put_entity_group(&1, tables),
      sqlite_opts,
      counter
    )
  end

  defp put_entity_group(entity_data, tables) do
    data = entity_data.data || %{}

    EntityGroupCache.put_entity_group(
      %{
        id: entity_data.id,
        entity_id: Fields.get(data, "entity_id"),
        group_id: Fields.get(data, "group_id")
      },
      entity_groups: tables.entity_groups,
      entity_groups_by_id: tables.entity_groups_by_id,
      entity_groups_by_group: tables.entity_groups_by_group
    )
  end

  defp populate_relationships(rocks_name, tables, dirty_set, sqlite_opts, counter) do
    populate_type(
      "relationship",
      rocks_name,
      dirty_set,
      &put_relationship(&1, tables),
      sqlite_opts,
      counter
    )
  end

  defp put_relationship(entity_data, tables) do
    data = entity_data.data || %{}

    RelationshipCache.put_relationship(
      %{
        id: entity_data.id,
        source_id: Fields.get(data, "source_id"),
        target_id: Fields.get(data, "target_id"),
        type: Fields.get(data, "type"),
        field: Fields.get(data, "field")
      },
      relationships: tables.relationships,
      relationships_by_id: tables.relationships_by_id
    )
  end

  defp populate_type(type, rocks_name, dirty_set, insert_fn, opts, counter) do
    prefix = type <> <<0>>
    cf = RocksDB.cf_type_entities(rocks_name)
    sqlite_name = Keyword.get(opts, :sqlite_name, EbbServer.Storage.SQLite)

    cf
    |> RocksDB.prefix_iterator(prefix, name: rocks_name)
    |> Enum.each(fn {key, _value} ->
      <<_type_bytes::binary-size(byte_size(type)), 0, entity_id::binary>> = key

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
    end)
  end

  # The authorizer resolves an existing entity's type for membership
  # permissions, so every `cf_type_entities` pair must be in ETS before
  # the first write is authorized. When a full backfill is still pending
  # the same walk also collects the keys it must diff against, so the
  # migration pays for one `cf_type_entities` walk rather than two.
  #
  # The walk also re-marks every pair dirty: marks are ETS-only, so without
  # this a restart leaves a row clean-but-stale or missing (#564). Eager types
  # are marked too; their populators run next and clear the marks by
  # materializing, so a surviving mark is a genuine repair candidate.
  defp populate_entity_types(rocks_name, table, collect_existing?, dirty_set, counter) do
    rocks_name
    |> RocksDB.cf_type_entities()
    |> RocksDB.full_iterator(name: rocks_name)
    |> Stream.chunk_every(@dirty_mark_chunk_size)
    |> Enum.reduce(if(collect_existing?, do: MapSet.new()), fn chunk, existing_keys ->
      {existing_keys, marks} = index_and_collect_marks(chunk, table, existing_keys, counter)
      if marks != [], do: DirtyTracker.mark_dirty_batch(marks, dirty_set)
      existing_keys
    end)
  end

  defp index_and_collect_marks(chunk, table, existing_keys, counter) do
    Enum.reduce(chunk, {existing_keys, []}, fn {key, _value}, {keys, marks} ->
      case :binary.split(key, <<0>>) do
        [type, entity_id] ->
          EntityTypeCache.put_type(entity_id, type, entity_types: table)
          :atomics.add(counter, 1, 1)
          {put_existing_key(keys, key), [{entity_id, type} | marks]}

        _ ->
          {keys, marks}
      end
    end)
  end

  # One generation per chunk. The boundary only bounds the batch built for a
  # large backfill; the walk above is already chunked.
  defp mark_dirty_in_chunks(marks, dirty_set) do
    marks
    |> Enum.chunk_every(@dirty_mark_chunk_size)
    |> Enum.each(&DirtyTracker.mark_dirty_batch(&1, dirty_set))
  end

  defp put_existing_key(nil, _key), do: nil
  defp put_existing_key(%MapSet{} = keys, key), do: MapSet.put(keys, key)

  # Walk every action in `cf_actions` and ensure each (type, entity_id)
  # pair has an entry in `cf_type_entities`. Runs once per database: the
  # marker written on success makes later boots skip the O(all Updates)
  # scan. A raise here is deliberately not rescued — a half-backfilled
  # index must neither be marked complete nor served.
  defp backfill_type_entities(rocks_name, entity_types_table, existing_keys, dirty_set) do
    cf_actions = RocksDB.cf_actions(rocks_name)
    cf_type_entities = RocksDB.cf_type_entities(rocks_name)

    {marks, ops} =
      cf_actions
      |> RocksDB.range_iterator(
        <<0::unsigned-big-integer-size(64)>>,
        <<0xFFFFFFFFFFFFFFFF::unsigned-big-integer-size(64)>>,
        name: rocks_name
      )
      |> Stream.map(fn {gsn_key, action_etf} ->
        ActionFormat.decode(action_etf, RocksDB.decode_gsn_key(gsn_key))
      end)
      |> Stream.flat_map(fn action ->
        # Each update contributes at most one (type, entity_id) pair.
        # Tombstones (method == "delete") still imply a prior create,
        # so we index them too — the materialize path handles
        # deleted_hlc by returning :not_found and the cache populate
        # gracefully no-ops on those.
        action["updates"] || []
      end)
      |> Stream.map(fn update ->
        type = update["subject_type"]
        id = update["subject_id"]
        key = RocksDB.encode_type_entity_key(type, id)
        {key, type, id}
      end)
      |> Stream.filter(fn {key, _type, _id} -> not MapSet.member?(existing_keys, key) end)
      |> Stream.uniq_by(fn {key, _, _} -> key end)
      |> Enum.map(fn {key, type, id} ->
        EntityTypeCache.put_type(id, type, entity_types: entity_types_table)
        {{id, type}, {:put, cf_type_entities, key, <<>>}}
      end)
      |> Enum.unzip()

    case ops do
      [] ->
        0

      ops ->
        Logger.info("Backfilling #{length(ops)} missing cf_type_entities entries")

        case RocksDB.write_batch(ops, name: rocks_name) do
          :ok ->
            # The type walk above never saw these pairs, so without a mark the
            # migration boot would re-index the entity but still serve it as
            # missing until something wrote it again.
            mark_dirty_in_chunks(marks, dirty_set)
            length(ops)

          {:error, reason} ->
            raise "cf_type_entities backfill write failed: #{inspect(reason)}"
        end
    end
  end

  defp type_entities_backfilled?(rocks_name) do
    case RocksDB.get(
           RocksDB.cf_default(rocks_name),
           @type_entities_backfill_marker,
           name: rocks_name
         ) do
      {:ok, @type_entities_backfill_version} -> true
      _ -> false
    end
  end

  defp mark_type_entities_backfilled(rocks_name) do
    op =
      {:put, RocksDB.cf_default(rocks_name), @type_entities_backfill_marker,
       @type_entities_backfill_version}

    case RocksDB.write_batch([op], name: rocks_name) do
      :ok -> :ok
      {:error, reason} -> raise "default column family marker write failed: #{inspect(reason)}"
    end
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
