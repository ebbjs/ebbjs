defmodule EbbServer.Sync.FanOutRouterDispatchTest do
  @moduledoc """
  Tests for the system-entity fan-out bug surfaced in #197.

  `FanOutRouter.dispatch_to_groups/1` previously keyed its group lookup
  on `subject_id` only, calling `RelationshipCache.get_entity_group/1`
  which is keyed on `source_id`. For `relationship`, `groupMember`,
  and `group` updates the `subject_id` is the entity's own id — not a
  `source_id` — so the lookup silently returned `nil` and the update
  never reached the per-group `GroupServer`.

  The fix routes resolution by `subject_type` through
  `EntityIndex.resolve_group/3` so each kind of update lands in the
  right group. These tests pin the resolution surface end-to-end for
  every subject type the router can encounter.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{GroupCache, RelationshipCache}
  alias EbbServer.Sync.FanOutRouter

  defp tables do
    rel = :"for_rel_#{System.unique_integer([:positive])}"
    rbi = :"for_rbi_#{System.unique_integer([:positive])}"
    rbg = :"for_rbg_#{System.unique_integer([:positive])}"
    gm = :"for_gm_#{System.unique_integer([:positive])}"
    gm_by_id = :"for_gmbi_#{System.unique_integer([:positive])}"

    {:ok, _} =
      RelationshipCache.start_link(
        name: :"for_rc_#{System.unique_integer([:positive])}",
        relationships: rel,
        relationships_by_group: rbg,
        relationships_by_id: rbi
      )

    {:ok, _} =
      GroupCache.start_link(
        name: :"for_gc_#{System.unique_integer([:positive])}",
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
      relationships_by_group: rbg,
      group_members: gm,
      group_members_by_id: gm_by_id
    }
  end

  defp opts(t),
    do: [
      relationships: t.relationships,
      relationships_by_id: t.relationships_by_id,
      group_members_by_id: t.group_members_by_id
    ]

  describe "resolve_group_ids/2 — user-entity updates (#197)" do
    test "routes a user-entity update to its group's id" do
      t = tables()

      :ok =
        RelationshipCache.put_relationship(
          %{id: "rel_1", source_id: "todo_1", target_id: "g_1", type: "todo", field: "group"},
          relationships: t.relationships,
          relationships_by_group: t.relationships_by_group,
          relationships_by_id: t.relationships_by_id
        )

      action = %{"updates" => [%{"subject_type" => "todo", "subject_id" => "todo_1"}]}

      assert FanOutRouter.resolve_group_ids(action, opts(t)) == ["g_1"]
    end
  end

  describe "resolve_group_ids/2 — system-entity updates (#197)" do
    test "routes a group update to the group itself" do
      _t = tables()

      action = %{"updates" => [%{"subject_type" => "group", "subject_id" => "g_1"}]}

      assert FanOutRouter.resolve_group_ids(action, opts(tables())) == ["g_1"]
    end

    test "routes a relationship update to the relationship's target group" do
      t = tables()

      :ok =
        RelationshipCache.put_relationship(
          %{id: "rel_1", source_id: "todo_1", target_id: "g_1", type: "todo", field: "group"},
          relationships: t.relationships,
          relationships_by_group: t.relationships_by_group,
          relationships_by_id: t.relationships_by_id
        )

      action = %{"updates" => [%{"subject_type" => "relationship", "subject_id" => "rel_1"}]}

      assert FanOutRouter.resolve_group_ids(action, opts(t)) == ["g_1"]
    end

    test "routes a groupMember update to the member's group" do
      t = tables()

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          t.group_members
        )

      action = %{"updates" => [%{"subject_type" => "groupMember", "subject_id" => "gm_1"}]}

      assert FanOutRouter.resolve_group_ids(action, opts(t)) == ["g_1"]
    end

    test "deduplicates when multiple updates target the same group" do
      t = tables()

      :ok =
        RelationshipCache.put_relationship(
          %{id: "rel_1", source_id: "todo_1", target_id: "g_1", type: "todo", field: "group"},
          relationships: t.relationships,
          relationships_by_group: t.relationships_by_group,
          relationships_by_id: t.relationships_by_id
        )

      :ok =
        RelationshipCache.put_relationship(
          %{id: "rel_2", source_id: "todo_2", target_id: "g_1", type: "todo", field: "group"},
          relationships: t.relationships,
          relationships_by_group: t.relationships_by_group,
          relationships_by_id: t.relationships_by_id
        )

      action = %{
        "updates" => [
          %{"subject_type" => "relationship", "subject_id" => "rel_1"},
          %{"subject_type" => "relationship", "subject_id" => "rel_2"}
        ]
      }

      assert FanOutRouter.resolve_group_ids(action, opts(t)) == ["g_1"]
    end

    test "drops updates whose entity is not in the cache (silent drop is fine for fan-out)" do
      _t = tables()

      action = %{
        "updates" => [
          %{"subject_type" => "relationship", "subject_id" => "rel_unknown"},
          %{"subject_type" => "todo", "subject_id" => "todo_unknown"}
        ]
      }

      assert FanOutRouter.resolve_group_ids(action, opts(tables())) == []
    end

    test "handles a mixed action with user and system updates across groups" do
      t = tables()

      :ok =
        RelationshipCache.put_relationship(
          %{id: "rel_1", source_id: "todo_1", target_id: "g_1", type: "todo", field: "group"},
          relationships: t.relationships,
          relationships_by_group: t.relationships_by_group,
          relationships_by_id: t.relationships_by_id
        )

      :ok =
        RelationshipCache.put_relationship(
          %{id: "rel_2", source_id: "todo_2", target_id: "g_2", type: "todo", field: "group"},
          relationships: t.relationships,
          relationships_by_group: t.relationships_by_group,
          relationships_by_id: t.relationships_by_id
        )

      action = %{
        "updates" => [
          %{"subject_type" => "todo", "subject_id" => "todo_1"},
          %{"subject_type" => "relationship", "subject_id" => "rel_2"},
          %{"subject_type" => "group", "subject_id" => "g_2"}
        ]
      }

      assert FanOutRouter.resolve_group_ids(action, opts(t)) |> Enum.sort() == ["g_1", "g_2"]
    end
  end
end
