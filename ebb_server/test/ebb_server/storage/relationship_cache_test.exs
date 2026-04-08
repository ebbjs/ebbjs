defmodule EbbServer.Storage.RelationshipCacheTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.RelationshipCache

  defp with_isolated_cache do
    rel_name = :"test_rel_#{System.unique_integer([:positive])}"
    rbg_name = :"test_rbg_#{System.unique_integer([:positive])}"
    cache_name = :"test_rc_#{System.unique_integer([:positive])}"

    {:ok, _pid} =
      RelationshipCache.start_link(
        name: cache_name,
        relationships: rel_name,
        relationships_by_group: rbg_name
      )

    on_exit(fn ->
      RelationshipCache.reset(relationships: rel_name, relationships_by_group: rbg_name)
    end)

    %{relationships: rel_name, relationships_by_group: rbg_name, cache_name: cache_name}
  end

  describe "put_relationship/2" do
    test "stores relationship entry" do
      %{relationships: rel, relationships_by_group: rbg} = with_isolated_cache()

      :ok =
        RelationshipCache.put_relationship(
          %{id: "rel_1", source_id: "todo_1", target_id: "g_1", type: "todo", field: "group"},
          relationships: rel,
          relationships_by_group: rbg
        )

      assert RelationshipCache.get_entity_group("todo_1", rel) == "g_1"
    end

    test "rejects nil values" do
      %{relationships: rel, relationships_by_group: rbg} = with_isolated_cache()

      assert {:error, :nil_values_not_allowed} =
               RelationshipCache.put_relationship(
                 %{id: nil, source_id: "todo_1", target_id: "g_1"},
                 relationships: rel,
                 relationships_by_group: rbg
               )
    end
  end

  describe "get_entity_group/2" do
    test "returns group ID for entity" do
      %{relationships: rel, relationships_by_group: rbg} = with_isolated_cache()

      :ok =
        RelationshipCache.put_relationship(
          %{id: "rel_1", source_id: "todo_1", target_id: "g_1", type: "todo", field: "group"},
          relationships: rel,
          relationships_by_group: rbg
        )

      assert RelationshipCache.get_entity_group("todo_1", rel) == "g_1"
    end

    test "returns nil for unknown entity" do
      %{relationships: rel} = with_isolated_cache()

      assert RelationshipCache.get_entity_group("unknown", rel) == nil
    end
  end

  describe "get_group_entities/2" do
    test "returns all entities in group" do
      %{relationships: rel, relationships_by_group: rbg} = with_isolated_cache()

      :ok =
        RelationshipCache.put_relationship(
          %{id: "rel_1", source_id: "todo_1", target_id: "g_1", type: "todo", field: "group"},
          relationships: rel,
          relationships_by_group: rbg
        )

      :ok =
        RelationshipCache.put_relationship(
          %{id: "rel_2", source_id: "todo_2", target_id: "g_1", type: "todo", field: "group"},
          relationships: rel,
          relationships_by_group: rbg
        )

      entities = RelationshipCache.get_group_entities("g_1", rbg)
      assert length(entities) == 2
      assert "todo_1" in entities
      assert "todo_2" in entities
    end
  end

  describe "delete_relationship/2" do
    test "removes relationship from both tables" do
      %{relationships: rel, relationships_by_group: rbg} = with_isolated_cache()

      :ok =
        RelationshipCache.put_relationship(
          %{id: "rel_1", source_id: "todo_1", target_id: "g_1", type: "todo", field: "group"},
          relationships: rel,
          relationships_by_group: rbg
        )

      assert RelationshipCache.get_entity_group("todo_1", rel) == "g_1"

      :ok =
        RelationshipCache.delete_relationship(
          "rel_1",
          relationships: rel,
          relationships_by_group: rbg
        )

      assert RelationshipCache.get_entity_group("todo_1", rel) == nil
      assert RelationshipCache.get_group_entities("g_1", rbg) == []
    end
  end

  describe "reset/1" do
    test "clears all relationships" do
      %{relationships: rel, relationships_by_group: rbg} = with_isolated_cache()

      :ok =
        RelationshipCache.put_relationship(
          %{id: "rel_1", source_id: "todo_1", target_id: "g_1", type: "todo", field: "group"},
          relationships: rel,
          relationships_by_group: rbg
        )

      :ok = RelationshipCache.reset(relationships: rel, relationships_by_group: rbg)

      assert RelationshipCache.get_entity_group("todo_1", rel) == nil
      assert RelationshipCache.get_group_entities("g_1", rbg) == []
    end
  end
end
