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
               :put,
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
               :patch,
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
               :put,
               todo_missing,
               "todo",
               %{"title" => lww("Never read", base_hlc, 2)},
               base_hlc,
               2
             )

    # `group` is a system type but has no eager populator, so it is as lazy as
    # a user type: materialized here, patched without a read.
    assert {:ok, {4, 4}, []} =
             write(
               writer_name,
               actor_id,
               :put,
               group_id,
               "group",
               %{"name" => lww("Original", base_hlc, 3)},
               base_hlc,
               3
             )

    assert {:ok, %{last_gsn: 4} = group} = get(ctx, group_id)
    assert field(group, "name") == "Original"

    assert {:ok, {5, 5}, []} =
             write(
               writer_name,
               actor_id,
               :patch,
               group_id,
               "group",
               %{"name" => lww("Patched group", base_hlc, 4)},
               base_hlc,
               4
             )

    # Membership and filing exist only so `query/4` can see the todos; both are
    # materialized by the eager boot phases.
    assert {:ok, {6, 6}, []} =
             write(
               writer_name,
               actor_id,
               :put,
               "gm_restart_#{System.unique_integer([:positive])}",
               "groupMember",
               %{
                 "actor_id" => lww(actor_id, base_hlc, 5),
                 "group_id" => lww(group_id, base_hlc, 5),
                 "permissions" => lww(["todo.read"], base_hlc, 5)
               },
               base_hlc,
               5
             )

    for {todo_id, counter, gsn} <- [{todo_stale, 6, 7}, {todo_missing, 7, 8}] do
      assert {:ok, {^gsn, ^gsn}, []} =
               write(
                 writer_name,
                 actor_id,
                 :put,
                 "eg_restart_#{counter}",
                 "entityGroup",
                 %{
                   "entity_id" => lww(todo_id, base_hlc, counter),
                   "group_id" => lww(group_id, base_hlc, counter)
                 },
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
    assert DirtyTracker.dirty_entity_ids_for_types(
             ["groupMember", "entityGroup", "relationship"],
             dirty_set
           ) == []

    assert Enum.sort(DirtyTracker.dirty_entity_ids_for_type("todo", dirty_set)) ==
             Enum.sort([todo_stale, todo_missing])

    assert DirtyTracker.dirty_entity_ids_for_type("group", dirty_set) == [group_id]

    assert {:ok, stale} = get(ctx, todo_stale, restarted)
    assert field(stale, "title") == "Patched"
    assert stale.last_gsn == 2

    assert {:ok, missing} = get(ctx, todo_missing, restarted)
    assert field(missing, "title") == "Never read"
    assert missing.last_gsn == 3

    assert {:ok, post_restart_group} = get(ctx, group_id, restarted)
    assert field(post_restart_group, "name") == "Patched group"
    assert post_restart_group.last_gsn == 5

    assert {:ok, todos} = EntityStore.query("todo", nil, actor_id, store_opts(ctx, restarted))
    assert Enum.sort(Enum.map(todos, & &1.id)) == Enum.sort([todo_stale, todo_missing])

    queried_stale = Enum.find(todos, &(&1.id == todo_stale))
    assert field(queried_stale, "title") == "Patched"
  end

  defp write(writer_name, actor_id, method, subject_id, subject_type, fields, base_hlc, counter) do
    hlc = TestHelpers.hlc_from(base_hlc, counter)

    action =
      TestHelpers.validated_action(%{
        actor_id: actor_id,
        hlc: hlc,
        updates: [
          TestHelpers.validated_update(%{
            subject_id: subject_id,
            subject_type: subject_type,
            method: method,
            data: %{"fields" => fields}
          })
        ]
      })

    Writer.write_actions([action], writer_name)
  end

  defp lww(value, base_hlc, counter) do
    %{"type" => "lww", "value" => value, "hlc" => TestHelpers.hlc_from(base_hlc, counter)}
  end

  defp field(entity, name), do: get_in(entity.data, ["fields", name, "value"])

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
