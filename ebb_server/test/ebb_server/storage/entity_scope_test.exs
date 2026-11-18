defmodule EbbServer.Storage.EntityIndexTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.CacheMutationPlanner
  alias EbbServer.Storage.MembershipCache
  alias EbbServer.Storage.EntityScope
  alias EbbServer.Storage.EntityModelCache
  alias EbbServer.Storage.GroupAppsCache
  alias EbbServer.Storage.GrantCache

  defp tables do
    gm = :"ei_gm_#{System.unique_integer([:positive])}"
    gm_by_id = :"ei_gmbi_#{System.unique_integer([:positive])}"
    gm_by_group = :"ei_gmbg_#{System.unique_integer([:positive])}"
    eg = :"ei_eg_#{System.unique_integer([:positive])}"
    eg_by_id = :"ei_egbi_#{System.unique_integer([:positive])}"
    eg_by_group = :"ei_egbg_#{System.unique_integer([:positive])}"
    entity_models = :"ei_et_#{System.unique_integer([:positive])}"
    group_apps = :"ei_ga_#{System.unique_integer([:positive])}"
    :ets.new(group_apps, [:set, :public, :named_table])

    {:ok, _} =
      GrantCache.start_link(
        name: :"ei_gc_#{System.unique_integer([:positive])}",
        table: gm,
        grants_by_id: gm_by_id,
        grants_by_group: gm_by_group
      )

    {:ok, _} =
      MembershipCache.start_link(
        name: :"ei_egc_#{System.unique_integer([:positive])}",
        memberships: eg,
        memberships_by_id: eg_by_id,
        memberships_by_group: eg_by_group
      )

    {:ok, _} =
      EntityModelCache.start_link(
        name: :"ei_etc_#{System.unique_integer([:positive])}",
        entity_models: entity_models
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

      EntityModelCache.reset(entity_models: entity_models)

      for t <- [
            gm,
            gm_by_id,
            gm_by_group,
            eg,
            eg_by_id,
            eg_by_group,
            entity_models,
            group_apps
          ] do
        try do
          :ets.delete(t)
        rescue
          _ -> :ok
        end
      end
    end)

    %{
      grants: gm,
      grants_by_id: gm_by_id,
      grants_by_group: gm_by_group,
      memberships: eg,
      memberships_by_id: eg_by_id,
      memberships_by_group: eg_by_group,
      entity_models: entity_models,
      group_apps: group_apps
    }
  end

  defp opts(t) do
    [
      memberships: t.memberships,
      memberships_by_id: t.memberships_by_id,
      entity_models: t.entity_models,
      grants_by_id: t.grants_by_id,
      group_apps: t.group_apps
    ]
  end

  defp put_group(t, group_id, apps \\ []) do
    GroupAppsCache.put_group_apps(group_id, apps, group_apps: t.group_apps)
  end

  defp put_membership(t, entity_id, group_id, id) do
    MembershipCache.put_membership(
      %{id: id, entity_id: entity_id, group_id: group_id},
      memberships: t.memberships,
      memberships_by_id: t.memberships_by_id,
      memberships_by_group: t.memberships_by_group
    )
  end

  # A folded platform row: one atomic component value, and its kind.
  defp system_write(kind, subject_id, value) do
    %{
      subject_id: subject_id,
      model: "ebb",
      kind: kind,
      created?: false,
      deleted?: false,
      data: system_data(kind, value)
    }
  end

  # A delete names the row rather than a component, so it carries no data.
  defp system_delete(kind, subject_id) do
    %{
      subject_id: subject_id,
      model: "ebb",
      kind: kind,
      created?: false,
      deleted?: true,
      data: nil
    }
  end

  defp system_data(kind, value) do
    %{"fields" => %{Atom.to_string(kind) => %{"value" => value || %{}}}}
  end

  describe "resolve_groups/3" do
    test "returns the group id for a group subject type" do
      _ = tables()
      assert EntityScope.resolve_groups(:group, "g_1") == ["g_1"]
    end

    test "resolves an membership subject via the by-id table" do
      t = tables()

      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      assert EntityScope.resolve_groups(:membership, "eg_1", opts(t)) == ["g_1"]
    end

    # An edge declares no scope owner, so the subject's own membership set is
    # its scope: the subject *is* the source.
    test "resolves an edge write through the subject's own membership set" do
      t = tables()

      :ok = put_membership(t, "todo_1", "g_1", "eg_member")

      assert EntityScope.resolve_groups(:link, "todo_1", opts(t)) == ["g_1"]
    end

    test "resolves a grant subject via the by-id table" do
      t = tables()

      :ok =
        GrantCache.put_grant(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          grants: t.grants,
          grants_by_id: t.grants_by_id,
          grants_by_group: t.grants_by_group
        )

      assert EntityScope.resolve_groups(:grant, "gm_1", opts(t)) == ["g_1"]
    end

    test "returns every group for a multi-membership source" do
      t = tables()

      :ok = put_membership(t, "todo_1", "g_1", "eg_1")
      :ok = put_membership(t, "todo_1", "g_2", "eg_2")

      assert EntityScope.resolve_groups("todo", "todo_1", opts(t)) |> Enum.sort() == [
               "g_1",
               "g_2"
             ]
    end

    test "unions cached membership with intra-action membership" do
      t = tables()

      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      assert EntityScope.resolve_groups(
               "todo",
               "todo_1",
               opts(t) ++ [intra_action: %{"todo_1" => ["g_2"]}]
             )
             |> Enum.sort() == ["g_1", "g_2"]
    end

    test "returns an empty list when the entity isn't in the index" do
      t = tables()

      assert EntityScope.resolve_groups(:link, "todo_unknown", opts(t)) == []
      assert EntityScope.resolve_groups(:grant, "gm_unknown", opts(t)) == []
      assert EntityScope.resolve_groups(:membership, "eg_unknown", opts(t)) == []
      assert EntityScope.resolve_groups("todo", "todo_unknown", opts(t)) == []
    end

    test "raises when a required table is missing from opts" do
      _t = tables()

      assert_raise KeyError, fn ->
        EntityScope.resolve_groups(:link, "todo_1", [])
      end

      assert_raise KeyError, fn ->
        EntityScope.resolve_groups(:grant, "gm_1", [])
      end

      assert_raise KeyError, fn ->
        EntityScope.resolve_groups(:membership, "eg_1", [])
      end

      assert_raise KeyError, fn ->
        EntityScope.resolve_groups("todo", "todo_1", [])
      end
    end
  end

  describe "resolve_groups_cached/3" do
    test "returns the cached set and the intra-action source id" do
      t = tables()

      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      assert EntityScope.resolve_groups_cached("todo", "todo_1", opts(t)) == {
               ["g_1"],
               "todo_1"
             }

      assert EntityScope.resolve_groups_cached(:membership, "eg_1", opts(t)) == {["g_1"], nil}
      assert EntityScope.resolve_groups_cached(:group, "g_1", opts(t)) == {["g_1"], nil}
    end

    test "excludes intra-action membership from the cached set" do
      t = tables()

      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      with_intra = opts(t) ++ [intra_action: %{"todo_1" => ["g_2"]}]

      assert EntityScope.resolve_groups_cached("todo", "todo_1", with_intra) == {
               ["g_1"],
               "todo_1"
             }
    end
  end

  describe "apply_intra_action/3" do
    test "unions the source's intra-action membership" do
      opts = [intra_action: %{"todo_1" => ["g_2"]}]

      assert EntityScope.apply_intra_action(["g_1"], "todo_1", opts) |> Enum.sort() == [
               "g_1",
               "g_2"
             ]
    end

    test "returns the cached set unchanged when there is no intra-action membership" do
      assert EntityScope.apply_intra_action(["g_1"], "todo_1", []) == ["g_1"]

      assert EntityScope.apply_intra_action(["g_1"], nil, intra_action: %{"todo_1" => ["g_2"]}) ==
               ["g_1"]
    end
  end

  describe "source_groups/2" do
    test "returns membership targets plus intra-action targets" do
      t = tables()

      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      assert EntityScope.source_groups("todo_1", opts(t)) == ["g_1"]

      assert EntityScope.source_groups(
               "todo_1",
               opts(t) ++ [intra_action: %{"todo_1" => ["g_2"]}]
             )
             |> Enum.sort() == ["g_1", "g_2"]
    end
  end

  describe "kind/2" do
    test "answers each platform kind from its by-id cache" do
      t = tables()

      :ok = put_group(t, "g_1", ["notes"])

      :ok =
        GrantCache.put_grant(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: []},
          grants: t.grants,
          grants_by_id: t.grants_by_id,
          grants_by_group: t.grants_by_group
        )

      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      assert EntityScope.kind("gm_1", opts(t)) == :grant
      assert EntityScope.kind("eg_1", opts(t)) == :membership
      assert EntityScope.kind("g_1", opts(t)) == :group
      assert EntityScope.kind("todo_1", opts(t)) == nil
    end

    # The declaration order is the by-id precedence: ids are not model-unique,
    # so a colliding id resolves to the first declared kind.
    test "prefers the earlier declaration when an id collides" do
      t = tables()

      :ok = put_group(t, "collision")
      :ok = put_membership(t, "todo_1", "g_1", "collision")

      assert EntityScope.kind("collision", opts(t)) == :membership
    end

    test "a cache the caller omits holds no row" do
      t = tables()

      :ok = put_group(t, "g_1")

      assert EntityScope.kind("g_1", Keyword.delete(opts(t), :group_apps)) == nil
    end

    # A planned group row shadows the cache. Its `apps` value may be nil
    # (unscoped) while the row still exists.
    test "counts a planned group row whose apps value is nil" do
      t = tables()

      overlay =
        CacheMutationPlanner.Overlay.put(
          CacheMutationPlanner.Overlay.empty(),
          {:group_apps, "g_planned"},
          nil
        )

      assert EntityScope.kind("g_planned", opts(t) ++ [overlay: overlay]) == :group
    end

    test "a planned tombstone hides a cached group" do
      t = tables()

      :ok = put_group(t, "g_1")

      overlay =
        CacheMutationPlanner.Overlay.put(
          CacheMutationPlanner.Overlay.empty(),
          {:group_apps, "g_1"},
          :deleted
        )

      assert EntityScope.kind("g_1", opts(t) ++ [overlay: overlay]) == nil
    end
  end

  describe "fan_out_groups/2" do
    test "prefers the wire group for a not-yet-cached membership row" do
      t = tables()

      update =
        system_write(:membership, "eg_1", %{
          "entity_id" => "todo_1",
          "group_id" => "g_wire"
        })

      assert EntityScope.fan_out_preference(update, opts(t)) == {:wire, ["g_wire"]}
      assert EntityScope.fan_out_groups(update, opts(t)) == ["g_wire"]
    end

    test "resolves a membership row from the cache when the wire drops the group" do
      t = tables()
      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      update = system_delete(:membership, "eg_1")

      assert EntityScope.fan_out_preference(update, opts(t)) == {:by_id, :membership}
      assert EntityScope.fan_out_groups(update, opts(t)) == ["g_1"]
    end

    # An edge is scoped by its subject, which is its source, whatever the
    # model the fold recorded for the row: the edge declares no scope owner
    # and a target never lends one.
    test "an edge fans out to its subject's membership set" do
      t = tables()
      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      update = system_write(:link, "todo_1", %{"blocked_by" => %{}})

      assert EntityScope.fan_out_preference(update, opts(t)) == {:source, "todo_1"}
      assert EntityScope.fan_out_groups(update, opts(t)) == ["g_1"]
    end

    test "an edge's target is never a scope" do
      t = tables()
      :ok = put_membership(t, "todo_1", "g_1", "eg_1")
      :ok = put_group(t, "g_target")

      update = system_write(:link, "todo_1", %{"blocked_by" => %{"todo" => "g_target"}})

      assert EntityScope.fan_out_groups(update, opts(t)) == ["g_1"]
    end

    test "unions a user entity's cached membership with intra-action membership" do
      t = tables()
      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      update = %{
        subject_id: "todo_1",
        model: "todo",
        created?: true,
        deleted?: false,
        data: %{"fields" => %{}}
      }

      assert EntityScope.fan_out_preference(update, opts(t)) == {:by_id, "todo"}

      assert EntityScope.fan_out_groups(update, opts(t) ++ [intra_action: %{"todo_1" => ["g_2"]}])
             |> Enum.sort() == ["g_1", "g_2"]
    end
  end

  describe "model/2" do
    test "returns the indexed model for an entity" do
      t = tables()

      :ok = EntityModelCache.put_model("todo_1", "todo", entity_models: t.entity_models)

      assert EntityScope.model("todo_1", opts(t)) == "todo"
    end

    test "reads a predecessor batch's planned entity model from the overlay" do
      t = tables()

      update = %{
        subject_id: "todo_1",
        model: "todo",
        created?: true,
        deleted?: false,
        data: %{"fields" => %{}}
      }

      {_mutations, overlay} =
        CacheMutationPlanner.plan([update], %{
          grants_by_id: t.grants_by_id,
          memberships_by_id: t.memberships_by_id
        })

      opts = Keyword.put(opts(t), :overlay, overlay)

      assert EntityScope.model("todo_1", opts) == "todo"
      assert EntityScope.exists?("todo_1", opts)
    end

    test "returns nil for an unknown entity" do
      t = tables()

      assert EntityScope.model("todo_unknown", opts(t)) == nil
    end

    test "raises when the entity_models table is missing from opts" do
      _t = tables()

      assert_raise KeyError, fn -> EntityScope.model("todo_1", []) end
    end
  end

  describe "membership/2" do
    test "resolves a membership row to its entity and group" do
      t = tables()

      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      assert EntityScope.membership("eg_1", opts(t)) == {"todo_1", "g_1"}
    end

    test "returns nil for an unknown membership id" do
      t = tables()

      assert EntityScope.membership("eg_unknown", opts(t)) == nil
    end
  end
end
