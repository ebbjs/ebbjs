defmodule EbbServer.Storage.GroupCacheTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.GroupCache

  defp with_isolated_cache do
    table_name = :"test_gm_#{System.unique_integer([:positive])}"
    by_id_name = :"test_gm_by_id_#{System.unique_integer([:positive])}"
    by_group_name = :"test_gm_by_group_#{System.unique_integer([:positive])}"
    cache_name = :"test_gc_#{System.unique_integer([:positive])}"

    {:ok, _pid} =
      GroupCache.start_link(
        name: cache_name,
        table: table_name,
        group_members_by_id: by_id_name,
        group_members_by_group: by_group_name
      )

    on_exit(fn ->
      GroupCache.reset(
        group_members: table_name,
        group_members_by_id: by_id_name,
        group_members_by_group: by_group_name
      )
    end)

    %{
      table: table_name,
      cache_name: cache_name,
      by_id: by_id_name,
      by_group: by_group_name
    }
  end

  defp cache_opts(%{table: table, by_id: by_id, by_group: by_group}) do
    [
      group_members: table,
      group_members_by_id: by_id,
      group_members_by_group: by_group
    ]
  end

  describe "put_group_member/2" do
    test "stores group membership entry" do
      ctx = with_isolated_cache()

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          cache_opts(ctx)
        )

      assert GroupCache.get_actor_groups("a_1", ctx.table) == [
               %{group_id: "g_1", permissions: ["todo.create"]}
             ]
    end

    test "rejects nil values" do
      ctx = with_isolated_cache()

      assert {:error, :nil_values_not_allowed} =
               GroupCache.put_group_member(
                 %{id: nil, actor_id: "a_1", group_id: "g_1"},
                 cache_opts(ctx)
               )

      assert {:error, :nil_values_not_allowed} =
               GroupCache.put_group_member(
                 %{id: "gm_1", actor_id: nil, group_id: "g_1"},
                 cache_opts(ctx)
               )
    end

    test "a re-put that changes the group moves the by-id and by-group entries" do
      ctx = with_isolated_cache()

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_move", actor_id: "a_1", group_id: "g_1", permissions: ["todo.read"]},
          cache_opts(ctx)
        )

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_move", actor_id: "a_1", group_id: "g_2", permissions: ["todo.read"]},
          cache_opts(ctx)
        )

      assert GroupCache.get_group_member("gm_move", ctx.by_id).group_id == "g_2"

      assert GroupCache.get_actor_groups("a_1", ctx.table) == [
               %{group_id: "g_2", permissions: ["todo.read"]}
             ]

      assert GroupCache.group_member_ids("g_1", ctx.by_group) == []
      assert GroupCache.group_member_ids("g_2", ctx.by_group) == ["gm_move"]
    end

    test "a re-put that changes the actor drops the old primary entry" do
      ctx = with_isolated_cache()

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          cache_opts(ctx)
        )

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_1", actor_id: "a_2", group_id: "g_1", permissions: ["todo.create"]},
          cache_opts(ctx)
        )

      assert GroupCache.get_actor_groups("a_1", ctx.table) == []
      assert GroupCache.get_permissions("a_1", "g_1", ctx.table) == nil
      assert GroupCache.get_permissions("a_2", "g_1", ctx.table) == ["todo.create"]
    end
  end

  describe "get_actor_groups/2" do
    test "returns empty list when actor has no groups" do
      ctx = with_isolated_cache()

      assert GroupCache.get_actor_groups("unknown", ctx.table) == []
    end

    test "returns empty list when table not found" do
      with_isolated_cache()

      assert GroupCache.get_actor_groups("a_1", []) == []
    end

    test "returns multiple groups for actor" do
      ctx = with_isolated_cache()

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          cache_opts(ctx)
        )

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_2", actor_id: "a_1", group_id: "g_2", permissions: ["post.create"]},
          cache_opts(ctx)
        )

      groups = GroupCache.get_actor_groups("a_1", ctx.table)
      assert length(groups) == 2
    end
  end

  describe "get_group_member/2" do
    test "returns membership entry by member id" do
      ctx = with_isolated_cache()

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          cache_opts(ctx)
        )

      entry = GroupCache.get_group_member("gm_1", ctx.by_id)
      assert entry.id == "gm_1"
      assert entry.actor_id == "a_1"
      assert entry.group_id == "g_1"
      assert entry.permissions == ["todo.create"]
    end

    test "returns nil for unknown member id" do
      ctx = with_isolated_cache()

      assert GroupCache.get_group_member("unknown", ctx.by_id) == nil
    end
  end

  describe "get_permissions/3" do
    test "returns permissions for matching group" do
      ctx = with_isolated_cache()

      :ok =
        GroupCache.put_group_member(
          %{
            id: "gm_1",
            actor_id: "a_1",
            group_id: "g_1",
            permissions: ["todo.create", "todo.update"]
          },
          cache_opts(ctx)
        )

      assert GroupCache.get_permissions("a_1", "g_1", ctx.table) == [
               "todo.create",
               "todo.update"
             ]
    end

    test "returns nil for non-member" do
      ctx = with_isolated_cache()

      assert GroupCache.get_permissions("a_1", "g_nonexistent", ctx.table) == nil
    end

    test "returns nil gracefully when table not found" do
      with_isolated_cache()

      assert GroupCache.get_permissions("a_1", "g_1", []) == nil
    end
  end

  describe "delete_group_member/2" do
    test "removes group membership entry from every table" do
      ctx = with_isolated_cache()

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          cache_opts(ctx)
        )

      assert GroupCache.get_actor_groups("a_1", ctx.table) != []
      assert GroupCache.get_group_member("gm_1", ctx.by_id) != nil
      assert GroupCache.group_member_ids("g_1", ctx.by_group) == ["gm_1"]

      :ok = GroupCache.delete_group_member("gm_1", cache_opts(ctx))

      assert GroupCache.get_actor_groups("a_1", ctx.table) == []
      assert GroupCache.get_group_member("gm_1", ctx.by_id) == nil
      assert GroupCache.group_member_ids("g_1", ctx.by_group) == []
    end
  end

  describe "group_member_ids/2" do
    test "enumerates every member row scoping to a group" do
      ctx = with_isolated_cache()

      for {id, group_id} <- [{"gm_1", "g_1"}, {"gm_2", "g_1"}, {"gm_3", "g_2"}] do
        :ok =
          GroupCache.put_group_member(
            %{id: id, actor_id: "a_1", group_id: group_id, permissions: ["todo.create"]},
            cache_opts(ctx)
          )
      end

      assert Enum.sort(GroupCache.group_member_ids("g_1", ctx.by_group)) == ["gm_1", "gm_2"]
      assert GroupCache.group_member_ids("g_2", ctx.by_group) == ["gm_3"]
      assert GroupCache.group_member_ids("unknown", ctx.by_group) == []
    end

    test "a re-put that moves a row drops the stale by-group entry" do
      ctx = with_isolated_cache()

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          cache_opts(ctx)
        )

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_2", permissions: ["todo.create"]},
          cache_opts(ctx)
        )

      assert GroupCache.group_member_ids("g_1", ctx.by_group) == []
      assert GroupCache.group_member_ids("g_2", ctx.by_group) == ["gm_1"]
    end
  end

  describe "instance isolation" do
    test "a put through one cache's tables leaves the other cache's indexes untouched" do
      cache_a = with_isolated_cache()
      # Starting B afterwards publishes B's tables last, the state that used
      # to route A's secondary indexes into B.
      cache_b = with_isolated_cache()

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_iso", actor_id: "a_1", group_id: "g_1", permissions: ["todo.read"]},
          cache_opts(cache_a)
        )

      assert GroupCache.get_actor_groups("a_1", cache_a.table) != []
      assert GroupCache.get_group_member("gm_iso", cache_a.by_id) != nil
      assert GroupCache.group_member_ids("g_1", cache_a.by_group) == ["gm_iso"]

      assert GroupCache.get_actor_groups("a_1", cache_b.table) == []
      assert GroupCache.get_group_member("gm_iso", cache_b.by_id) == nil
      assert GroupCache.group_member_ids("g_1", cache_b.by_group) == []
    end
  end
end
