defmodule EbbServer.Sync.FanOutRouter.GroupResolutionTest do
  @moduledoc """
  Tests for the fallback group resolution extracted from `FanOutRouter`.

  The original fan-out bug (#197) keyed the group lookup on `subject_id`
  only, treating every entity id as though it were a membership source.
  For `grant` and `group` updates the `subject_id` is the entity's own id —
  not a membership source — so the lookup silently returned `nil` and the
  update never reached the per-group `GroupServer`. An `ebb/link` edge is
  scoped by its subject, which is the source row it rides.

  `GroupResolution` folds an Action's per-component Updates into row
  mutations and resolves each row by `model` through
  `EntityScope.resolve_groups/3`, so each kind of row lands in the right
  group. These tests pin its resolution surface for every model the router
  can encounter.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{MembershipCache, GrantCache, SystemComponent}
  alias EbbServer.Sync.FanOutRouter.GroupResolution

  setup do
    gm = :"for_gm_#{System.unique_integer([:positive])}"
    gm_by_id = :"for_gmbi_#{System.unique_integer([:positive])}"
    gm_by_group = :"for_gmbg_#{System.unique_integer([:positive])}"
    eg = :"for_eg_#{System.unique_integer([:positive])}"
    eg_by_id = :"for_egbi_#{System.unique_integer([:positive])}"
    eg_by_group = :"for_egbg_#{System.unique_integer([:positive])}"
    entity_models = :"for_et_#{System.unique_integer([:positive])}"
    :ets.new(entity_models, [:set, :public, :named_table])

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

      for t <- [gm, gm_by_id, gm_by_group, eg, eg_by_id, eg_by_group, entity_models] do
        try do
          :ets.delete(t)
        rescue
          _ -> :ok
        end
      end
    end)

    t = %{
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

  # One edge of a source row: `field → type → target → leaf`.
  defp link_update(subject_id, target_id) do
    %{
      "id" => "upd_link_" <> subject_id,
      "subject_id" => subject_id,
      "component" => SystemComponent.component(:link),
      "method" => "merge",
      "data" => %{
        "map" => %{
          "owns" => %{
            "map" => %{"todo" => %{"map" => %{target_id => %{"value" => true, "hlc" => 1}}}}
          }
        }
      }
    }
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

    test "routes an edge update to its subject's group", %{tables: t} do
      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      action = %{"updates" => [link_update("todo_1", "col_1")]}

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

    test "an edge whose subject has no membership adds no group", %{tables: t} do
      action = %{"updates" => [link_update("todo_1", "doc_1")]}

      assert GroupResolution.resolve_group_ids(action, opts(t)) == []
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

      action = %{
        "updates" => [link_update("todo_1", "col_1"), link_update("todo_2", "col_2")]
      }

      assert GroupResolution.resolve_group_ids(action, opts(t)) == ["g_1"]
    end

    test "drops updates whose entity is not in the cache (silent drop is fine for fan-out)",
         %{resolve_opts: opts} do
      action = %{
        "updates" => [
          link_update("todo_unknown", "col_unknown"),
          row_update("todo_unknown", "todo/title")
        ]
      }

      assert GroupResolution.resolve_group_ids(action, opts) == []
    end

    test "handles a mixed action with user and system updates across groups", %{tables: t} do
      :ok = put_membership(t, "todo_1", "g_1", "eg_1")
      :ok = put_membership(t, "todo_2", "g_2", "eg_2")

      action = %{
        "updates" => [
          row_update("todo_1", "todo/title"),
          link_update("todo_2", "col_2"),
          platform_update("g_2", :group, %{"name" => "Group 2"})
        ]
      }

      assert GroupResolution.resolve_group_ids(action, opts(t)) |> Enum.sort() == ["g_1", "g_2"]
    end
  end
end
