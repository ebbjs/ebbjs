defmodule EbbServer.Storage.EntityIndexTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.EntityIndex
  alias EbbServer.Storage.GroupCache
  alias EbbServer.Storage.RelationshipCache

  defp tables do
    rel = :"ei_rel_#{System.unique_integer([:positive])}"
    rbi = :"ei_rbi_#{System.unique_integer([:positive])}"
    gm = :"ei_gm_#{System.unique_integer([:positive])}"
    gm_by_id = :"ei_gmbi_#{System.unique_integer([:positive])}"
    rbg = :"ei_rbg_#{System.unique_integer([:positive])}"

    {:ok, _} =
      RelationshipCache.start_link(
        name: :"ei_rc_#{System.unique_integer([:positive])}",
        relationships: rel,
        relationships_by_group: rbg,
        relationships_by_id: rbi
      )

    {:ok, _} =
      GroupCache.start_link(
        name: :"ei_gc_#{System.unique_integer([:positive])}",
        table: gm,
        group_members_by_id: gm_by_id
      )

    on_exit(fn ->
      RelationshipCache.reset(
        relationships: rel,
        relationships_by_group: rbg,
        relationships_by_id: rbi
      )

      GroupCache.reset(gm)

      for t <- [rel, rbi, rbg, gm, gm_by_id] do
        try do
          :ets.delete(t)
        rescue
          _ -> :ok
        end
      end
    end)

    %{
      relationships: rel,
      relationships_by_id: rbi,
      group_members: gm,
      group_members_by_id: gm_by_id,
      relationships_by_group: rbg
    }
  end

  describe "resolve_group/3" do
    test "returns group id for a group subject type" do
      _ = tables()
      assert EntityIndex.resolve_group("group", "g_1") == "g_1"
    end

    test "resolves a relationship subject via the by-id table" do
      t = tables()

      :ok =
        RelationshipCache.put_relationship(
          %{
            id: "rel_1",
            source_id: "todo_1",
            target_id: "g_1",
            type: "todo",
            field: "group"
          },
          relationships: t.relationships,
          relationships_by_group: t.relationships_by_group,
          relationships_by_id: t.relationships_by_id
        )

      assert EntityIndex.resolve_group("relationship", "rel_1",
               relationships_by_id: t.relationships_by_id
             ) == "g_1"
    end

    test "resolves a groupMember subject via the by-id table" do
      t = tables()

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          t.group_members
        )

      assert EntityIndex.resolve_group("groupMember", "gm_1",
               group_members_by_id: t.group_members_by_id
             ) == "g_1"
    end

    test "resolves a user entity via the relationships table" do
      t = tables()

      :ok =
        RelationshipCache.put_relationship(
          %{
            id: "rel_1",
            source_id: "todo_1",
            target_id: "g_1",
            type: "todo",
            field: "group"
          },
          relationships: t.relationships,
          relationships_by_group: t.relationships_by_group,
          relationships_by_id: t.relationships_by_id
        )

      assert EntityIndex.resolve_group("todo", "todo_1", relationships: t.relationships) == "g_1"
    end

    test "returns nil when the entity isn't in the index" do
      t = tables()

      assert EntityIndex.resolve_group("relationship", "rel_unknown",
               relationships_by_id: t.relationships_by_id
             ) == nil

      assert EntityIndex.resolve_group("groupMember", "gm_unknown",
               group_members_by_id: t.group_members_by_id
             ) == nil

      assert EntityIndex.resolve_group("todo", "todo_unknown", relationships: t.relationships) ==
               nil
    end

    test "raises when a required table is missing from opts" do
      _t = tables()

      assert_raise KeyError, fn ->
        EntityIndex.resolve_group("relationship", "rel_1", [])
      end

      assert_raise KeyError, fn ->
        EntityIndex.resolve_group("groupMember", "gm_1", [])
      end
    end
  end
end
