defmodule EbbServer.TestHelpers do
  @moduledoc """
  Shared test helper functions and fixtures for EbbServer tests.

  ## Organization

  Helper functions are grouped by purpose:

  **Process Management**
  - `safe_stop/1` - Safely stop a GenServer
  - `tmp_dir/1` - Create isolated temporary directory with cleanup

  **Configuration**
  - `put_config/2` - Set an `:ebb_server` application-env key for one test and restore it on exit

  **Auth**
  - `put_actor/2` - Assign the actor `AuthPlug` would resolve, for suites that call a router directly

  **Storage Setup** (for unit tests)
  - `start_isolated_cache/0` - Create isolated ETS caches (DirtyTracker, GroupCache, EntityGroupCache, EntityTypeCache, RelationshipCache, WatermarkTracker, InFlightActions)
  - `start_rocks/1` - Start isolated RocksDB instance
  - `start_sqlite/1` - Start isolated SQLite instance
  - `start_writer/1` - Start isolated Writer instance
  - `create_isolated_tables/0` - Create isolated ETS tables for auth testing
  - `auth_opts/1` - Build auth context options from isolated tables

  **Data Fixtures**
  - `malformed_query_filters/0` - Filter shapes every query boundary must reject
  - `generate_hlc/0` - Generate current HLC timestamp
  - `hlc_from/2` - Build HLC from explicit time and counter
  - `sample_action/1` - Create sample action with string keys
  - `sample_update/1` - Create sample component update with string keys
  - `validated_action/1` - Create sample action with atom keys (post-validation format)
  - `validated_update/1` - Create sample component update with atom keys (post-validation format)
  - `validated_component/4` - Build one validated component update
  - `validated_row_updates/4` - Build one validated update per row field
  - `stored_update/1` - Project a validated update into its stored (string-keyed) form
  - `subject_scopes/1` - The scopes half of a stored frame for a set of updates

  **Telemetry**
  - `attach_telemetry/1` - Forward emitted `:telemetry` events to the test process
  - `telemetry_events/2` - Drain events forwarded for an attachment

  ## HLC Encoding

  HLC timestamps are 64-bit integers encoded as: `(logical_time_ms << 16) | counter`
  """

  import Bitwise
  import ExUnit.Callbacks

  alias EbbServer.Storage.{
    CacheTables,
    ComponentEntityIndex,
    DirtyTracker,
    EntityGroupCache,
    EntityTypeCache,
    GroupAppsCache,
    GroupCache,
    InFlightActions,
    RelationshipCache,
    RocksDB,
    SQLite,
    WatermarkTracker,
    Writer
  }

  @doc """
  Creates a unique temporary directory for the test and registers
  an `on_exit` callback to clean it up.

  Returns the path to the created directory.
  """
  def safe_stop(pid) when is_pid(pid) do
    if Process.alive?(pid) do
      try do
        GenServer.stop(pid, :normal, 5000)
      rescue
        _ -> :ok
      catch
        :exit, _ -> :ok
      end
    end

    :ok
  end

  @doc """
  Sets an `:ebb_server` application-env key for the current test and restores
  its previous value on exit. A key that was unset is deleted again.
  """
  def put_config(key, value) do
    previous = Application.get_env(:ebb_server, key)
    Application.put_env(:ebb_server, key, value)

    on_exit(fn ->
      case previous do
        nil -> Application.delete_env(:ebb_server, key)
        previous -> Application.put_env(:ebb_server, key, previous)
      end
    end)
  end

  @doc """
  Assigns the actor a bypass request would resolve, for a suite that calls a
  router directly instead of going through `AuthPlug`.

  Pass `nil` to assign no actor, which is how a service-token request reaches a
  router.
  """
  @spec put_actor(Plug.Conn.t(), String.t() | nil) :: Plug.Conn.t()
  def put_actor(conn, nil), do: Plug.Conn.assign(conn, :actor, nil)

  def put_actor(conn, actor_id) do
    Plug.Conn.assign(conn, :actor, EbbServer.Actor.new(:bypass, actor_id))
  end

  @doc """
  Attaches a telemetry handler that forwards every event in `events` to the
  calling test process.

  Returns a reference that tags each forwarded message so concurrent
  attachments can be told apart. Events arrive as:

      {:telemetry_event, ref, event_name, measurements, metadata}

  The handler is detached when the test exits. Use `telemetry_events/2` to
  drain the forwarded events.

  ## Example

      ref = attach_telemetry([[:ebb, :writer, :batch_size]])
      EbbServer.Telemetry.execute([:writer, :batch_size], %{count: 3}, %{})

      assert [{[:ebb, :writer, :batch_size], %{count: 3}, %{}}] =
               telemetry_events(ref)
  """
  def attach_telemetry(events) when is_list(events) do
    handler_id = {__MODULE__, :telemetry, System.unique_integer([:positive])}
    ref = make_ref()
    test_pid = self()

    :ok =
      :telemetry.attach_many(
        handler_id,
        events,
        fn event, measurements, metadata, _config ->
          send(test_pid, {:telemetry_event, ref, event, measurements, metadata})
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)

    ref
  end

  @doc """
  Drains telemetry events forwarded for `ref`, in emission order.

  Waits up to `timeout` ms for each event and returns `[]` once a wait
  elapses with nothing left to consume, so callers get the events emitted by
  a synchronous block without sleeping a fixed amount.
  """
  def telemetry_events(ref, timeout \\ 100) do
    receive do
      {:telemetry_event, ^ref, event, measurements, metadata} ->
        [{event, measurements, metadata} | telemetry_events(ref, timeout)]
    after
      timeout -> []
    end
  end

  def tmp_dir(%{module: module, test: test}) do
    dir =
      Path.join([
        System.tmp_dir!(),
        "ebb_server_test",
        "#{inspect(module)}_#{test}_#{System.unique_integer([:positive])}"
      ])

    File.mkdir_p!(dir)

    ExUnit.Callbacks.on_exit(fn ->
      :timer.sleep(50)
      File.rm_rf(dir)
      :ok
    end)

    dir
  end

  @doc """
  Creates isolated persistent storage and cache components for tests.

  Sets up unique DirtyTracker, GsnCounter, GroupCache, and RelationshipCache
  instances and registers cleanup callbacks.

  Returns a map with:
    - dirty_set: ETS set name for dirty tracking
    - gsn_counter: :atomics reference
    - group_members: ETS table name
    - group_members_by_id: ETS table name
    - group_members_by_group: ETS table name
    - entity_groups: ETS table name
    - entity_groups_by_id: ETS table name
    - entity_groups_by_group: ETS table name
    - entity_types: ETS table name
    - relationships: ETS table name
    - relationships_by_id: ETS table name
    - watermark_tracker: WatermarkTracker process name
    - in_flight_actions: InFlightActions process name
    - in_flight_table: ETS table name for the in-flight set
  """
  def start_isolated_cache do
    unique_id = System.unique_integer([:positive])
    dirty_set_name = :"ebb_dirty_#{unique_id}"
    gsn_counter_name = :"ebb_gsn_#{unique_id}"
    gm_table = :"ebb_gm_#{unique_id}"
    gm_by_id_table = :"ebb_gm_by_id_#{unique_id}"
    gm_by_group_table = :"ebb_gm_by_group_#{unique_id}"
    eg_table = :"ebb_eg_#{unique_id}"
    eg_by_id_table = :"ebb_eg_by_id_#{unique_id}"
    eg_by_group_table = :"ebb_eg_by_group_#{unique_id}"
    entity_types_table = :"ebb_entity_types_#{unique_id}"
    component_index_table = :"ebb_component_index_#{unique_id}"
    component_entity_labels_table = :"ebb_component_entity_labels_#{unique_id}"
    group_apps_table = :"ebb_group_apps_#{unique_id}"
    rel_table = :"ebb_rel_#{unique_id}"
    rbi_table = :"ebb_rbi_#{unique_id}"
    dt_name = :"dt_#{unique_id}"
    gc_name = :"gc_#{unique_id}"
    egc_name = :"egc_#{unique_id}"
    gac_name = :"gac_#{unique_id}"
    etc_name = :"etc_#{unique_id}"
    cei_name = :"cei_#{unique_id}"
    rc_name = :"rc_#{unique_id}"
    wt_name = :"wt_#{unique_id}"
    wt_table = :"wt_ranges_#{unique_id}"
    ifa_name = :"ifa_#{unique_id}"
    ifa_table = :"ifa_ids_#{unique_id}"

    counter = :atomics.new(1, signed: false)
    :persistent_term.put(gsn_counter_name, counter)
    :persistent_term.put({DirtyTracker, :dirty_set}, dirty_set_name)
    :persistent_term.put({GroupCache, :group_members}, gm_table)
    :persistent_term.put({GroupCache, :group_members_by_id}, gm_by_id_table)
    :persistent_term.put({GroupCache, :group_members_by_group}, gm_by_group_table)
    :persistent_term.put({EntityGroupCache, :entity_groups}, eg_table)
    :persistent_term.put({EntityGroupCache, :entity_groups_by_id}, eg_by_id_table)
    :persistent_term.put({EntityGroupCache, :entity_groups_by_group}, eg_by_group_table)
    :persistent_term.put({EntityTypeCache, :entity_types}, entity_types_table)
    :persistent_term.put({GroupAppsCache, :group_apps}, group_apps_table)
    :persistent_term.put({RelationshipCache, :relationships}, rel_table)
    :persistent_term.put({RelationshipCache, :relationships_by_id}, rbi_table)

    {:ok, _pid_dt} = DirtyTracker.start_link(name: dt_name, dirty_set: dirty_set_name)

    {:ok, _pid_gc} =
      GroupCache.start_link(
        name: gc_name,
        table: gm_table,
        group_members_by_id: gm_by_id_table,
        group_members_by_group: gm_by_group_table
      )

    {:ok, _pid_egc} =
      EntityGroupCache.start_link(
        name: egc_name,
        entity_groups: eg_table,
        entity_groups_by_id: eg_by_id_table,
        entity_groups_by_group: eg_by_group_table
      )

    {:ok, _pid_gac} = GroupAppsCache.start_link(name: gac_name, group_apps: group_apps_table)
    {:ok, _pid_etc} = EntityTypeCache.start_link(name: etc_name, entity_types: entity_types_table)

    {:ok, _pid_cei} =
      ComponentEntityIndex.start_link(
        name: cei_name,
        component_index: component_index_table,
        component_entity_labels: component_entity_labels_table
      )

    {:ok, _pid_rc} =
      RelationshipCache.start_link(
        name: rc_name,
        relationships: rel_table,
        relationships_by_id: rbi_table
      )

    {:ok, _pid_wt} = WatermarkTracker.start_link(name: wt_name, table: wt_table, initial_gsn: 0)

    {:ok, _pid_ifa} = InFlightActions.start_link(name: ifa_name, table: ifa_table)

    on_exit(fn ->
      for name <- [
            dt_name,
            gc_name,
            egc_name,
            gac_name,
            etc_name,
            cei_name,
            rc_name,
            wt_name,
            ifa_name
          ],
          pid = Process.whereis(name),
          do: safe_stop(pid)

      :persistent_term.erase(gsn_counter_name)
      :persistent_term.erase({DirtyTracker, :dirty_set})
      :persistent_term.erase({GroupCache, :group_members})
      :persistent_term.erase({GroupCache, :group_members_by_id})
      :persistent_term.erase({GroupCache, :group_members_by_group})
      :persistent_term.erase({EntityGroupCache, :entity_groups})
      :persistent_term.erase({EntityGroupCache, :entity_groups_by_id})
      :persistent_term.erase({EntityGroupCache, :entity_groups_by_group})
      :persistent_term.erase({EntityTypeCache, :entity_types})
      :persistent_term.erase({GroupAppsCache, :group_apps})
      :persistent_term.erase({ComponentEntityIndex, :tables})
      :persistent_term.erase({RelationshipCache, :relationships})
      :persistent_term.erase({ifa_name, :table})
    end)

    %{
      dirty_set: dirty_set_name,
      gsn_counter: counter,
      group_members: gm_table,
      group_members_by_id: gm_by_id_table,
      group_members_by_group: gm_by_group_table,
      entity_groups: eg_table,
      entity_groups_by_id: eg_by_id_table,
      entity_groups_by_group: eg_by_group_table,
      entity_types: entity_types_table,
      component_index: component_index_table,
      component_entity_labels: component_entity_labels_table,
      group_apps: group_apps_table,
      relationships: rel_table,
      relationships_by_id: rbi_table,
      watermark_tracker: wt_name,
      in_flight_actions: ifa_name,
      in_flight_table: ifa_table
    }
  end

  @doc """
  Starts an isolated RocksDB instance for testing.

  Creates a unique data directory and registers cleanup callbacks.

  Returns a map with:
    - name: RocksDB process name
    - pid: RocksDB process ID
    - dir: path to data directory
  """
  def start_rocks(context \\ %{}) do
    unique_id = System.unique_integer([:positive])
    dir = tmp_dir(Map.merge(%{module: __MODULE__, test: "rocks_#{unique_id}"}, context))
    name = :"rocks_#{unique_id}"
    {:ok, pid} = RocksDB.start_link(data_dir: dir, name: name)

    on_exit(fn ->
      safe_stop(pid)
      RocksDB.forget(name)
    end)

    %{name: name, pid: pid, dir: dir}
  end

  @doc """
  Starts an isolated SQLite instance for testing.

  Requires an existing RocksDB directory to share with.

  Returns a map with:
    - name: SQLite process name
    - pid: SQLite process ID
  """
  def start_sqlite(dir) do
    name = :"sqlite_#{System.unique_integer([:positive])}"
    {:ok, pid} = SQLite.start_link(data_dir: dir, name: name)

    on_exit(fn ->
      safe_stop(pid)
    end)

    %{name: name, pid: pid}
  end

  @doc """
  Starts an isolated Writer instance for testing.

  Requires the output from start_isolated_cache/0 and start_rocks/1.

  Returns a map with:
    - name: Writer process name
    - pid: Writer process ID
  """
  def start_writer(opts) when is_map(opts) do
    name = :"writer_#{System.unique_integer([:positive])}"

    # A half-initialized cache should surface as a setup-time error,
    # not a crash on the writer's first lookup.
    required_keys = [
      :rocks_name,
      :dirty_set,
      :gsn_counter,
      :group_members,
      :group_members_by_id,
      :entity_groups,
      :entity_groups_by_id,
      :entity_groups_by_group,
      :relationships,
      :relationships_by_id
    ]

    missing = Enum.reject(required_keys, fn key -> Map.get(opts, key) end)

    unless missing == [] do
      raise ArgumentError,
            "start_writer/1 missing required opts: #{inspect(missing)}. " <>
              "Get them from start_isolated_cache/0."
    end

    {default_component_index, default_component_entity_labels} =
      ComponentEntityIndex.tables()

    writer_opts =
      [
        name: name,
        rocks_name: opts.rocks_name,
        dirty_set: opts.dirty_set,
        gsn_counter: opts.gsn_counter,
        group_members: opts.group_members,
        group_members_by_id: opts.group_members_by_id,
        entity_groups: opts.entity_groups,
        entity_groups_by_id: opts.entity_groups_by_id,
        entity_groups_by_group: opts.entity_groups_by_group,
        entity_types: Map.get(opts, :entity_types) || CacheTables.entity_types(),
        component_index: Map.get(opts, :component_index) || default_component_index,
        component_entity_labels:
          Map.get(opts, :component_entity_labels) || default_component_entity_labels,
        group_apps: Map.get(opts, :group_apps) || CacheTables.group_apps(),
        relationships: opts.relationships,
        relationships_by_id: opts.relationships_by_id,
        watermark_tracker: opts[:watermark_tracker],
        in_flight_actions: opts[:in_flight_actions],
        fan_out_router: opts[:fan_out_router],
        commit_fn: opts[:commit_fn],
        after_commit: opts[:after_commit]
      ]
      |> put_if_present(:batch_max_size, opts[:batch_max_size])
      |> put_if_present(:batch_timeout_ms, opts[:batch_timeout_ms])
      |> put_if_present(:max_in_flight, opts[:max_in_flight])
      |> put_if_present(:committer_pool_size, opts[:committer_pool_size])
      |> put_if_present(:max_pending_calls, opts[:max_pending_calls])
      |> put_if_present(:prepare_pool_size, opts[:prepare_pool_size])
      |> put_if_present(:prepare_queue_max, opts[:prepare_queue_max])
      |> put_if_present(:prepare_timeout_ms, opts[:prepare_timeout_ms])
      |> put_if_present(:prepare_fn, opts[:prepare_fn])
      |> put_if_present(:commit_timeout_ms, opts[:commit_timeout_ms])
      |> put_if_present(:sweep_interval_ms, opts[:sweep_interval_ms])
      |> put_if_present(:ablate, opts[:ablate])

    {:ok, pid} = Writer.start_link(writer_opts)

    on_exit(fn ->
      safe_stop(pid)
    end)

    %{name: name, pid: pid}
  end

  @doc """
  Builds the Writer options map from a test context with flat cache keys.

  `ctx` is a context from `start_isolated_cache/0` merged with a `:rocks_name`
  from `start_rocks/1`; `extra` overrides individual options (for example a
  `:commit_fn` or `:fan_out_router`).
  """
  def writer_opts(ctx, extra) do
    base = %{
      rocks_name: ctx.rocks_name,
      dirty_set: ctx.dirty_set,
      gsn_counter: ctx.gsn_counter,
      group_members: ctx.group_members,
      group_members_by_id: ctx.group_members_by_id,
      entity_groups: ctx.entity_groups,
      entity_groups_by_id: ctx.entity_groups_by_id,
      entity_groups_by_group: ctx.entity_groups_by_group,
      group_apps: Map.get(ctx, :group_apps) || CacheTables.group_apps(),
      component_index: Map.get(ctx, :component_index),
      component_entity_labels: Map.get(ctx, :component_entity_labels),
      relationships: ctx.relationships,
      relationships_by_id: ctx.relationships_by_id,
      watermark_tracker: ctx.watermark_tracker,
      in_flight_actions: Map.get(ctx, :in_flight_actions)
    }

    Map.merge(base, extra)
  end

  @doc """
  Returns the number of messages queued in `pid`'s mailbox, or `0` if it is
  gone. Used to wait for calls to reach a suspended GenServer.
  """
  def queue_len(pid) do
    case Process.info(pid, :message_queue_len) do
      {:message_queue_len, n} -> n
      _ -> 0
    end
  end

  @doc """
  Polls `fun` until it returns truthy, for up to `attempts * 10ms`.
  """
  def wait_until(fun, attempts \\ 500) do
    cond do
      fun.() -> true
      attempts <= 0 -> false
      true -> Process.sleep(10) && wait_until(fun, attempts - 1)
    end
  end

  defp put_if_present(kw, _key, nil), do: kw
  defp put_if_present(kw, key, value), do: Keyword.put(kw, key, value)

  @doc """
  Creates isolated ETS tables for authorization testing.

  Creates unique group_members, group_members_by_id,
  group_members_by_group, entity_groups, entity_groups_by_id,
  entity_groups_by_group, relationships, and relationships_by_id
  tables and registers cleanup callbacks.

  Returns a map with:
    - group_members: ETS table name
    - group_members_by_id: ETS table name
    - group_members_by_group: ETS table name
    - entity_groups: ETS table name
    - entity_groups_by_id: ETS table name
    - entity_groups_by_group: ETS table name
    - relationships: ETS table name
    - relationships_by_id: ETS table name
  """
  def create_isolated_tables do
    uid = System.unique_integer([:positive])
    gm = :"test_gm_#{uid}"
    gm_by_id = :"test_gm_by_id_#{uid}"
    gm_by_group = :"test_gm_by_group_#{uid}"
    eg = :"test_eg_#{uid}"
    eg_by_id = :"test_eg_by_id_#{uid}"
    eg_by_group = :"test_eg_by_group_#{uid}"
    entity_types = :"test_entity_types_#{uid}"
    rel = :"test_rel_#{uid}"
    rbi = :"test_rbi_#{uid}"

    :ets.new(gm, [:bag, :public, :named_table])
    :ets.new(gm_by_id, [:set, :public, :named_table])
    :ets.new(gm_by_group, [:ordered_set, :public, :named_table])

    # Let EntityGroupCache own its table shapes so this helper can't
    # drift from the cache's init/1.
    EntityGroupCache.reset(
      entity_groups: eg,
      entity_groups_by_id: eg_by_id,
      entity_groups_by_group: eg_by_group
    )

    :ets.new(entity_types, [:set, :public, :named_table])
    :ets.new(rel, [:bag, :public, :named_table])
    :ets.new(rbi, [:set, :public, :named_table])

    on_exit(fn ->
      for t <- [gm, gm_by_id, gm_by_group, eg, eg_by_id, eg_by_group, entity_types, rel, rbi] do
        try do
          :ets.delete(t)
        rescue
          _ -> :ok
        end
      end
    end)

    %{
      group_members: gm,
      group_members_by_id: gm_by_id,
      group_members_by_group: gm_by_group,
      entity_groups: eg,
      entity_groups_by_id: eg_by_id,
      entity_groups_by_group: eg_by_group,
      entity_types: entity_types,
      relationships: rel,
      relationships_by_id: rbi
    }
  end

  @doc """
  Builds authorization context options from isolated tables.

  Returns keyword list suitable for passing to authorization functions.
  """
  def auth_opts(tables) do
    [
      group_members: tables.group_members,
      group_members_by_id: tables.group_members_by_id,
      group_members_by_group: tables.group_members_by_group,
      entity_groups: tables.entity_groups,
      entity_groups_by_id: tables.entity_groups_by_id,
      entity_types: tables.entity_types,
      relationships_by_id: tables.relationships_by_id
    ]
  end

  @doc """
  Filter shapes a query boundary must reject.

  Covers unsafe field names, non-map filters, non-scalar values, an integer
  SQLite cannot bind, and more keys than the filter cap allows.
  """
  def malformed_query_filters do
    too_many_keys =
      for i <- 1..(EbbServer.Storage.QueryFilter.max_keys() + 1),
          into: %{},
          do: {"field_#{i}", i}

    [
      [%{"a b" => "x"}],
      [nil],
      [1, 2],
      "zzz",
      %{"title" => "x"},
      [%{"title" => %{"n" => 1}}],
      [%{"title" => [1, 2]}],
      [%{"count" => 9_223_372_036_854_775_808}],
      [too_many_keys]
    ]
  end

  @doc """
  Generates a 64-bit HLC timestamp from the current wall clock time.

  The HLC is encoded as: (logical_time_ms << 16) | counter.
  For test helpers the counter is always 0 since we don't need to
  distinguish sub-millisecond events in most tests.

  To generate HLC values with specific values, use `hlc_from/2`.
  """
  def generate_hlc do
    Bitwise.bsl(System.os_time(:millisecond), 16)
  end

  @doc """
  Builds a 64-bit HLC from an explicit logical time (ms) and counter.

  Useful for tests that need deterministic HLC values or need to test
  tiebreaker behavior with equal logical times but different counters.

  ## Examples

      hlc_from(1_710_000_000_000, 0)  # logical time with counter 0
      hlc_from(1_710_000_000_000, 1)  # same ms, next event
  """
  def hlc_from(logical_time_ms, counter \\ 0) when counter >= 0 and counter <= 0xFFFF do
    Bitwise.bsl(logical_time_ms, 16) ||| counter
  end

  @doc """
  Returns a valid action map with string keys.

  Accepts an optional map of overrides that will be merged on top.
  """
  def sample_action(overrides \\ %{}) do
    Map.merge(
      %{
        "id" => "act_" <> Nanoid.generate(),
        "actor_id" => "a_test",
        "hlc" => generate_hlc(),
        "updates" => [sample_update()]
      },
      overrides
    )
  end

  @doc """
  Returns a valid component update map with string keys.

  One Update names one component, so the default writes `todo/title` with a
  `merge` of the component's own value. An override that sets `"method"` to
  `"delete"` drops the component and the data, because a delete names the row.
  """
  def sample_update(overrides \\ %{}) do
    hlc = generate_hlc()

    %{
      "id" => "upd_" <> Nanoid.generate(),
      "subject_id" => "todo_" <> Nanoid.generate(),
      "component" => "todo/title",
      "method" => "merge",
      "data" => %{"value" => "Buy milk", "hlc" => hlc}
    }
    |> Map.merge(overrides)
    |> normalize_wire_update()
  end

  defp normalize_wire_update(%{"method" => "delete"} = update) do
    update |> Map.delete("component") |> Map.put("data", nil)
  end

  defp normalize_wire_update(update), do: update

  @doc """
  Returns a valid action map with atom keys (validated_action format).
  Used for testing the Writer after PermissionChecker validation.

  Handles both atom and string keys in overrides for convenience.

  ## Examples

      validated_action()  # basic action with random IDs
      validated_action(%{id: "act_123", updates: [update]})  # with atom key overrides
      validated_action(%{"id" => "act_123", "hlc" => 123})  # with string key overrides
  """
  def validated_action(overrides \\ %{}) do
    hlc = generate_hlc()
    update = validated_update()

    base = %{
      id: "act_" <> Nanoid.generate(),
      actor_id: "a_test",
      hlc: hlc,
      updates: [update]
    }

    # Handle both atom and string keys
    result =
      Enum.reduce(overrides, base, fn
        {:id, v}, acc -> Map.put(acc, :id, v)
        {:actor_id, v}, acc -> Map.put(acc, :actor_id, v)
        {:hlc, v}, acc -> Map.put(acc, :hlc, v)
        {:updates, v}, acc -> Map.put(acc, :updates, v)
        {"id", v}, acc -> Map.put(acc, :id, v)
        {"actor_id", v}, acc -> Map.put(acc, :actor_id, v)
        {"hlc", v}, acc -> Map.put(acc, :hlc, v)
        {"updates", v}, acc -> Map.put(acc, :updates, v)
        # Skip other keys
        {_, _}, acc -> acc
      end)

    result
  end

  @update_keys [:id, :subject_id, :component, :method, :data]

  @doc """
  Returns a valid component update map with atom keys (validated format).
  Used for testing the Writer after PermissionChecker validation.

  Handles both atom and string keys in overrides for convenience. `model` and
  `field` are derived from the component, so an override only sets the
  component; a `:delete` override drops it.

  ## Examples

      validated_update()  # basic update with random IDs
      validated_update(%{subject_id: "todo_123", method: :replace})
      validated_update(%{component: "note/body", method: :merge, data: leaf})
  """
  def validated_update(overrides \\ %{}) do
    hlc = generate_hlc()

    base = %{
      id: "upd_" <> Nanoid.generate(),
      subject_id: "todo_" <> Nanoid.generate(),
      component: "todo/title",
      model: "todo",
      field: "title",
      method: :merge,
      data: %{"value" => "Buy milk", "hlc" => hlc}
    }

    @update_keys
    |> Enum.reduce(base, fn key, acc ->
      case fetch_override(overrides, key) do
        {:ok, value} -> Map.put(acc, key, value)
        :error -> acc
      end
    end)
    |> normalize_method()
    |> derive_component()
  end

  defp normalize_method(%{method: method} = update) when is_binary(method) do
    %{update | method: String.to_existing_atom(method)}
  end

  defp normalize_method(update), do: update

  defp fetch_override(overrides, key) do
    case Map.fetch(overrides, key) do
      {:ok, value} -> {:ok, value}
      :error -> Map.fetch(overrides, Atom.to_string(key))
    end
  end

  defp derive_component(%{method: :delete} = update) do
    %{update | component: nil, model: nil, field: nil, data: nil}
  end

  defp derive_component(%{component: component} = update) when is_binary(component) do
    [model, field] = :binary.split(component, "/")
    %{update | model: model, field: field}
  end

  defp derive_component(update), do: update

  @doc """
  Builds one validated component update.
  """
  def validated_component(subject_id, component, data, opts \\ []) do
    validated_update(%{
      id: Keyword.get(opts, :id, "upd_" <> Nanoid.generate()),
      subject_id: subject_id,
      component: component,
      method: Keyword.get(opts, :method, :replace),
      data: data
    })
  end

  @doc """
  Builds one validated update per field of a row.

  `fields` is `%{field => component value}`. The default method is `:replace`
  (a create writes one `replace` per leaf component); pass `method: :merge`
  for a leaf patch, or for a keyed component, whose create must merge.
  """
  def validated_row_updates(subject_id, model, fields, opts \\ []) do
    method = Keyword.get(opts, :method, :replace)

    component_opts =
      case Keyword.fetch(opts, :id) do
        {:ok, id} -> [method: method, id: id]
        :error -> [method: method]
      end

    Enum.map(fields, fn {field, value} ->
      validated_component(subject_id, "#{model}/#{field}", value, component_opts)
    end)
  end

  @doc """
  Projects a validated update into its stored, string-keyed form.
  """
  def stored_update(update) do
    %{
      "id" => update.id,
      "subject_id" => update.subject_id,
      "method" => Atom.to_string(update.method),
      "data" => update.data
    }
    |> then(fn stored ->
      if update.component, do: Map.put(stored, "component", update.component), else: stored
    end)
  end

  @doc """
  The scopes half of a stored frame for `updates`: one `{subject_id, []}` entry
  per distinct subject, in first-appearance order, as the Writer builds it.

  An empty group list is the honest fixture for a test that does not exercise
  delivery: these frames are read back, not fanned out.
  """
  def subject_scopes(updates) do
    updates
    |> Enum.map(&{&1.subject_id, []})
    |> Enum.uniq()
  end
end
