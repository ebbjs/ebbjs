defmodule EbbServer.Storage.SystemCacheFailureInjectionTest do
  @moduledoc """
  A failed backfill or materialization must stop the rebuild instead of
  serving a half-built index (ebbjs/ebbjs#421, #641 slice 7).

  Every failure below is produced by the real store: an entity the action
  log cannot materialize, a malformed index key, and a database opened
  read-only so reads succeed and every write genuinely fails. Each test
  asserts what a caller observes — the rebuild raises or exits, the caches
  it was filling are not served, and the durable marker that would skip the
  migration next boot is not written.
  """

  # Stands in for the read dependency at the one seam the rebuild reaches it
  # through: a real GenServer whose call raises, so the caller's exit carries
  # an exception struct — the shape `telemetry_reason/2` must strip.
  defmodule RaisingStore do
    @moduledoc false
    use GenServer

    def start_link(opts), do: GenServer.start_link(__MODULE__, :ok, name: opts[:name])

    @impl true
    def init(:ok), do: {:ok, :ok}

    @impl true
    def handle_call(_request, _from, _state), do: raise("read path exploded")
  end

  # A `:via` registry whose lookup fails. `GenServer.call/3` resolves a `:via`
  # name in the calling process, so the lookup's exit is what the rebuild sees
  # when the registry itself is gone.
  defmodule FailingRegistry do
    @moduledoc false

    def whereis_name({:exits, reason}), do: exit(reason)
    def whereis_name(_name), do: :undefined

    def register_name(_name, _pid), do: :no
    def unregister_name(_name), do: :ok
    def send(_name, _message), do: :ok
  end

  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias EbbServer.Storage.{
    ActionFormat,
    EntityTypeCache,
    GroupCache,
    RocksDB,
    SQLite,
    SystemCache
  }

  alias EbbServer.TestHelpers

  @marker_key "system_cache:type_entities_backfill"

  # Mirrors `RocksDB.@handle_keys`. The read-only database below has to
  # publish handles the module's accessors can read, and `RocksDB` only opens
  # read-write; this is the smallest way to make its writes fail for real.
  @handle_keys %{
    db: :ebb_rocksdb_db,
    default: :ebb_cf_default,
    actions: :ebb_cf_actions,
    entity_actions: :ebb_cf_entity_actions,
    type_entities: :ebb_cf_type_entities,
    action_dedup: :ebb_cf_action_dedup,
    group_actions: :ebb_cf_group_actions
  }

  setup do
    unique = System.unique_integer([:positive])

    tables = TestHelpers.start_isolated_cache()
    rocks = TestHelpers.start_rocks(%{test: "sys_cache_failure_#{unique}"})
    sqlite = TestHelpers.start_sqlite(rocks.dir)

    %{tables: tables, rocks: rocks, sqlite: sqlite}
  end

  describe "materialization failures while populating" do
    test "an entity the action log cannot produce is skipped, not fatal", ctx do
      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])

      seed_type_entity(ctx, "groupMember", "gm_present")
      seed_type_entity(ctx, "groupMember", "gm_absent")

      :ok =
        SQLite.upsert_entity(
          entity_row("gm_present", membership_data("actor_present", "grp_1")),
          ctx.sqlite.name
        )

      log =
        capture_log(fn ->
          assert :ok = SystemCache.populate_system_caches(populate_opts(ctx))
        end)

      assert log =~ "Failed to materialize entity gm_absent"

      assert [{[:ebb, :system_cache, :populated], measurements, %{outcome: :ok}}] =
               TestHelpers.telemetry_events(ref)

      assert measurements.group_members == 1

      assert %{id: "gm_present"} =
               GroupCache.get_group_member("gm_present", ctx.tables.group_members_by_id)

      assert GroupCache.get_group_member("gm_absent", ctx.tables.group_members_by_id) == nil
    end
  end

  describe "type-entities index walking" do
    test "a key without a type separator is dropped, not indexed", ctx do
      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])

      db = RocksDB.db_ref(ctx.rocks.name)
      cf_type = RocksDB.cf_type_entities(ctx.rocks.name)

      # A half-written pair: `cf_type_entities` keys are `type <> 0 <> id`.
      :ok = :rocksdb.put(db, cf_type, "groupMembe", <<>>, [])
      seed_type_entity(ctx, "todo", "todo_well_formed")

      assert :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      assert EntityTypeCache.get_type("todo_well_formed", ctx.tables.entity_types) == "todo"
      assert EntityTypeCache.get_type("groupMembe", ctx.tables.entity_types) == nil

      assert [{[:ebb, :system_cache, :populated], measurements, %{outcome: :ok}}] =
               TestHelpers.telemetry_events(ref)

      assert measurements.entity_types == 1
    end
  end

  describe "backfill writes" do
    test "a missing index entry that cannot be written fails the rebuild", ctx do
      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])

      seed_action(ctx, "todo_backfill_unwritable")
      reopen_read_only(ctx)

      assert_raise RuntimeError, ~r/cf_type_entities backfill write failed/, fn ->
        SystemCache.populate_system_caches(populate_opts(ctx))
      end

      assert [
               {[:ebb, :system_cache, :populated], measurements,
                %{outcome: :error, reason: RuntimeError}}
             ] =
               TestHelpers.telemetry_events(ref)

      assert measurements.backfilled == 0
      assert measurements.group_members == 0
      assert marker(ctx) == :not_found
    end

    test "a marker that cannot be written fails the rebuild", ctx do
      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])

      reopen_read_only(ctx)

      assert_raise RuntimeError, ~r/default column family marker write failed/, fn ->
        SystemCache.populate_system_caches(populate_opts(ctx))
      end

      assert [
               {[:ebb, :system_cache, :populated], measurements,
                %{outcome: :error, reason: RuntimeError}}
             ] =
               TestHelpers.telemetry_events(ref)

      assert measurements.backfilled == 0
      assert measurements.group_members == 0
      assert marker(ctx) == :not_found
    end
  end

  describe "telemetry failure classes" do
    test "an exception raised inside a dependency call is reported by class", ctx do
      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])

      seed_type_entity(ctx, "groupMember", "gm_raises")

      name = :"raising_store_#{System.unique_integer([:positive])}"
      start_supervised!({RaisingStore, name: name})

      # The store crashes by design; capture its crash log instead of letting
      # it spill into the suite output.
      log =
        capture_log(fn ->
          assert {{%RuntimeError{}, _stacktrace}, {GenServer, :call, _args}} =
                   catch_exit(
                     SystemCache.populate_system_caches(populate_opts(ctx, sqlite_name: name))
                   )
        end)

      assert log =~ "read path exploded"

      assert [
               {[:ebb, :system_cache, :populated], measurements,
                %{outcome: :error, reason: RuntimeError}}
             ] =
               TestHelpers.telemetry_events(ref)

      assert measurements.group_members == 0
    end

    test "an atom carried by an exit is reported as that atom", ctx do
      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])

      seed_type_entity(ctx, "groupMember", "gm_exits")

      name = {:via, FailingRegistry, {:exits, :store_unavailable}}

      assert catch_exit(SystemCache.populate_system_caches(populate_opts(ctx, sqlite_name: name))) ==
               :store_unavailable

      assert [
               {[:ebb, :system_cache, :populated], _measurements,
                %{outcome: :error, reason: :store_unavailable}}
             ] =
               TestHelpers.telemetry_events(ref)
    end
  end

  defp populate_opts(ctx, extra \\ []) do
    tables = ctx.tables

    Keyword.merge(
      [
        rocks_name: ctx.rocks.name,
        sqlite_name: ctx.sqlite.name,
        dirty_set: tables.dirty_set,
        table: tables.group_members,
        entity_groups: tables.entity_groups,
        entity_groups_by_id: tables.entity_groups_by_id,
        entity_groups_by_group: tables.entity_groups_by_group,
        entity_types: tables.entity_types,
        relationships: tables.relationships,
        relationships_by_id: tables.relationships_by_id
      ],
      extra
    )
  end

  defp seed_type_entity(ctx, type, entity_id) do
    :ok =
      :rocksdb.put(
        RocksDB.db_ref(ctx.rocks.name),
        RocksDB.cf_type_entities(ctx.rocks.name),
        RocksDB.encode_type_entity_key(type, entity_id),
        <<>>,
        []
      )
  end

  defp seed_action(ctx, entity_id) do
    payload =
      %{
        id: "act_#{System.unique_integer([:positive])}",
        actor_id: "demo-seeder",
        hlc: TestHelpers.generate_hlc(),
        updates: [
          %{
            id: "upd_#{System.unique_integer([:positive])}",
            subject_id: entity_id,
            subject_type: "todo",
            method: :put,
            data: %{"fields" => %{}}
          }
        ]
      }
      |> ActionFormat.build()
      |> ActionFormat.encode()

    :ok =
      RocksDB.write_batch(
        [
          {:put, RocksDB.cf_actions(ctx.rocks.name), RocksDB.encode_gsn_key(1),
           ActionFormat.frame(payload, [[]])}
        ],
        name: ctx.rocks.name
      )
  end

  defp entity_row(id, data) do
    %{
      id: id,
      type: "groupMember",
      data: data,
      created_hlc: 0,
      updated_hlc: 0,
      deleted_hlc: nil,
      deleted_by: nil,
      last_gsn: 0
    }
  end

  defp membership_data(actor_id, group_id) do
    Jason.encode!(%{
      "fields" => %{
        "actor_id" => %{"value" => actor_id},
        "group_id" => %{"value" => group_id},
        "permissions" => %{"value" => ["group.read"]}
      }
    })
  end

  defp marker(ctx) do
    RocksDB.get(RocksDB.cf_default(ctx.rocks.name), @marker_key, name: ctx.rocks.name)
  end

  # Close the writable database, then reopen the same directory read-only and
  # publish its handles under the same name. Reads then work and every write
  # returns a real RocksDB "not supported in read only mode" error.
  defp reopen_read_only(ctx) do
    dir = ctx.rocks.dir
    name = ctx.rocks.name

    :ok = GenServer.stop(ctx.rocks.pid, :normal)

    path = dir |> Path.join("rocksdb") |> String.to_charlist()
    {:ok, cf_names} = :rocksdb.list_column_families(path, [])
    {:ok, db, cf_handles} = :rocksdb.open_readonly(path, [], Enum.map(cf_names, &{&1, []}))

    handles =
      cf_names
      |> Enum.zip(cf_handles)
      |> Map.new(fn {cf_name, handle} -> {List.to_string(cf_name), handle} end)

    published = %{
      db: db,
      default: handles["default"],
      actions: handles["cf_actions"],
      entity_actions: handles["cf_entity_actions"],
      type_entities: handles["cf_type_entities"],
      action_dedup: handles["cf_action_dedup"],
      group_actions: handles["cf_group_actions"]
    }

    Enum.each(@handle_keys, fn {key, term_key} ->
      :persistent_term.put({term_key, name}, Map.fetch!(published, key))
    end)

    on_exit(fn ->
      Enum.each(@handle_keys, fn {_key, term_key} ->
        :persistent_term.erase({term_key, name})
      end)
    end)
  end
end
