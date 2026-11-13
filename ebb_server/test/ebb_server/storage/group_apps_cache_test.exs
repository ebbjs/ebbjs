defmodule EbbServer.Storage.GroupAppsCacheTest do
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias EbbServer.Storage.GroupAppsCache

  defp with_isolated_cache do
    table = :"test_group_apps_#{System.unique_integer([:positive])}"
    cache_name = :"test_gac_#{System.unique_integer([:positive])}"

    {:ok, _pid} = GroupAppsCache.start_link(name: cache_name, group_apps: table)
    on_exit(fn -> GroupAppsCache.reset(group_apps: table) end)

    %{table: table, cache_name: cache_name}
  end

  describe "get_apps/2" do
    test "an absent entry is unscoped" do
      cache = with_isolated_cache()

      assert GroupAppsCache.get_apps("g_missing", cache.table) == :unscoped
    end

    test "a nil field is unscoped, not an empty scope" do
      cache = with_isolated_cache()

      :ok = GroupAppsCache.put_group_apps("g_unscoped", nil, group_apps: cache.table)

      assert GroupAppsCache.get_apps("g_unscoped", cache.table) == :unscoped
    end

    test "an empty list is an empty set, distinct from unscoped" do
      cache = with_isolated_cache()

      :ok = GroupAppsCache.put_group_apps("g_empty", [], group_apps: cache.table)

      assert GroupAppsCache.get_apps("g_empty", cache.table) == MapSet.new()
    end

    test "an unexpected shape reads as unscoped and warns" do
      cache = with_isolated_cache()

      log =
        capture_log(fn ->
          :ok =
            GroupAppsCache.put_group_apps("g_malformed", %{"value" => true},
              group_apps: cache.table
            )
        end)

      assert log =~ "group apps value is not a list"
      assert GroupAppsCache.get_apps("g_malformed", cache.table) == :unscoped
    end

    test "projects the app ids the group names" do
      cache = with_isolated_cache()

      :ok = GroupAppsCache.put_group_apps("g_mixed", ["notes", "mail"], group_apps: cache.table)

      assert GroupAppsCache.get_apps("g_mixed", cache.table) == MapSet.new(["notes", "mail"])
    end
  end

  describe "delete_group_apps/2" do
    test "removes the stored scope" do
      cache = with_isolated_cache()

      :ok =
        GroupAppsCache.put_group_apps("g_1", ["notes"], group_apps: cache.table)

      :ok = GroupAppsCache.delete_group_apps("g_1", group_apps: cache.table)

      assert GroupAppsCache.get_apps("g_1", cache.table) == :unscoped
      refute GroupAppsCache.known?("g_1", cache.table)
    end

    test "is a no-op for an unknown group" do
      cache = with_isolated_cache()

      assert :ok = GroupAppsCache.delete_group_apps("unknown", group_apps: cache.table)
    end
  end

  describe "reset/1" do
    test "clears every group's scope" do
      cache = with_isolated_cache()

      :ok =
        GroupAppsCache.put_group_apps("g_1", ["notes"], group_apps: cache.table)

      :ok = GroupAppsCache.reset(group_apps: cache.table)

      assert GroupAppsCache.get_apps("g_1", cache.table) == :unscoped
      assert :ets.info(cache.table, :size) == 0
    end
  end
end
