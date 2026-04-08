defmodule EbbServer.Storage.GroupCacheTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.GroupCache

  defp with_isolated_cache do
    table_name = :"test_gm_#{System.unique_integer([:positive])}"
    cache_name = :"test_gc_#{System.unique_integer([:positive])}"

    {:ok, _pid} = GroupCache.start_link(name: cache_name, table: table_name)

    on_exit(fn ->
      GroupCache.reset(table_name)
    end)

    %{table: table_name, cache_name: cache_name}
  end

  describe "put_group_member/2" do
    test "stores group membership entry" do
      %{table: table} = with_isolated_cache()

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          table
        )

      assert GroupCache.get_actor_groups("a_1", table) == [
               %{group_id: "g_1", permissions: ["todo.create"]}
             ]
    end

    test "rejects nil values" do
      %{table: table} = with_isolated_cache()

      assert {:error, :nil_values_not_allowed} =
               GroupCache.put_group_member(%{id: nil, actor_id: "a_1", group_id: "g_1"}, table)

      assert {:error, :nil_values_not_allowed} =
               GroupCache.put_group_member(%{id: "gm_1", actor_id: nil, group_id: "g_1"}, table)
    end
  end

  describe "get_actor_groups/2" do
    test "returns empty list when actor has no groups" do
      %{table: table} = with_isolated_cache()

      assert GroupCache.get_actor_groups("unknown", table) == []
    end

    test "returns empty list when table not found" do
      with_isolated_cache()

      assert GroupCache.get_actor_groups("a_1", []) == []
    end

    test "returns multiple groups for actor" do
      %{table: table} = with_isolated_cache()

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          table
        )

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_2", actor_id: "a_1", group_id: "g_2", permissions: ["post.create"]},
          table
        )

      groups = GroupCache.get_actor_groups("a_1", table)
      assert length(groups) == 2
    end
  end

  describe "get_permissions/3" do
    test "returns permissions for matching group" do
      %{table: table} = with_isolated_cache()

      :ok =
        GroupCache.put_group_member(
          %{
            id: "gm_1",
            actor_id: "a_1",
            group_id: "g_1",
            permissions: ["todo.create", "todo.update"]
          },
          table
        )

      assert GroupCache.get_permissions("a_1", "g_1", table) == ["todo.create", "todo.update"]
    end

    test "returns nil for non-member" do
      %{table: table} = with_isolated_cache()

      assert GroupCache.get_permissions("a_1", "g_nonexistent", table) == nil
    end

    test "returns nil gracefully when table not found" do
      with_isolated_cache()

      assert GroupCache.get_permissions("a_1", "g_1", []) == nil
    end
  end

  describe "delete_group_member/2" do
    test "removes group membership entry" do
      %{table: table} = with_isolated_cache()

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          table
        )

      assert GroupCache.get_actor_groups("a_1", table) != []

      :ok = GroupCache.delete_group_member("gm_1", table)

      assert GroupCache.get_actor_groups("a_1", table) == []
    end
  end
end
