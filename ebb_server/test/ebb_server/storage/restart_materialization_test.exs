defmodule EbbServer.Storage.RestartMaterializationTest do
  @moduledoc """
  Regression tests for #564: dirty marks are ETS-only, so a restart loses
  them. Without re-marking at boot, `EntityStore.get/3` serves stale rows for
  entities whose last commit was never read and `:not_found` for entities that
  were never materialized at all.

  These tests stop the real stores, restart them on the same data dirs, empty
  the dirty set, and run the real boot path — no mocked dirty-set clearing.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{
    DirtyTracker,
    EntityStore,
    RocksDB,
    SQLite,
    SystemCache,
    SystemComponent,
    Writer
  }

  alias EbbServer.TestHelpers

  setup do
    cache =
      %{
        dirty_set: dirty_set,
        group_members: gm_table,
        group_members_by_id: gm_by_id_table,
        group_members_by_group: _gm_by_group_table,
        entity_groups: eg_table,
        entity_groups_by_id: eg_by_id_table,
        entity_groups_by_group: eg_by_group_table,
        entity_types: entity_types_table,
        relationships: rel_table,
        relationships_by_id: rbi_table
      } = TestHelpers.start_isolated_cache()

    %{name: rocks_name, dir: data_dir} = TestHelpers.start_rocks(%{test: "restart_mat"})
    %{name: sqlite_name} = TestHelpers.start_sqlite(data_dir)

    %{name: writer_name} =
      TestHelpers.start_writer(%{
        rocks_name: rocks_name,
        dirty_set: dirty_set,
        gsn_counter: cache.gsn_counter,
        group_members: gm_table,
        group_members_by_id: gm_by_id_table,
        entity_groups: eg_table,
        entity_groups_by_id: eg_by_id_table,
        entity_groups_by_group: eg_by_group_table,
        entity_types: entity_types_table,
        relationships: rel_table,
        relationships_by_id: rbi_table
      })

    %{
      cache: cache,
      data_dir: data_dir,
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      writer_name: writer_name
    }
  end

  test "boot re-marking makes get/3 and query/4 serve durable state after a restart", ctx do
    %{cache: %{dirty_set: dirty_set}, writer_name: writer_name} = ctx

    actor_id = "a_restart_#{System.unique_integer([:positive])}"
    todo_stale = "todo_stale_#{System.unique_integer([:positive])}"
    todo_missing = "todo_missing_#{System.unique_integer([:positive])}"
    group_id = "group_restart_#{System.unique_integer([:positive])}"
    base_hlc = System.os_time(:millisecond)

    # Materialized at GSN 1, then patched without a read: after a restart only
    # the patch's dirty mark would have stood between SQLite and staleness.
    assert {:ok, {1, 1}, []} =
             write(
               writer_name,
               actor_id,
               :replace,
               todo_stale,
               "todo",
               %{"title" => lww("Draft", base_hlc, 0)},
               base_hlc,
               0
             )

    assert {:ok, %{last_gsn: 1} = todo} = get(ctx, todo_stale)
    assert field(todo, "title") == "Draft"

    assert {:ok, {2, 2}, []} =
             write(
               writer_name,
               actor_id,
               :merge,
               todo_stale,
               "todo",
               %{"title" => lww("Patched", base_hlc, 1)},
               base_hlc,
               1
             )

    # Committed but never read: no SQLite row exists for it.
    assert {:ok, {3, 3}, []} =
             write(
               writer_name,
               actor_id,
               :replace,
               todo_missing,
               "todo",
               %{"title" => lww("Never read", base_hlc, 2)},
               base_hlc,
               2
             )

    # `ebb/group` only became an eager component when the handshake started
    # reading app scope at boot; this row is materialized here, then patched
    # without a read.
    assert {:ok, {4, 4}, []} =
             write(
               writer_name,
               actor_id,
               :replace,
               group_id,
               :group,
               %{"name" => "Original"},
               base_hlc,
               3
             )

    assert {:ok, %{last_gsn: 4} = group} = get(ctx, group_id)
    assert platform_field(group, :group, "name") == "Original"

    assert {:ok, {5, 5}, []} =
             write(
               writer_name,
               actor_id,
               :merge,
               group_id,
               :group,
               %{"name" => "Patched group"},
               base_hlc,
               4
             )

    # A grant and a membership exist only so `query/4` can see the todos; both
    # are materialized by the eager boot phases.
    assert {:ok, {6, 6}, []} =
             write(
               writer_name,
               actor_id,
               :replace,
               "gm_restart_#{System.unique_integer([:positive])}",
               :grant,
               %{
                 "actor_id" => actor_id,
                 "group_id" => group_id,
                 "permissions" => ["todo.read"]
               },
               base_hlc,
               5
             )

    for {todo_id, counter, gsn} <- [{todo_stale, 6, 7}, {todo_missing, 7, 8}] do
      assert {:ok, {^gsn, ^gsn}, []} =
               write(
                 writer_name,
                 actor_id,
                 :replace,
                 "eg_restart_#{counter}",
                 :membership,
                 %{"entity_id" => todo_id, "group_id" => group_id},
                 base_hlc,
                 counter
               )
    end

    restarted = restart_stores(ctx)
    DirtyTracker.reset(dirty_set)
    assert DirtyTracker.size(dirty_set) == 0

    :ok = SystemCache.populate_system_caches(populate_opts(ctx, restarted))

    # The eager phases materialize and clear the system-type marks; a surviving
    # one would be a repair candidate, not the normal state.
    assert DirtyTracker.dirty_entity_ids_for_models([SystemComponent.model()], dirty_set) == []

    assert Enum.sort(DirtyTracker.dirty_entity_ids_for_model("todo", dirty_set)) ==
             Enum.sort([todo_stale, todo_missing])

    assert {:ok, stale} = get(ctx, todo_stale, restarted)
    assert field(stale, "title") == "Patched"
    assert stale.last_gsn == 2

    assert {:ok, missing} = get(ctx, todo_missing, restarted)
    assert field(missing, "title") == "Never read"
    assert missing.last_gsn == 3

    assert {:ok, post_restart_group} = get(ctx, group_id, restarted)
    assert platform_field(post_restart_group, :group, "name") == "Patched group"
    assert post_restart_group.last_gsn == 5

    assert {:ok, todos} = EntityStore.query("todo", nil, actor_id, store_opts(ctx, restarted))
    assert Enum.sort(Enum.map(todos, & &1.id)) == Enum.sort([todo_stale, todo_missing])

    queried_stale = Enum.find(todos, &(&1.id == todo_stale))
    assert field(queried_stale, "title") == "Patched"
  end

  test "a cold replay rebuilds a row whose only component was dropped", ctx do
    %{cache: %{dirty_set: dirty_set}, writer_name: writer_name} = ctx

    actor_id = "a_zero_restart_#{System.unique_integer([:positive])}"
    todo_id = "todo_zero_restart_#{System.unique_integer([:positive])}"
    base_hlc = System.os_time(:millisecond)

    assert {:ok, {1, 1}, []} =
             write(
               writer_name,
               actor_id,
               :replace,
               todo_id,
               "todo",
               %{"title" => lww("Only", base_hlc, 0)},
               base_hlc,
               0
             )

    assert {:ok, {2, 2}, []} =
             write(
               writer_name,
               actor_id,
               :drop,
               todo_id,
               "todo",
               %{"title" => nil},
               base_hlc,
               1
             )

    # Never materialized before the restart, so the replay starts at GSN 0
    # with no cached row and has to apply the create and the drop in one pass.
    restarted = restart_stores(ctx)
    DirtyTracker.reset(dirty_set)

    create_hlc = TestHelpers.hlc_from(base_hlc, 0)

    assert {:ok, row} = EntityStore.materialize(todo_id, store_opts(ctx, restarted))
    assert row.type == "todo"
    assert row.created_hlc == create_hlc
    assert row.deleted_hlc == nil
    assert row.data == %{"fields" => %{}, "components" => []}
    assert row.last_gsn == 2

    assert {:ok, cached} = SQLite.get_entity(todo_id, restarted.sqlite_name)
    assert cached.created_hlc == create_hlc
    assert cached.deleted_hlc == nil
    assert cached.last_gsn == 2
    assert Jason.decode!(cached.data) == %{"fields" => %{}, "components" => []}
  end

  # `model` is a user model string or a platform kind. A user row is one
  # component per field; a platform row is one atomic component carrying the
  # whole value, so its `fields` argument is that value.
  defp write(writer_name, actor_id, method, subject_id, model, fields, base_hlc, counter) do
    hlc = TestHelpers.hlc_from(base_hlc, counter)
    updates = component_updates(model, subject_id, fields, method, hlc)

    action =
      TestHelpers.validated_action(%{
        actor_id: actor_id,
        hlc: hlc,
        updates: updates
      })

    Writer.write_actions([action], writer_name)
  end

  defp component_updates(kind, subject_id, value, method, hlc) when is_atom(kind) do
    [
      TestHelpers.validated_component(
        subject_id,
        SystemComponent.component(kind),
        %{"value" => value, "hlc" => hlc},
        method: method
      )
    ]
  end

  defp component_updates(model, subject_id, fields, method, _hlc) do
    Enum.map(fields, fn {field, value} ->
      TestHelpers.validated_component(
        subject_id,
        "#{model}/#{field}",
        value,
        method: method
      )
    end)
  end

  defp lww(value, base_hlc, counter) do
    %{"type" => "lww", "value" => value, "hlc" => TestHelpers.hlc_from(base_hlc, counter)}
  end

  defp field(entity, name), do: get_in(entity.data, ["fields", name, "value"])

  defp platform_field(entity, kind, name) do
    get_in(entity.data, ["fields", SystemComponent.field(kind), "value", name])
  end

  defp get(ctx, entity_id, stores \\ nil) do
    EntityStore.get(entity_id, "a_test", store_opts(ctx, stores))
  end

  defp store_opts(ctx, stores) do
    %{rocks_name: rocks_name, sqlite_name: sqlite_name} = Map.merge(ctx, stores || %{})

    [rocks_name: rocks_name, sqlite_name: sqlite_name, dirty_set: ctx.cache.dirty_set]
  end

  defp populate_opts(ctx, stores) do
    %{rocks_name: rocks_name, sqlite_name: sqlite_name} = Map.merge(ctx, stores || %{})

    [
      rocks_name: rocks_name,
      sqlite_name: sqlite_name,
      dirty_set: ctx.cache.dirty_set,
      table: ctx.cache.group_members,
      entity_groups: ctx.cache.entity_groups,
      entity_groups_by_id: ctx.cache.entity_groups_by_id,
      entity_groups_by_group: ctx.cache.entity_groups_by_group,
      entity_types: ctx.cache.entity_types,
      relationships: ctx.cache.relationships,
      relationships_by_id: ctx.cache.relationships_by_id
    ]
  end

  # Stop every store the Writer wrote through, then reopen RocksDB and SQLite
  # on the same data directories under fresh names.
  defp restart_stores(ctx) do
    TestHelpers.safe_stop(Process.whereis(ctx.writer_name))
    TestHelpers.safe_stop(Process.whereis(ctx.sqlite_name))
    TestHelpers.safe_stop(Process.whereis(ctx.rocks_name))

    unique = System.unique_integer([:positive])
    rocks_name = :"rocks_restarted_#{unique}"
    sqlite_name = :"sqlite_restarted_#{unique}"

    {:ok, rocks_pid} = RocksDB.start_link(data_dir: ctx.data_dir, name: rocks_name)
    {:ok, sqlite_pid} = SQLite.start_link(data_dir: ctx.data_dir, name: sqlite_name)

    ExUnit.Callbacks.on_exit(fn ->
      TestHelpers.safe_stop(sqlite_pid)
      TestHelpers.safe_stop(rocks_pid)
    end)

    %{rocks_name: rocks_name, sqlite_name: sqlite_name}
  end
end
