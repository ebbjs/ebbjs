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

  defp leaf(value, hlc \\ 1, update_id \\ "u1") do
    %{"value" => value, "hlc" => hlc, "update_id" => update_id}
  end

  defp apps_field(entries) do
    %{"map" => Map.new(entries, fn {app_id, value} -> {app_id, leaf(value)} end)}
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

    test "a present but empty map is an empty set" do
      cache = with_isolated_cache()

      :ok =
        GroupAppsCache.put_group_apps("g_empty", %{"map" => %{}}, group_apps: cache.table)

      assert GroupAppsCache.get_apps("g_empty", cache.table) == MapSet.new()
    end

    test "an unexpected field shape reads as unscoped and warns" do
      cache = with_isolated_cache()

      log =
        capture_log(fn ->
          :ok =
            GroupAppsCache.put_group_apps("g_malformed", %{"value" => true},
              group_apps: cache.table
            )
        end)

      assert log =~ "group apps field is not a map"
      assert GroupAppsCache.get_apps("g_malformed", cache.table) == :unscoped
    end

    test "projects only app ids whose leaf value is exactly true" do
      cache = with_isolated_cache()

      field = %{
        "map" => %{
          "notes" => leaf(true),
          "issues" => leaf(false),
          "docs" => leaf(nil),
          "chat" => leaf("true"),
          "mail" => leaf(true, 2, "u2")
        }
      }

      :ok = GroupAppsCache.put_group_apps("g_mixed", field, group_apps: cache.table)

      assert GroupAppsCache.get_apps("g_mixed", cache.table) == MapSet.new(["notes", "mail"])
    end
  end

  describe "get_field/2" do
    test "returns the raw stored field for a later merge" do
      cache = with_isolated_cache()
      field = apps_field(%{"notes" => true, "issues" => false})

      :ok = GroupAppsCache.put_group_apps("g_raw", field, group_apps: cache.table)

      assert GroupAppsCache.get_field("g_raw", cache.table) == field
    end

    test "returns nil for an absent entry and for an unscoped field" do
      cache = with_isolated_cache()

      assert GroupAppsCache.get_field("g_missing", cache.table) == nil

      :ok = GroupAppsCache.put_group_apps("g_unscoped", nil, group_apps: cache.table)
      assert GroupAppsCache.get_field("g_unscoped", cache.table) == nil
    end
  end

  describe "delete_group_apps/2" do
    test "removes the stored field and projection" do
      cache = with_isolated_cache()

      :ok =
        GroupAppsCache.put_group_apps("g_1", apps_field(%{"notes" => true}),
          group_apps: cache.table
        )

      :ok = GroupAppsCache.delete_group_apps("g_1", group_apps: cache.table)

      assert GroupAppsCache.get_apps("g_1", cache.table) == :unscoped
      assert GroupAppsCache.get_field("g_1", cache.table) == nil
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
        GroupAppsCache.put_group_apps("g_1", apps_field(%{"notes" => true}),
          group_apps: cache.table
        )

      :ok = GroupAppsCache.reset(group_apps: cache.table)

      assert GroupAppsCache.get_apps("g_1", cache.table) == :unscoped
      assert :ets.info(cache.table, :size) == 0
    end
  end
end
