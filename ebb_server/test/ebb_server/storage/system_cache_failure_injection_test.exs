defmodule EbbServer.Storage.SystemCacheFailureInjectionTest do
  @moduledoc """
  A failed materialization during the boot seed must stop the rebuild instead
  of serving a half-built cache (ebbjs/ebbjs#421, #641 slice 7).

  Every failure below is produced by the real store: the action log cannot
  materialize an indexed row, a dependency call crashes, or a registry exits.
  Each test asserts what a caller observes — the rebuild raises or exits and
  the caches it was filling are not served.
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
    ComponentEntityIndex,
    EntityTypeCache,
    GroupCache,
    RocksDB,
    SQLite,
    SystemCache
  }

  alias EbbServer.TestHelpers

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

      seed_model_entry(ctx, "groupMember", "gm_present")
      seed_model_entry(ctx, "groupMember", "gm_absent")

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

  describe "component index walking" do
    test "the seed indexes the models the log names, not the component names", ctx do
      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])

      entity_id = "todo_seeded_#{System.unique_integer([:positive])}"

      action =
        TestHelpers.validated_action(%{
          updates: [
            TestHelpers.validated_component(entity_id, "todo/title", %{"value" => "Title"})
          ]
        })

      seed_actions(ctx, [action])
      ComponentEntityIndex.reset(index_opts(ctx))

      assert :ok = SystemCache.populate_system_caches(populate_opts(ctx))

      assert EntityTypeCache.get_type(entity_id, ctx.tables.entity_types) == "todo"
      assert EntityTypeCache.get_type("todo/title", ctx.tables.entity_types) == nil

      assert [{[:ebb, :system_cache, :populated], measurements, %{outcome: :ok}}] =
               TestHelpers.telemetry_events(ref)

      assert measurements.entity_types == 1
    end
  end

  describe "telemetry failure classes" do
    test "an exception raised inside a dependency call is reported by class", ctx do
      ref = TestHelpers.attach_telemetry([[:ebb, :system_cache, :populated]])

      seed_model_entry(ctx, "groupMember", "gm_raises")

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

      seed_model_entry(ctx, "groupMember", "gm_exits")

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
        component_index: tables.component_index,
        component_entity_labels: tables.component_entity_labels,
        relationships: tables.relationships,
        relationships_by_id: tables.relationships_by_id
      ],
      extra
    )
  end

  defp index_opts(ctx) do
    [
      component_index: ctx.tables.component_index,
      component_entity_labels: ctx.tables.component_entity_labels
    ]
  end

  defp seed_model_entry(ctx, model, entity_id) do
    ComponentEntityIndex.apply_ops([{:put, {model, entity_id}}], index_opts(ctx))
  end

  defp seed_actions(ctx, actions) do
    actions
    |> Enum.with_index(1)
    |> Enum.each(fn {action, gsn} -> seed_action(ctx, action, gsn) end)
  end

  defp seed_action(ctx, action, gsn) do
    frame =
      action
      |> ActionFormat.build()
      |> ActionFormat.encode()
      |> then(&ActionFormat.frame(&1, [[]]))

    :ok =
      RocksDB.write_batch(
        [{:put, RocksDB.cf_actions(ctx.rocks.name), RocksDB.encode_gsn_key(gsn), frame}],
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
end
