defmodule EbbServer.TestHelpers do
  @moduledoc """
  Shared test helper functions and fixtures for EbbServer tests.

  ## Organization

  Helper functions are grouped by purpose:

  **Process Management**
  - `safe_stop/1` - Safely stop a GenServer
  - `tmp_dir/1` - Create isolated temporary directory with cleanup

  **Storage Setup** (for unit tests)
  - `start_isolated_cache/0` - Create isolated ETS caches (DirtyTracker, GroupCache, RelationshipCache)
  - `start_rocks/1` - Start isolated RocksDB instance
  - `start_sqlite/1` - Start isolated SQLite instance
  - `start_writer/1` - Start isolated Writer instance
  - `create_isolated_tables/0` - Create isolated ETS tables for auth testing
  - `auth_opts/1` - Build auth context options from isolated tables

  **Data Fixtures**
  - `generate_hlc/0` - Generate current HLC timestamp
  - `hlc_from/2` - Build HLC from explicit time and counter
  - `sample_action/1` - Create sample action with string keys
  - `sample_update/1` - Create sample update with string keys
  - `validated_action/1` - Create sample action with atom keys (post-validation format)
  - `validated_update/1` - Create sample update with atom keys (post-validation format)

  ## HLC Encoding

  HLC timestamps are 64-bit integers encoded as: `(logical_time_ms << 16) | counter`
  """

  import Bitwise
  import ExUnit.Callbacks

  alias EbbServer.Storage.{
    DirtyTracker,
    GroupCache,
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
    - relationships: ETS table name
    - relationships_by_group: ETS table name
  """
  def start_isolated_cache do
    unique_id = System.unique_integer([:positive])
    dirty_set_name = :"ebb_dirty_#{unique_id}"
    gsn_counter_name = :"ebb_gsn_#{unique_id}"
    gm_table = :"ebb_gm_#{unique_id}"
    rel_table = :"ebb_rel_#{unique_id}"
    rbg_table = :"ebb_rbg_#{unique_id}"
    dt_name = :"dt_#{unique_id}"
    gc_name = :"gc_#{unique_id}"
    rc_name = :"rc_#{unique_id}"
    wt_name = :"wt_#{unique_id}"
    wt_table = :"wt_ranges_#{unique_id}"

    counter = :atomics.new(1, signed: false)
    :persistent_term.put(gsn_counter_name, counter)
    :persistent_term.put({DirtyTracker, :dirty_set}, dirty_set_name)
    :persistent_term.put({GroupCache, :group_members}, gm_table)
    :persistent_term.put({RelationshipCache, :relationships}, rel_table)
    :persistent_term.put({RelationshipCache, :relationships_by_group}, rbg_table)

    {:ok, _pid_dt} = DirtyTracker.start_link(name: dt_name, dirty_set: dirty_set_name)
    {:ok, _pid_gc} = GroupCache.start_link(name: gc_name, table: gm_table)

    {:ok, _pid_rc} =
      RelationshipCache.start_link(
        name: rc_name,
        relationships: rel_table,
        relationships_by_group: rbg_table
      )

    {:ok, _pid_wt} = WatermarkTracker.start_link(name: wt_name, table: wt_table, initial_gsn: 0)

    on_exit(fn ->
      for name <- [dt_name, gc_name, rc_name, wt_name],
          pid = Process.whereis(name),
          do: safe_stop(pid)

      :persistent_term.erase(gsn_counter_name)
      :persistent_term.erase({DirtyTracker, :dirty_set})
      :persistent_term.erase({GroupCache, :group_members})
      :persistent_term.erase({RelationshipCache, :relationships})
      :persistent_term.erase({RelationshipCache, :relationships_by_group})
    end)

    %{
      dirty_set: dirty_set_name,
      gsn_counter: counter,
      group_members: gm_table,
      relationships: rel_table,
      relationships_by_group: rbg_table,
      watermark_tracker: wt_name
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
      :persistent_term.erase({:ebb_rocksdb_db, name})
      :persistent_term.erase({:ebb_cf_actions, name})
      :persistent_term.erase({:ebb_cf_updates, name})
      :persistent_term.erase({:ebb_cf_entity_actions, name})
      :persistent_term.erase({:ebb_cf_type_entities, name})
      :persistent_term.erase({:ebb_cf_action_dedup, name})
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
  def start_writer(opts) do
    name = :"writer_#{System.unique_integer([:positive])}"

    {:ok, pid} =
      Writer.start_link(
        name: name,
        rocks_name: opts.rocks_name,
        dirty_set: opts.dirty_set,
        gsn_counter: opts.gsn_counter,
        group_members: opts[:group_members],
        relationships: opts[:relationships],
        relationships_by_group: opts[:relationships_by_group],
        watermark_tracker: opts[:watermark_tracker],
        fan_out_router: opts[:fan_out_router]
      )

    on_exit(fn ->
      safe_stop(pid)
    end)

    %{name: name, pid: pid}
  end

  @doc """
  Creates isolated ETS tables for authorization testing.

  Creates unique group_members, relationships, and relationships_by_group tables
  and registers cleanup callbacks.

  Returns a map with:
    - group_members: ETS table name
    - relationships: ETS table name
    - relationships_by_group: ETS table name
  """
  def create_isolated_tables do
    uid = System.unique_integer([:positive])
    gm = :"test_gm_#{uid}"
    rel = :"test_rel_#{uid}"
    rbg = :"test_rbg_#{uid}"

    :ets.new(gm, [:bag, :public, :named_table])
    :ets.new(rel, [:set, :public, :named_table])
    :ets.new(rbg, [:bag, :public, :named_table])

    on_exit(fn ->
      for t <- [gm, rel, rbg] do
        try do
          :ets.delete(t)
        rescue
          _ -> :ok
        end
      end
    end)

    %{group_members: gm, relationships: rel, relationships_by_group: rbg}
  end

  @doc """
  Builds authorization context options from isolated tables.

  Returns keyword list suitable for passing to authorization functions.
  """
  def auth_opts(tables) do
    [
      group_members: tables.group_members,
      relationships: tables.relationships,
      relationships_by_group: tables.relationships_by_group
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
  Returns a valid update map with string keys.

  Accepts an optional map of overrides that will be merged on top.
  """
  def sample_update(overrides \\ %{}) do
    hlc = generate_hlc()

    Map.merge(
      %{
        "id" => "upd_" <> Nanoid.generate(),
        "subject_id" => "todo_" <> Nanoid.generate(),
        "subject_type" => "todo",
        "method" => "put",
        "data" => %{
          "fields" => %{
            "title" => %{"type" => "lww", "value" => "Buy milk", "hlc" => hlc},
            "completed" => %{"type" => "lww", "value" => false, "hlc" => hlc}
          }
        }
      },
      overrides
    )
  end

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

  @doc """
  Returns a valid update map with atom keys (validated_update format).
  Used for testing the Writer after PermissionChecker validation.

  Handles both atom and string keys in overrides for convenience.

  ## Examples

      validated_update()  # basic update with random IDs
      validated_update(%{subject_id: "todo_123", method: :patch})  # with atom key overrides
      validated_update(%{"id" => "upd_123", "subject_id" => "todo_123"})  # with string key overrides
  """
  def validated_update(overrides \\ %{}) do
    hlc = generate_hlc()

    base = %{
      id: "upd_" <> Nanoid.generate(),
      subject_id: "todo_" <> Nanoid.generate(),
      subject_type: "todo",
      method: :put,
      data: %{
        "fields" => %{
          "title" => %{"type" => "lww", "value" => "Buy milk", "hlc" => hlc},
          "completed" => %{"type" => "lww", "value" => false, "hlc" => hlc}
        }
      }
    }

    # Handle both atom and string keys for structural fields
    result =
      Enum.reduce(overrides, base, fn
        {:id, v}, acc -> Map.put(acc, :id, v)
        {:subject_id, v}, acc -> Map.put(acc, :subject_id, v)
        {:subject_type, v}, acc -> Map.put(acc, :subject_type, v)
        {:method, v}, acc -> Map.put(acc, :method, v)
        {:data, v}, acc -> Map.put(acc, :data, v)
        {"id", v}, acc -> Map.put(acc, :id, v)
        {"subject_id", v}, acc -> Map.put(acc, :subject_id, v)
        {"subject_type", v}, acc -> Map.put(acc, :subject_type, v)
        {"method", v}, acc -> Map.put(acc, :method, v)
        {"data", v}, acc -> Map.put(acc, :data, v)
        # Skip other keys
        {_, _}, acc -> acc
      end)

    result
  end
end
