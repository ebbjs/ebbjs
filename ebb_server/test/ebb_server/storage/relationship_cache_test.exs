defmodule EbbServer.Storage.RelationshipCacheTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.RelationshipCache
  alias EbbServer.Storage.SQLite

  defp with_isolated_cache do
    rel_name = :"test_rel_#{System.unique_integer([:positive])}"
    rbg_name = :"test_rbg_#{System.unique_integer([:positive])}"
    rbi_name = :"test_rbi_#{System.unique_integer([:positive])}"
    cache_name = :"test_rc_#{System.unique_integer([:positive])}"

    {:ok, _pid} =
      RelationshipCache.start_link(
        name: cache_name,
        relationships: rel_name,
        relationships_by_group: rbg_name,
        relationships_by_id: rbi_name
      )

    on_exit(fn ->
      RelationshipCache.reset(
        relationships: rel_name,
        relationships_by_group: rbg_name,
        relationships_by_id: rbi_name
      )
    end)

    %{
      relationships: rel_name,
      relationships_by_group: rbg_name,
      relationships_by_id: rbi_name,
      cache_name: cache_name
    }
  end

  defp put(cache, rel) do
    RelationshipCache.put_relationship(rel,
      relationships: cache.relationships,
      relationships_by_group: cache.relationships_by_group,
      relationships_by_id: cache.relationships_by_id
    )
  end

  defp member(source_id, target_id, id) do
    %{
      id: id,
      source_id: source_id,
      target_id: target_id,
      type: "todo",
      field: "group",
      kind: "member"
    }
  end

  defp link(source_id, target_id, id) do
    %{
      id: id,
      source_id: source_id,
      target_id: target_id,
      type: "todo",
      field: "owns",
      kind: "link"
    }
  end

  describe "put_relationship/2" do
    test "stores relationship entry" do
      cache = with_isolated_cache()

      :ok = put(cache, member("todo_1", "g_1", "rel_1"))

      assert RelationshipCache.get_entity_group("todo_1", cache.relationships) == "g_1"
    end

    test "defaults a missing kind to link" do
      cache = with_isolated_cache()

      :ok =
        put(cache, %{
          id: "rel_1",
          source_id: "todo_1",
          target_id: "g_1",
          type: "todo",
          field: "group"
        })

      assert RelationshipCache.membership_groups("todo_1", cache.relationships) == []
    end

    test "rejects nil values" do
      cache = with_isolated_cache()

      assert {:error, :nil_values_not_allowed} =
               put(cache, %{id: nil, source_id: "todo_1", target_id: "g_1"})
    end

    test "a re-put replaces the prior entry and its group index row" do
      cache = with_isolated_cache()

      :ok = put(cache, member("todo_1", "g_1", "rel_1"))
      :ok = put(cache, member("todo_1", "g_2", "rel_1"))

      assert RelationshipCache.membership_groups("todo_1", cache.relationships) == ["g_2"]

      assert RelationshipCache.get_relationship("rel_1", cache.relationships_by_id).target_id ==
               "g_2"

      assert RelationshipCache.get_group_entities("g_1", cache.relationships_by_group) == []

      assert RelationshipCache.get_group_entities("g_2", cache.relationships_by_group) == [
               "todo_1"
             ]
    end
  end

  describe "membership_groups/2" do
    test "returns only kind member targets, unioned and deduplicated" do
      cache = with_isolated_cache()

      :ok = put(cache, member("todo_1", "g_1", "rel_1"))
      :ok = put(cache, member("todo_1", "g_2", "rel_2"))
      :ok = put(cache, member("todo_1", "g_1", "rel_3"))

      :ok =
        put(cache, %{
          id: "rel_link",
          source_id: "todo_1",
          target_id: "g_3",
          type: "todo",
          field: "owns",
          kind: "link"
        })

      assert RelationshipCache.membership_groups("todo_1", cache.relationships) |> Enum.sort() ==
               ["g_1", "g_2"]
    end

    test "returns an empty list for an unknown source" do
      cache = with_isolated_cache()

      assert RelationshipCache.membership_groups("unknown", cache.relationships) == []
    end
  end

  describe "get_entity_group/2" do
    test "returns a group for a member edge" do
      cache = with_isolated_cache()

      :ok = put(cache, member("todo_1", "g_1", "rel_1"))

      assert RelationshipCache.get_entity_group("todo_1", cache.relationships) == "g_1"
    end

    test "returns nil for a link-only source" do
      cache = with_isolated_cache()

      :ok =
        put(cache, %{
          id: "rel_1",
          source_id: "todo_1",
          target_id: "col_1",
          type: "todo",
          field: "column",
          kind: "link"
        })

      assert RelationshipCache.get_entity_group("todo_1", cache.relationships) == nil
    end

    test "returns nil for unknown entity" do
      cache = with_isolated_cache()

      assert RelationshipCache.get_entity_group("unknown", cache.relationships) == nil
    end
  end

  describe "get_group_entities/2" do
    test "returns all entities in group" do
      cache = with_isolated_cache()

      :ok = put(cache, member("todo_1", "g_1", "rel_1"))
      :ok = put(cache, member("todo_2", "g_1", "rel_2"))

      entities = RelationshipCache.get_group_entities("g_1", cache.relationships_by_group)
      assert length(entities) == 2
      assert "todo_1" in entities
      assert "todo_2" in entities
    end

    test "excludes domain links to the group" do
      cache = with_isolated_cache()

      :ok = put(cache, member("todo_1", "g_1", "rel_1"))

      :ok =
        put(cache, %{
          id: "rel_link",
          source_id: "todo_link",
          target_id: "g_1",
          type: "todo",
          field: "owns",
          kind: "link"
        })

      assert RelationshipCache.get_group_entities("g_1", cache.relationships_by_group) == [
               "todo_1"
             ]
    end

    test "a re-put from member to link drops the group index row" do
      cache = with_isolated_cache()

      :ok = put(cache, member("todo_1", "g_1", "rel_1"))

      :ok =
        put(cache, %{
          id: "rel_1",
          source_id: "todo_1",
          target_id: "g_1",
          type: "todo",
          field: "owns",
          kind: "link"
        })

      assert RelationshipCache.get_group_entities("g_1", cache.relationships_by_group) == []
    end
  end

  describe "delete_relationship/2" do
    test "removes relationship from all three tables" do
      cache = with_isolated_cache()

      :ok = put(cache, member("todo_1", "g_1", "rel_1"))

      assert RelationshipCache.get_entity_group("todo_1", cache.relationships) == "g_1"

      assert RelationshipCache.get_relationship("rel_1", cache.relationships_by_id).target_id ==
               "g_1"

      :ok =
        RelationshipCache.delete_relationship("rel_1",
          relationships: cache.relationships,
          relationships_by_group: cache.relationships_by_group,
          relationships_by_id: cache.relationships_by_id
        )

      assert RelationshipCache.get_entity_group("todo_1", cache.relationships) == nil
      assert RelationshipCache.get_group_entities("g_1", cache.relationships_by_group) == []
      assert RelationshipCache.get_relationship("rel_1", cache.relationships_by_id) == nil
    end

    test "removes only the deleted edge when a source has several" do
      cache = with_isolated_cache()

      :ok = put(cache, member("todo_1", "g_1", "rel_1"))
      :ok = put(cache, member("todo_1", "g_2", "rel_2"))

      :ok =
        RelationshipCache.delete_relationship("rel_1",
          relationships: cache.relationships,
          relationships_by_group: cache.relationships_by_group,
          relationships_by_id: cache.relationships_by_id
        )

      assert RelationshipCache.membership_groups("todo_1", cache.relationships) == ["g_2"]
      assert RelationshipCache.get_group_entities("g_1", cache.relationships_by_group) == []

      assert RelationshipCache.get_group_entities("g_2", cache.relationships_by_group) == [
               "todo_1"
             ]
    end

    test "deleting a link edge keeps the group index row its member edge shares" do
      cache = with_isolated_cache()

      :ok = put(cache, member("todo_1", "g_1", "rel_member"))
      :ok = put(cache, link("todo_1", "g_1", "rel_link"))

      assert RelationshipCache.get_group_entities("g_1", cache.relationships_by_group) == [
               "todo_1"
             ]

      :ok =
        RelationshipCache.delete_relationship("rel_link",
          relationships: cache.relationships,
          relationships_by_group: cache.relationships_by_group,
          relationships_by_id: cache.relationships_by_id
        )

      assert RelationshipCache.get_group_entities("g_1", cache.relationships_by_group) == [
               "todo_1"
             ]

      assert RelationshipCache.membership_groups("todo_1", cache.relationships) == ["g_1"]
    end

    test "deleting the last member edge drops the group index row" do
      cache = with_isolated_cache()

      :ok = put(cache, member("todo_1", "g_1", "rel_member"))
      :ok = put(cache, link("todo_1", "g_1", "rel_link"))

      :ok =
        RelationshipCache.delete_relationship("rel_member",
          relationships: cache.relationships,
          relationships_by_group: cache.relationships_by_group,
          relationships_by_id: cache.relationships_by_id
        )

      assert RelationshipCache.get_group_entities("g_1", cache.relationships_by_group) == []
      assert RelationshipCache.membership_groups("todo_1", cache.relationships) == []
    end

    test "deleting one of two member edges to a group keeps the index row" do
      cache = with_isolated_cache()

      :ok = put(cache, member("todo_1", "g_1", "rel_1"))
      :ok = put(cache, member("todo_1", "g_1", "rel_2"))

      :ok =
        RelationshipCache.delete_relationship("rel_1",
          relationships: cache.relationships,
          relationships_by_group: cache.relationships_by_group,
          relationships_by_id: cache.relationships_by_id
        )

      assert RelationshipCache.get_group_entities("g_1", cache.relationships_by_group) == [
               "todo_1"
             ]

      assert RelationshipCache.membership_groups("todo_1", cache.relationships) == ["g_1"]
    end
  end

  describe "get_relationship/2" do
    test "returns relationship entry by id" do
      cache = with_isolated_cache()

      :ok = put(cache, member("todo_1", "g_1", "rel_1"))

      entry = RelationshipCache.get_relationship("rel_1", cache.relationships_by_id)
      assert entry.id == "rel_1"
      assert entry.source_id == "todo_1"
      assert entry.target_id == "g_1"
      assert entry.type == "todo"
      assert entry.field == "group"
      assert entry.kind == "member"
    end

    test "returns nil for unknown id" do
      cache = with_isolated_cache()

      assert RelationshipCache.get_relationship("unknown", cache.relationships_by_id) == nil
    end
  end

  describe "reset/1" do
    test "clears all relationships" do
      cache = with_isolated_cache()

      :ok = put(cache, member("todo_1", "g_1", "rel_1"))

      :ok =
        RelationshipCache.reset(
          relationships: cache.relationships,
          relationships_by_group: cache.relationships_by_group,
          relationships_by_id: cache.relationships_by_id
        )

      assert RelationshipCache.get_entity_group("todo_1", cache.relationships) == nil
      assert RelationshipCache.get_group_entities("g_1", cache.relationships_by_group) == []
      assert RelationshipCache.get_relationship("rel_1", cache.relationships_by_id) == nil
    end
  end

  describe "member_kind/0" do
    test "matches the kind literal used by the SQL membership predicate" do
      assert SQLite.membership_kind() == RelationshipCache.member_kind()
    end
  end
end
