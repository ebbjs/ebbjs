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

  setup do
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

    t = %{
      relationships: rel,
      relationships_by_id: rbi,
      relationships_by_group: rbg,
      group_members: gm,
      group_members_by_id: gm_by_id
    }

    {:ok, tables: t, resolve_opts: opts(t)}
  end

  defp opts(t),
    do: [
      relationships: t.relationships,
      relationships_by_id: t.relationships_by_id,
      group_members_by_id: t.group_members_by_id,
      relationships_by_group: t.relationships_by_group
    ]

  defp put_relationship(t, id, source_id, target_id, kind \\ "member") do
    RelationshipCache.put_relationship(
      %{
        id: id,
        source_id: source_id,
        target_id: target_id,
        type: "todo",
        field: "group",
        kind: kind
      },
      relationships: t.relationships,
      relationships_by_group: t.relationships_by_group,
      relationships_by_id: t.relationships_by_id
    )
  end

  describe "resolve_group_ids/2 — user-entity updates (#197)" do
    test "routes a user-entity update to its group's id", %{tables: t} do
      :ok = put_relationship(t, "rel_1", "todo_1", "g_1")

      action = %{"updates" => [%{"subject_type" => "todo", "subject_id" => "todo_1"}]}

      assert FanOutRouter.resolve_group_ids(action, opts(t)) == ["g_1"]
    end
  end

  describe "resolve_group_ids/2 — system-entity updates (#197)" do
    test "routes a group update to the group itself", %{resolve_opts: opts} do
      action = %{"updates" => [%{"subject_type" => "group", "subject_id" => "g_1"}]}

      assert FanOutRouter.resolve_group_ids(action, opts) == ["g_1"]
    end

    test "routes a relationship update to its source's group", %{tables: t} do
      :ok = put_relationship(t, "rel_1", "todo_1", "g_1")

      action = %{"updates" => [%{"subject_type" => "relationship", "subject_id" => "rel_1"}]}

      assert FanOutRouter.resolve_group_ids(action, opts(t)) == ["g_1"]
    end

    test "resolves groups from the Action's own membership edges", %{resolve_opts: opts} do
      action = %{
        "updates" => [
          %{"subject_type" => "todo", "subject_id" => "todo_new"},
          %{
            "id" => "rel_new",
            "subject_type" => "relationship",
            "subject_id" => "rel_new",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "source_id" => %{"value" => "todo_new"},
                "target_id" => %{"value" => "g_intra"},
                "kind" => %{"value" => "member"}
              }
            }
          }
        ]
      }

      assert FanOutRouter.resolve_group_ids(action, opts) == ["g_intra"]
    end

    test "returns every group for a multi-membership source", %{tables: t} do
      :ok = put_relationship(t, "rel_1", "todo_1", "g_1")
      :ok = put_relationship(t, "rel_2", "todo_1", "g_2")

      action = %{"updates" => [%{"subject_type" => "todo", "subject_id" => "todo_1"}]}

      assert FanOutRouter.resolve_group_ids(action, opts(t)) |> Enum.sort() == ["g_1", "g_2"]
    end

    test "a link edge to a non-group target does not add a group", %{tables: t} do
      :ok = put_relationship(t, "rel_link", "todo_1", "doc_1", "link")

      action = %{"updates" => [%{"subject_type" => "relationship", "subject_id" => "rel_link"}]}

      assert FanOutRouter.resolve_group_ids(action, opts(t)) == []
    end

    test "routes a groupMember update to the member's group", %{tables: t} do
      :ok =
        GroupCache.put_group_member(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          t.group_members
        )

      action = %{"updates" => [%{"subject_type" => "groupMember", "subject_id" => "gm_1"}]}

      assert FanOutRouter.resolve_group_ids(action, opts(t)) == ["g_1"]
    end

    test "deduplicates when multiple updates target the same group", %{tables: t} do
      :ok = put_relationship(t, "rel_1", "todo_1", "g_1")
      :ok = put_relationship(t, "rel_2", "todo_2", "g_1")

      action = %{
        "updates" => [
          %{"subject_type" => "relationship", "subject_id" => "rel_1"},
          %{"subject_type" => "relationship", "subject_id" => "rel_2"}
        ]
      }

      assert FanOutRouter.resolve_group_ids(action, opts(t)) == ["g_1"]
    end

    test "drops updates whose entity is not in the cache (silent drop is fine for fan-out)",
         %{resolve_opts: opts} do
      action = %{
        "updates" => [
          %{"subject_type" => "relationship", "subject_id" => "rel_unknown"},
          %{"subject_type" => "todo", "subject_id" => "todo_unknown"}
        ]
      }

      assert FanOutRouter.resolve_group_ids(action, opts) == []
    end

    test "handles a mixed action with user and system updates across groups", %{tables: t} do
      :ok = put_relationship(t, "rel_1", "todo_1", "g_1")
      :ok = put_relationship(t, "rel_2", "todo_2", "g_2")

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
