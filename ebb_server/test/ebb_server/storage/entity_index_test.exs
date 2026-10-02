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

  defp opts(t) do
    [
      relationships: t.relationships,
      relationships_by_id: t.relationships_by_id,
      group_members_by_id: t.group_members_by_id
    ]
  end

  defp put_rel(t, rel) do
    RelationshipCache.put_relationship(rel,
      relationships: t.relationships,
      relationships_by_group: t.relationships_by_group,
      relationships_by_id: t.relationships_by_id
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

  describe "resolve_groups/3" do
    test "returns the group id for a group subject type" do
      _ = tables()
      assert EntityIndex.resolve_groups("group", "g_1") == ["g_1"]
    end

    test "resolves a relationship subject via its source's membership set" do
      t = tables()

      :ok = put_rel(t, member("todo_1", "g_1", "rel_member"))

      :ok =
        put_rel(t, %{
          id: "rel_link",
          source_id: "todo_1",
          target_id: "col_1",
          type: "todo",
          field: "column",
          kind: "link"
        })

      assert EntityIndex.resolve_groups("relationship", "rel_link", opts(t)) == ["g_1"]
    end

    test "resolves a groupMember subject via the by-id table" do
      t = tables()

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          t.group_members
        )

      assert EntityIndex.resolve_groups("groupMember", "gm_1", opts(t)) == ["g_1"]
    end

    test "returns every group for a multi-membership source" do
      t = tables()

      :ok = put_rel(t, member("todo_1", "g_1", "rel_1"))
      :ok = put_rel(t, member("todo_1", "g_2", "rel_2"))

      assert EntityIndex.resolve_groups("todo", "todo_1", opts(t)) |> Enum.sort() == [
               "g_1",
               "g_2"
             ]
    end

    test "unions cached membership with intra-action membership" do
      t = tables()

      :ok = put_rel(t, member("todo_1", "g_1", "rel_1"))

      assert EntityIndex.resolve_groups(
               "todo",
               "todo_1",
               opts(t) ++ [intra_action: %{"todo_1" => ["g_2"]}]
             )
             |> Enum.sort() == ["g_1", "g_2"]
    end

    test "a link target is not treated as a group" do
      t = tables()

      :ok =
        put_rel(t, %{
          id: "rel_link",
          source_id: "todo_1",
          target_id: "g_1",
          type: "todo",
          field: "owns",
          kind: "link"
        })

      assert EntityIndex.resolve_groups("todo", "todo_1", opts(t)) == []
      assert EntityIndex.resolve_groups("relationship", "rel_link", opts(t)) == []
    end

    test "returns an empty list when the entity isn't in the index" do
      t = tables()

      assert EntityIndex.resolve_groups("relationship", "rel_unknown", opts(t)) == []
      assert EntityIndex.resolve_groups("groupMember", "gm_unknown", opts(t)) == []
      assert EntityIndex.resolve_groups("todo", "todo_unknown", opts(t)) == []
    end

    test "raises when a required table is missing from opts" do
      _t = tables()

      assert_raise KeyError, fn ->
        EntityIndex.resolve_groups("relationship", "rel_1", [])
      end

      assert_raise KeyError, fn ->
        EntityIndex.resolve_groups("groupMember", "gm_1", [])
      end

      assert_raise KeyError, fn ->
        EntityIndex.resolve_groups("todo", "todo_1", [])
      end
    end
  end

  describe "resolve_group/3" do
    test "returns the first group of the entity's set" do
      t = tables()

      :ok = put_rel(t, member("todo_1", "g_1", "rel_1"))

      assert EntityIndex.resolve_group("todo", "todo_1", opts(t)) == "g_1"
    end

    test "returns nil when the set is empty" do
      t = tables()

      assert EntityIndex.resolve_group("todo", "todo_unknown", opts(t)) == nil
    end
  end

  describe "source_groups/2" do
    test "returns membership targets plus intra-action targets" do
      t = tables()

      :ok = put_rel(t, member("todo_1", "g_1", "rel_1"))

      assert EntityIndex.source_groups("todo_1", opts(t)) == ["g_1"]

      assert EntityIndex.source_groups(
               "todo_1",
               opts(t) ++ [intra_action: %{"todo_1" => ["g_2"]}]
             )
             |> Enum.sort() == ["g_1", "g_2"]
    end
  end
end
