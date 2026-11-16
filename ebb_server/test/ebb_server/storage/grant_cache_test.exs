defmodule EbbServer.Storage.GrantCacheTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.GrantCache

  defp with_isolated_cache do
    table_name = :"test_gm_#{System.unique_integer([:positive])}"
    by_id_name = :"test_gm_by_id_#{System.unique_integer([:positive])}"
    by_group_name = :"test_gm_by_group_#{System.unique_integer([:positive])}"
    cache_name = :"test_gc_#{System.unique_integer([:positive])}"

    {:ok, _pid} =
      GrantCache.start_link(
        name: cache_name,
        table: table_name,
        grants_by_id: by_id_name,
        grants_by_group: by_group_name
      )

    on_exit(fn ->
      GrantCache.reset(
        grants: table_name,
        grants_by_id: by_id_name,
        grants_by_group: by_group_name
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
      grants: table,
      grants_by_id: by_id,
      grants_by_group: by_group
    ]
  end

  describe "put_grant/2" do
    test "stores group membership entry" do
      ctx = with_isolated_cache()

      :ok =
        GrantCache.put_grant(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          cache_opts(ctx)
        )

      assert GrantCache.get_actor_groups("a_1", ctx.table) == [
               %{group_id: "g_1", permissions: ["todo.create"]}
             ]
    end

    test "rejects nil values" do
      ctx = with_isolated_cache()

      assert {:error, :nil_values_not_allowed} =
               GrantCache.put_grant(
                 %{id: nil, actor_id: "a_1", group_id: "g_1"},
                 cache_opts(ctx)
               )

      assert {:error, :nil_values_not_allowed} =
               GrantCache.put_grant(
                 %{id: "gm_1", actor_id: nil, group_id: "g_1"},
                 cache_opts(ctx)
               )
    end

    test "a re-put that changes the group moves the by-id and by-group entries" do
      ctx = with_isolated_cache()

      :ok =
        GrantCache.put_grant(
          %{id: "gm_move", actor_id: "a_1", group_id: "g_1", permissions: ["todo.read"]},
          cache_opts(ctx)
        )

      :ok =
        GrantCache.put_grant(
          %{id: "gm_move", actor_id: "a_1", group_id: "g_2", permissions: ["todo.read"]},
          cache_opts(ctx)
        )

      assert GrantCache.get_grant("gm_move", ctx.by_id).group_id == "g_2"

      assert GrantCache.get_actor_groups("a_1", ctx.table) == [
               %{group_id: "g_2", permissions: ["todo.read"]}
             ]

      assert GrantCache.grant_ids("g_1", ctx.by_group) == []
      assert GrantCache.grant_ids("g_2", ctx.by_group) == ["gm_move"]
    end

    test "a re-put that changes the actor drops the old primary entry" do
      ctx = with_isolated_cache()

      :ok =
        GrantCache.put_grant(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          cache_opts(ctx)
        )

      :ok =
        GrantCache.put_grant(
          %{id: "gm_1", actor_id: "a_2", group_id: "g_1", permissions: ["todo.create"]},
          cache_opts(ctx)
        )

      assert GrantCache.get_actor_groups("a_1", ctx.table) == []
      assert GrantCache.get_permissions("a_1", "g_1", ctx.table) == nil
      assert GrantCache.get_permissions("a_2", "g_1", ctx.table) == ["todo.create"]
    end
  end

  describe "get_actor_groups/2" do
    test "returns empty list when actor has no groups" do
      ctx = with_isolated_cache()

      assert GrantCache.get_actor_groups("unknown", ctx.table) == []
    end

    test "returns empty list when table not found" do
      with_isolated_cache()

      assert GrantCache.get_actor_groups("a_1", []) == []
    end

    test "returns multiple groups for actor" do
      ctx = with_isolated_cache()

      :ok =
        GrantCache.put_grant(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          cache_opts(ctx)
        )

      :ok =
        GrantCache.put_grant(
          %{id: "gm_2", actor_id: "a_1", group_id: "g_2", permissions: ["post.create"]},
          cache_opts(ctx)
        )

      groups = GrantCache.get_actor_groups("a_1", ctx.table)
      assert length(groups) == 2
    end
  end

  describe "get_grant/2" do
    test "returns membership entry by member id" do
      ctx = with_isolated_cache()

      :ok =
        GrantCache.put_grant(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          cache_opts(ctx)
        )

      entry = GrantCache.get_grant("gm_1", ctx.by_id)
      assert entry.id == "gm_1"
      assert entry.actor_id == "a_1"
      assert entry.group_id == "g_1"
      assert entry.permissions == ["todo.create"]
    end

    test "returns nil for unknown member id" do
      ctx = with_isolated_cache()

      assert GrantCache.get_grant("unknown", ctx.by_id) == nil
    end
  end

  describe "get_permissions/3" do
    test "returns permissions for matching group" do
      ctx = with_isolated_cache()

      :ok =
        GrantCache.put_grant(
          %{
            id: "gm_1",
            actor_id: "a_1",
            group_id: "g_1",
            permissions: ["todo.create", "todo.update"]
          },
          cache_opts(ctx)
        )

      assert GrantCache.get_permissions("a_1", "g_1", ctx.table) == [
               "todo.create",
               "todo.update"
             ]
    end

    test "returns nil for non-member" do
      ctx = with_isolated_cache()

      assert GrantCache.get_permissions("a_1", "g_nonexistent", ctx.table) == nil
    end

    test "returns nil gracefully when table not found" do
      with_isolated_cache()

      assert GrantCache.get_permissions("a_1", "g_1", []) == nil
    end
  end

  describe "delete_grant/2" do
    test "removes group membership entry from every table" do
      ctx = with_isolated_cache()

      :ok =
        GrantCache.put_grant(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          cache_opts(ctx)
        )

      assert GrantCache.get_actor_groups("a_1", ctx.table) != []
      assert GrantCache.get_grant("gm_1", ctx.by_id) != nil
      assert GrantCache.grant_ids("g_1", ctx.by_group) == ["gm_1"]

      :ok = GrantCache.delete_grant("gm_1", cache_opts(ctx))

      assert GrantCache.get_actor_groups("a_1", ctx.table) == []
      assert GrantCache.get_grant("gm_1", ctx.by_id) == nil
      assert GrantCache.grant_ids("g_1", ctx.by_group) == []
    end
  end

  describe "grant_ids/2" do
    test "enumerates every member row scoping to a group" do
      ctx = with_isolated_cache()

      for {id, group_id} <- [{"gm_1", "g_1"}, {"gm_2", "g_1"}, {"gm_3", "g_2"}] do
        :ok =
          GrantCache.put_grant(
            %{id: id, actor_id: "a_1", group_id: group_id, permissions: ["todo.create"]},
            cache_opts(ctx)
          )
      end

      assert Enum.sort(GrantCache.grant_ids("g_1", ctx.by_group)) == ["gm_1", "gm_2"]
      assert GrantCache.grant_ids("g_2", ctx.by_group) == ["gm_3"]
      assert GrantCache.grant_ids("unknown", ctx.by_group) == []
    end

    test "a re-put that moves a row drops the stale by-group entry" do
      ctx = with_isolated_cache()

      :ok =
        GrantCache.put_grant(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          cache_opts(ctx)
        )

      :ok =
        GrantCache.put_grant(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_2", permissions: ["todo.create"]},
          cache_opts(ctx)
        )

      assert GrantCache.grant_ids("g_1", ctx.by_group) == []
      assert GrantCache.grant_ids("g_2", ctx.by_group) == ["gm_1"]
    end
  end

  describe "instance isolation" do
    test "a put through one cache's tables leaves the other cache's indexes untouched" do
      cache_a = with_isolated_cache()
      # Starting B afterwards publishes B's tables last, the state that used
      # to route A's secondary indexes into B.
      cache_b = with_isolated_cache()

      :ok =
        GrantCache.put_grant(
          %{id: "gm_iso", actor_id: "a_1", group_id: "g_1", permissions: ["todo.read"]},
          cache_opts(cache_a)
        )

      assert GrantCache.get_actor_groups("a_1", cache_a.table) != []
      assert GrantCache.get_grant("gm_iso", cache_a.by_id) != nil
      assert GrantCache.grant_ids("g_1", cache_a.by_group) == ["gm_iso"]

      assert GrantCache.get_actor_groups("a_1", cache_b.table) == []
      assert GrantCache.get_grant("gm_iso", cache_b.by_id) == nil
      assert GrantCache.grant_ids("g_1", cache_b.by_group) == []
    end
  end
end
