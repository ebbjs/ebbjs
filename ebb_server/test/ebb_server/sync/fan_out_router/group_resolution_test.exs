defmodule EbbServer.Sync.FanOutRouter.GroupResolutionTest do
  @moduledoc """
  Tests for the fallback group resolution extracted from `FanOutRouter`.

  The original fan-out bug (#197) keyed the group lookup on `subject_id`
  only, treating every entity id as though it were a membership source.
  For `relationship`, `grant`, and `group` updates the `subject_id`
  is the entity's own id — not a membership source — so the lookup
  silently returned `nil` and the update never reached the per-group
  `GroupServer`.

  `GroupResolution` folds an Action's per-component Updates into row
  mutations and resolves each row by `model` through
  `EntityScope.resolve_groups/3`, so each kind of row lands in the right
  group. These tests pin its resolution surface for every model the router
  can encounter.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{MembershipCache, GrantCache, RelationshipCache, SystemComponent}
  alias EbbServer.Sync.FanOutRouter.GroupResolution

  setup do
    rel = :"for_rel_#{System.unique_integer([:positive])}"
    rbi = :"for_rbi_#{System.unique_integer([:positive])}"
    gm = :"for_gm_#{System.unique_integer([:positive])}"
    gm_by_id = :"for_gmbi_#{System.unique_integer([:positive])}"
    gm_by_group = :"for_gmbg_#{System.unique_integer([:positive])}"
    eg = :"for_eg_#{System.unique_integer([:positive])}"
    eg_by_id = :"for_egbi_#{System.unique_integer([:positive])}"
    eg_by_group = :"for_egbg_#{System.unique_integer([:positive])}"
    entity_models = :"for_et_#{System.unique_integer([:positive])}"
    :ets.new(entity_models, [:set, :public, :named_table])

    {:ok, _} =
      RelationshipCache.start_link(
        name: :"for_rc_#{System.unique_integer([:positive])}",
        relationships: rel,
        relationships_by_id: rbi
      )

    {:ok, _} =
      GrantCache.start_link(
        name: :"for_gc_#{System.unique_integer([:positive])}",
        table: gm,
        grants_by_id: gm_by_id,
        grants_by_group: gm_by_group
      )

    {:ok, _} =
      MembershipCache.start_link(
        name: :"for_egc_#{System.unique_integer([:positive])}",
        memberships: eg,
        memberships_by_id: eg_by_id,
        memberships_by_group: eg_by_group
      )

    on_exit(fn ->
      RelationshipCache.reset(
        relationships: rel,
        relationships_by_id: rbi
      )

      GrantCache.reset(
        grants: gm,
        grants_by_id: gm_by_id,
        grants_by_group: gm_by_group
      )

      MembershipCache.reset(
        memberships: eg,
        memberships_by_id: eg_by_id,
        memberships_by_group: eg_by_group
      )

      for t <- [rel, rbi, gm, gm_by_id, gm_by_group, eg, eg_by_id, eg_by_group, entity_models] do
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
      grants: gm,
      grants_by_id: gm_by_id,
      grants_by_group: gm_by_group,
      memberships: eg,
      memberships_by_id: eg_by_id,
      memberships_by_group: eg_by_group,
      entity_models: entity_models
    }

    {:ok, tables: t, resolve_opts: opts(t)}
  end

  defp opts(t),
    do: [
      memberships: t.memberships,
      memberships_by_id: t.memberships_by_id,
      relationships_by_id: t.relationships_by_id,
      grants_by_id: t.grants_by_id,
      entity_models: t.entity_models
    ]

  defp row_update(subject_id, component, value \\ nil) do
    %{
      "id" => "upd_" <> subject_id,
      "subject_id" => subject_id,
      "component" => component,
      "method" => "replace",
      "data" => %{"type" => "lww", "value" => value || subject_id, "hlc" => 1}
    }
  end

  # A platform row is one atomic component: the whole value is the payload.
  defp platform_update(subject_id, kind, value) do
    %{
      "id" => "upd_" <> subject_id,
      "subject_id" => subject_id,
      "component" => SystemComponent.component(kind),
      "method" => "replace",
      "data" => %{"value" => value, "hlc" => 1}
    }
  end

  defp delete_update(subject_id) do
    %{
      "id" => "upd_" <> subject_id,
      "subject_id" => subject_id,
      "method" => "delete",
      "data" => nil
    }
  end

  defp put_membership(t, entity_id, group_id, id) do
    MembershipCache.put_membership(
      %{id: id, entity_id: entity_id, group_id: group_id},
      memberships: t.memberships,
      memberships_by_id: t.memberships_by_id,
      memberships_by_group: t.memberships_by_group
    )
  end

  defp put_relationship(t, id, source_id, target_id) do
    RelationshipCache.put_relationship(
      %{
        id: id,
        source_id: source_id,
        target_id: target_id,
        type: "todo",
        field: "owns"
      },
      relationships: t.relationships,
      relationships_by_id: t.relationships_by_id
    )
  end

  describe "resolve_group_ids/2 — user-entity updates (#197)" do
    test "routes a user-entity update to its group's id", %{tables: t} do
      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      action = %{"updates" => [row_update("todo_1", "todo/title")]}

      assert GroupResolution.resolve_group_ids(action, opts(t)) == ["g_1"]
    end
  end

  describe "resolve_group_ids/2 — system-entity updates (#197)" do
    test "routes a group update to the group itself", %{resolve_opts: opts} do
      action = %{"updates" => [platform_update("g_1", :group, %{"name" => "Test Group"})]}

      assert GroupResolution.resolve_group_ids(action, opts) == ["g_1"]
    end

    test "routes a relationship update to its source's group", %{tables: t} do
      :ok = put_membership(t, "todo_1", "g_1", "eg_1")
      :ok = put_relationship(t, "rel_1", "todo_1", "col_1")

      action = %{
        "updates" => [
          platform_update("rel_1", :link, %{
            "source_id" => "todo_1",
            "target_id" => "col_1",
            "type" => "todo",
            "field" => "owns"
          })
        ]
      }

      assert GroupResolution.resolve_group_ids(action, opts(t)) == ["g_1"]
    end

    test "resolves groups from the Action's own membership rows", %{resolve_opts: opts} do
      action = %{
        "updates" => [
          row_update("todo_new", "todo/title"),
          platform_update("eg_new", :membership, %{
            "entity_id" => "todo_new",
            "group_id" => "g_intra"
          })
        ]
      }

      assert GroupResolution.resolve_group_ids(action, opts) == ["g_intra"]
    end

    test "returns every group for a multi-membership source", %{tables: t} do
      :ok = put_membership(t, "todo_1", "g_1", "eg_1")
      :ok = put_membership(t, "todo_1", "g_2", "eg_2")

      action = %{"updates" => [row_update("todo_1", "todo/title")]}

      assert GroupResolution.resolve_group_ids(action, opts(t)) |> Enum.sort() == ["g_1", "g_2"]
    end

    test "a relationship whose source has no membership adds no group", %{tables: t} do
      :ok = put_relationship(t, "rel_link", "todo_1", "doc_1")

      action = %{
        "updates" => [
          platform_update("rel_link", :link, %{
            "source_id" => "todo_1",
            "target_id" => "doc_1",
            "type" => "todo",
            "field" => "owns"
          })
        ]
      }

      assert GroupResolution.resolve_group_ids(action, opts(t)) == []
    end

    # A delete names only the row, so it is scoped by the stored source and
    # cannot reach a group the row never belonged to (#624).
    test "a delete is scoped by the stored row's source", %{tables: t} do
      :ok = put_membership(t, "todo_victim", "g_victim", "eg_victim")
      :ok = put_membership(t, "todo_attacker", "g_attacker", "eg_attacker")
      :ok = put_relationship(t, "rel_1", "todo_victim", "col_1")
      :ets.insert(t.entity_models, {"rel_1", SystemComponent.model()})

      action = %{"updates" => [delete_update("rel_1")]}

      assert GroupResolution.resolve_group_ids(action, opts(t)) == ["g_victim"]
    end

    test "routes a grant update to the member's group", %{tables: t} do
      :ok =
        GrantCache.put_grant(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          grants: t.grants,
          grants_by_id: t.grants_by_id,
          grants_by_group: t.grants_by_group
        )

      action = %{
        "updates" => [
          platform_update("gm_1", :grant, %{
            "actor_id" => "a_1",
            "group_id" => "g_1",
            "permissions" => ["todo.create"]
          })
        ]
      }

      assert GroupResolution.resolve_group_ids(action, opts(t)) == ["g_1"]
    end

    test "deduplicates when multiple updates target the same group", %{tables: t} do
      :ok = put_membership(t, "todo_1", "g_1", "eg_1")
      :ok = put_membership(t, "todo_2", "g_1", "eg_2")
      :ok = put_relationship(t, "rel_1", "todo_1", "col_1")
      :ok = put_relationship(t, "rel_2", "todo_2", "col_2")

      action = %{
        "updates" => [
          platform_update("rel_1", :link, %{
            "source_id" => "todo_1",
            "target_id" => "col_1",
            "type" => "todo",
            "field" => "owns"
          }),
          platform_update("rel_2", :link, %{
            "source_id" => "todo_2",
            "target_id" => "col_2",
            "type" => "todo",
            "field" => "owns"
          })
        ]
      }

      assert GroupResolution.resolve_group_ids(action, opts(t)) == ["g_1"]
    end

    test "drops updates whose entity is not in the cache (silent drop is fine for fan-out)",
         %{resolve_opts: opts} do
      action = %{
        "updates" => [
          platform_update("rel_unknown", :link, %{
            "source_id" => "todo_unknown",
            "target_id" => "col_unknown",
            "type" => "todo",
            "field" => "owns"
          }),
          row_update("todo_unknown", "todo/title")
        ]
      }

      assert GroupResolution.resolve_group_ids(action, opts) == []
    end

    test "handles a mixed action with user and system updates across groups", %{tables: t} do
      :ok = put_membership(t, "todo_1", "g_1", "eg_1")
      :ok = put_membership(t, "todo_2", "g_2", "eg_2")
      :ok = put_relationship(t, "rel_2", "todo_2", "col_2")

      action = %{
        "updates" => [
          row_update("todo_1", "todo/title"),
          platform_update("rel_2", :link, %{
            "source_id" => "todo_2",
            "target_id" => "col_2",
            "type" => "todo",
            "field" => "owns"
          }),
          platform_update("g_2", :group, %{"name" => "Group 2"})
        ]
      }

      assert GroupResolution.resolve_group_ids(action, opts(t)) |> Enum.sort() == ["g_1", "g_2"]
    end
  end
end
