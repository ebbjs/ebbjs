defmodule EbbServer.Storage.EntityGroupCacheTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.EntityGroupCache

  defp with_isolated_cache do
    table = :"test_eg_#{System.unique_integer([:positive])}"
    by_id = :"test_eg_by_id_#{System.unique_integer([:positive])}"
    by_group = :"test_eg_by_group_#{System.unique_integer([:positive])}"
    cache_name = :"test_egc_#{System.unique_integer([:positive])}"

    {:ok, _pid} =
      EntityGroupCache.start_link(
        name: cache_name,
        entity_groups: table,
        entity_groups_by_id: by_id,
        entity_groups_by_group: by_group
      )

    on_exit(fn ->
      EntityGroupCache.reset(
        entity_groups: table,
        entity_groups_by_id: by_id,
        entity_groups_by_group: by_group
      )
    end)

    %{table: table, by_id: by_id, by_group: by_group, cache_name: cache_name}
  end

  defp opts(cache) do
    [
      entity_groups: cache.table,
      entity_groups_by_id: cache.by_id,
      entity_groups_by_group: cache.by_group
    ]
  end

  describe "put_entity_group/2" do
    test "stores a membership entry addressable by entity, id, and group" do
      cache = with_isolated_cache()

      :ok =
        EntityGroupCache.put_entity_group(
          %{id: "eg_1", entity_id: "todo_1", group_id: "g_1"},
          opts(cache)
        )

      assert EntityGroupCache.entity_groups("todo_1", cache.table) == ["g_1"]
      assert EntityGroupCache.get_entity_group("eg_1", cache.by_id).group_id == "g_1"
      assert EntityGroupCache.group_entities("g_1", cache.by_group) == ["todo_1"]
    end

    test "accepts string keys" do
      cache = with_isolated_cache()

      :ok =
        EntityGroupCache.put_entity_group(
          %{"id" => "eg_1", "entity_id" => "todo_1", "group_id" => "g_1"},
          opts(cache)
        )

      assert EntityGroupCache.entity_groups("todo_1", cache.table) == ["g_1"]
    end

    test "rejects nil values" do
      cache = with_isolated_cache()

      assert {:error, :nil_values_not_allowed} =
               EntityGroupCache.put_entity_group(
                 %{id: nil, entity_id: "todo_1", group_id: "g_1"},
                 opts(cache)
               )

      assert {:error, :nil_values_not_allowed} =
               EntityGroupCache.put_entity_group(
                 %{id: "eg_1", entity_id: nil, group_id: "g_1"},
                 opts(cache)
               )
    end

    test "a re-put of the same id replaces the prior group" do
      cache = with_isolated_cache()

      :ok =
        EntityGroupCache.put_entity_group(
          %{id: "eg_1", entity_id: "todo_1", group_id: "g_1"},
          opts(cache)
        )

      :ok =
        EntityGroupCache.put_entity_group(
          %{id: "eg_1", entity_id: "todo_1", group_id: "g_2"},
          opts(cache)
        )

      assert EntityGroupCache.entity_groups("todo_1", cache.table) == ["g_2"]
      assert EntityGroupCache.group_entities("g_1", cache.by_group) == []
    end

    test "returns every group for a multi-membership entity" do
      cache = with_isolated_cache()

      for {id, group} <- [{"eg_1", "g_1"}, {"eg_2", "g_2"}] do
        :ok =
          EntityGroupCache.put_entity_group(
            %{id: id, entity_id: "todo_1", group_id: group},
            opts(cache)
          )
      end

      assert EntityGroupCache.entity_groups("todo_1", cache.table) |> Enum.sort() == [
               "g_1",
               "g_2"
             ]
    end
  end

  describe "get_entity_group/2" do
    test "returns nil for unknown id" do
      cache = with_isolated_cache()

      assert EntityGroupCache.get_entity_group("unknown", cache.by_id) == nil
    end
  end

  describe "delete_entity_group/2" do
    test "removes the membership from all tables" do
      cache = with_isolated_cache()

      :ok =
        EntityGroupCache.put_entity_group(
          %{id: "eg_1", entity_id: "todo_1", group_id: "g_1"},
          opts(cache)
        )

      :ok = EntityGroupCache.delete_entity_group("eg_1", opts(cache))

      assert EntityGroupCache.entity_groups("todo_1", cache.table) == []
      assert EntityGroupCache.get_entity_group("eg_1", cache.by_id) == nil
      assert EntityGroupCache.group_entities("g_1", cache.by_group) == []
    end

    test "is a no-op for an unknown id" do
      cache = with_isolated_cache()

      assert :ok = EntityGroupCache.delete_entity_group("unknown", opts(cache))
    end
  end
end
