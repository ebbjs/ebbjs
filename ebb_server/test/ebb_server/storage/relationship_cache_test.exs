defmodule EbbServer.Storage.RelationshipCacheTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.RelationshipCache

  defp with_isolated_cache do
    rel_name = :"test_rel_#{System.unique_integer([:positive])}"
    rbi_name = :"test_rbi_#{System.unique_integer([:positive])}"
    cache_name = :"test_rc_#{System.unique_integer([:positive])}"

    {:ok, _pid} =
      RelationshipCache.start_link(
        name: cache_name,
        relationships: rel_name,
        relationships_by_id: rbi_name
      )

    on_exit(fn ->
      RelationshipCache.reset(
        relationships: rel_name,
        relationships_by_id: rbi_name
      )
    end)

    %{
      relationships: rel_name,
      relationships_by_id: rbi_name,
      cache_name: cache_name
    }
  end

  defp put(cache, rel) do
    RelationshipCache.put_relationship(rel,
      relationships: cache.relationships,
      relationships_by_id: cache.relationships_by_id
    )
  end

  defp edge(source_id, target_id, id) do
    %{
      id: id,
      source_id: source_id,
      target_id: target_id,
      type: "todo",
      field: "owns"
    }
  end

  describe "put_relationship/2" do
    test "stores relationship entry" do
      cache = with_isolated_cache()

      :ok = put(cache, edge("todo_1", "g_1", "rel_1"))

      entry = RelationshipCache.get_relationship("rel_1", cache.relationships_by_id)
      assert entry.source_id == "todo_1"
      assert entry.target_id == "g_1"
    end

    test "rejects nil values" do
      cache = with_isolated_cache()

      assert {:error, :nil_values_not_allowed} =
               put(cache, %{id: nil, source_id: "todo_1", target_id: "g_1"})
    end

    test "a re-put replaces the prior entry" do
      cache = with_isolated_cache()

      :ok = put(cache, edge("todo_1", "g_1", "rel_1"))
      :ok = put(cache, edge("todo_1", "g_2", "rel_1"))

      assert RelationshipCache.get_relationship("rel_1", cache.relationships_by_id).target_id ==
               "g_2"

      assert [{"todo_1", %{target_id: "g_2"}}] = :ets.lookup(cache.relationships, "todo_1")
    end
  end

  describe "delete_relationship/2" do
    test "removes the relationship from both tables" do
      cache = with_isolated_cache()

      :ok = put(cache, edge("todo_1", "g_1", "rel_1"))

      assert RelationshipCache.get_relationship("rel_1", cache.relationships_by_id).target_id ==
               "g_1"

      :ok =
        RelationshipCache.delete_relationship("rel_1",
          relationships: cache.relationships,
          relationships_by_id: cache.relationships_by_id
        )

      assert RelationshipCache.get_relationship("rel_1", cache.relationships_by_id) == nil
      assert :ets.lookup(cache.relationships, "todo_1") == []
    end

    test "removes only the deleted edge when a source has several" do
      cache = with_isolated_cache()

      :ok = put(cache, edge("todo_1", "g_1", "rel_1"))
      :ok = put(cache, edge("todo_1", "g_2", "rel_2"))

      :ok =
        RelationshipCache.delete_relationship("rel_1",
          relationships: cache.relationships,
          relationships_by_id: cache.relationships_by_id
        )

      assert RelationshipCache.get_relationship("rel_2", cache.relationships_by_id) != nil
      assert length(:ets.lookup(cache.relationships, "todo_1")) == 1
    end
  end

  describe "get_relationship/2" do
    test "returns relationship entry by id" do
      cache = with_isolated_cache()

      :ok = put(cache, edge("todo_1", "g_1", "rel_1"))

      entry = RelationshipCache.get_relationship("rel_1", cache.relationships_by_id)
      assert entry.id == "rel_1"
      assert entry.source_id == "todo_1"
      assert entry.target_id == "g_1"
      assert entry.type == "todo"
      assert entry.field == "owns"
    end

    test "returns nil for unknown id" do
      cache = with_isolated_cache()

      assert RelationshipCache.get_relationship("unknown", cache.relationships_by_id) == nil
    end
  end

  describe "reset/1" do
    test "clears all relationships" do
      cache = with_isolated_cache()

      :ok = put(cache, edge("todo_1", "g_1", "rel_1"))

      :ok =
        RelationshipCache.reset(
          relationships: cache.relationships,
          relationships_by_id: cache.relationships_by_id
        )

      assert RelationshipCache.get_relationship("rel_1", cache.relationships_by_id) == nil
      assert :ets.lookup(cache.relationships, "todo_1") == []
    end
  end
end
