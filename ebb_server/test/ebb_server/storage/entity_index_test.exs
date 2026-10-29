defmodule EbbServer.Storage.EntityIndexTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.CacheMutationPlanner
  alias EbbServer.Storage.EntityGroupCache
  alias EbbServer.Storage.EntityIndex
  alias EbbServer.Storage.EntityTypeCache
  alias EbbServer.Storage.GroupCache
  alias EbbServer.Storage.RelationshipCache

  defp tables do
    rel = :"ei_rel_#{System.unique_integer([:positive])}"
    rbi = :"ei_rbi_#{System.unique_integer([:positive])}"
    gm = :"ei_gm_#{System.unique_integer([:positive])}"
    gm_by_id = :"ei_gmbi_#{System.unique_integer([:positive])}"
    gm_by_group = :"ei_gmbg_#{System.unique_integer([:positive])}"
    eg = :"ei_eg_#{System.unique_integer([:positive])}"
    eg_by_id = :"ei_egbi_#{System.unique_integer([:positive])}"
    eg_by_group = :"ei_egbg_#{System.unique_integer([:positive])}"
    entity_types = :"ei_et_#{System.unique_integer([:positive])}"

    {:ok, _} =
      RelationshipCache.start_link(
        name: :"ei_rc_#{System.unique_integer([:positive])}",
        relationships: rel,
        relationships_by_id: rbi
      )

    {:ok, _} =
      GroupCache.start_link(
        name: :"ei_gc_#{System.unique_integer([:positive])}",
        table: gm,
        group_members_by_id: gm_by_id,
        group_members_by_group: gm_by_group
      )

    {:ok, _} =
      EntityGroupCache.start_link(
        name: :"ei_egc_#{System.unique_integer([:positive])}",
        entity_groups: eg,
        entity_groups_by_id: eg_by_id,
        entity_groups_by_group: eg_by_group
      )

    {:ok, _} =
      EntityTypeCache.start_link(
        name: :"ei_etc_#{System.unique_integer([:positive])}",
        entity_types: entity_types
      )

    on_exit(fn ->
      RelationshipCache.reset(
        relationships: rel,
        relationships_by_id: rbi
      )

      GroupCache.reset(
        group_members: gm,
        group_members_by_id: gm_by_id,
        group_members_by_group: gm_by_group
      )

      EntityGroupCache.reset(
        entity_groups: eg,
        entity_groups_by_id: eg_by_id,
        entity_groups_by_group: eg_by_group
      )

      EntityTypeCache.reset(entity_types: entity_types)

      for t <- [rel, rbi, gm, gm_by_id, gm_by_group, eg, eg_by_id, eg_by_group, entity_types] do
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
      group_members_by_group: gm_by_group,
      entity_groups: eg,
      entity_groups_by_id: eg_by_id,
      entity_groups_by_group: eg_by_group,
      entity_types: entity_types
    }
  end

  defp opts(t) do
    [
      entity_groups: t.entity_groups,
      entity_groups_by_id: t.entity_groups_by_id,
      entity_types: t.entity_types,
      relationships_by_id: t.relationships_by_id,
      group_members_by_id: t.group_members_by_id
    ]
  end

  defp put_rel(t, rel) do
    RelationshipCache.put_relationship(rel,
      relationships: t.relationships,
      relationships_by_id: t.relationships_by_id
    )
  end

  defp put_membership(t, entity_id, group_id, id) do
    EntityGroupCache.put_entity_group(
      %{id: id, entity_id: entity_id, group_id: group_id},
      entity_groups: t.entity_groups,
      entity_groups_by_id: t.entity_groups_by_id,
      entity_groups_by_group: t.entity_groups_by_group
    )
  end

  defp link_rel(id, source_id, target_id) do
    %{id: id, source_id: source_id, target_id: target_id, type: "todo", field: "owns"}
  end

  describe "resolve_groups/3" do
    test "returns the group id for a group subject type" do
      _ = tables()
      assert EntityIndex.resolve_groups("group", "g_1") == ["g_1"]
    end

    test "resolves an entityGroup subject via the by-id table" do
      t = tables()

      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      assert EntityIndex.resolve_groups("entityGroup", "eg_1", opts(t)) == ["g_1"]
    end

    test "resolves a relationship subject via its source's membership set" do
      t = tables()

      :ok = put_membership(t, "todo_1", "g_1", "eg_member")
      :ok = put_rel(t, link_rel("rel_link", "todo_1", "col_1"))

      assert EntityIndex.resolve_groups("relationship", "rel_link", opts(t)) == ["g_1"]
    end

    test "resolves a groupMember subject via the by-id table" do
      t = tables()

      :ok =
        GroupCache.put_group_member(
          %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["todo.create"]},
          group_members: t.group_members,
          group_members_by_id: t.group_members_by_id,
          group_members_by_group: t.group_members_by_group
        )

      assert EntityIndex.resolve_groups("groupMember", "gm_1", opts(t)) == ["g_1"]
    end

    test "returns every group for a multi-membership source" do
      t = tables()

      :ok = put_membership(t, "todo_1", "g_1", "eg_1")
      :ok = put_membership(t, "todo_1", "g_2", "eg_2")

      assert EntityIndex.resolve_groups("todo", "todo_1", opts(t)) |> Enum.sort() == [
               "g_1",
               "g_2"
             ]
    end

    test "unions cached membership with intra-action membership" do
      t = tables()

      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      assert EntityIndex.resolve_groups(
               "todo",
               "todo_1",
               opts(t) ++ [intra_action: %{"todo_1" => ["g_2"]}]
             )
             |> Enum.sort() == ["g_1", "g_2"]
    end

    test "a domain link to a group is not treated as membership" do
      t = tables()

      :ok = put_rel(t, link_rel("rel_link", "todo_1", "g_1"))

      assert EntityIndex.resolve_groups("todo", "todo_1", opts(t)) == []
      assert EntityIndex.resolve_groups("relationship", "rel_link", opts(t)) == []
    end

    test "returns an empty list when the entity isn't in the index" do
      t = tables()

      assert EntityIndex.resolve_groups("relationship", "rel_unknown", opts(t)) == []
      assert EntityIndex.resolve_groups("groupMember", "gm_unknown", opts(t)) == []
      assert EntityIndex.resolve_groups("entityGroup", "eg_unknown", opts(t)) == []
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
        EntityIndex.resolve_groups("entityGroup", "eg_1", [])
      end

      assert_raise KeyError, fn ->
        EntityIndex.resolve_groups("todo", "todo_1", [])
      end
    end
  end

  describe "resolve_groups_cached/3" do
    test "returns the cached set and the intra-action source id" do
      t = tables()

      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      assert EntityIndex.resolve_groups_cached("todo", "todo_1", opts(t)) == {
               ["g_1"],
               "todo_1"
             }

      assert EntityIndex.resolve_groups_cached("entityGroup", "eg_1", opts(t)) == {["g_1"], nil}
      assert EntityIndex.resolve_groups_cached("group", "g_1", opts(t)) == {["g_1"], nil}
    end

    test "excludes intra-action membership from the cached set" do
      t = tables()

      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      with_intra = opts(t) ++ [intra_action: %{"todo_1" => ["g_2"]}]

      assert EntityIndex.resolve_groups_cached("todo", "todo_1", with_intra) == {
               ["g_1"],
               "todo_1"
             }
    end
  end

  describe "apply_intra_action/3" do
    test "unions the source's intra-action membership" do
      opts = [intra_action: %{"todo_1" => ["g_2"]}]

      assert EntityIndex.apply_intra_action(["g_1"], "todo_1", opts) |> Enum.sort() == [
               "g_1",
               "g_2"
             ]
    end

    test "returns the cached set unchanged when there is no intra-action membership" do
      assert EntityIndex.apply_intra_action(["g_1"], "todo_1", []) == ["g_1"]

      assert EntityIndex.apply_intra_action(["g_1"], nil, intra_action: %{"todo_1" => ["g_2"]}) ==
               ["g_1"]
    end
  end

  describe "source_groups/2" do
    test "returns membership targets plus intra-action targets" do
      t = tables()

      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      assert EntityIndex.source_groups("todo_1", opts(t)) == ["g_1"]

      assert EntityIndex.source_groups(
               "todo_1",
               opts(t) ++ [intra_action: %{"todo_1" => ["g_2"]}]
             )
             |> Enum.sort() == ["g_1", "g_2"]
    end
  end

  describe "fan_out_groups/2" do
    test "prefers the wire group for a not-yet-cached membership row" do
      t = tables()

      update = %{
        subject_id: "eg_1",
        subject_type: "entityGroup",
        method: :put,
        data: %{"fields" => %{"group_id" => %{"value" => "g_wire"}}}
      }

      assert EntityIndex.fan_out_preference(update, opts(t)) == {:wire, ["g_wire"]}
      assert EntityIndex.fan_out_groups(update, opts(t)) == ["g_wire"]
    end

    test "resolves a membership row from the cache when the wire drops the group" do
      t = tables()
      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      update = %{subject_id: "eg_1", subject_type: "entityGroup", method: :delete, data: nil}

      assert EntityIndex.fan_out_preference(update, opts(t)) == {:by_id, "entityGroup"}
      assert EntityIndex.fan_out_groups(update, opts(t)) == ["g_1"]
    end

    test "resolves a relationship through its wire source" do
      t = tables()
      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      update = %{
        subject_id: "rel_1",
        subject_type: "relationship",
        method: :put,
        data: %{"fields" => %{"source_id" => %{"value" => "todo_1"}}}
      }

      assert EntityIndex.fan_out_preference(update, opts(t)) == {:source, "todo_1"}
      assert EntityIndex.fan_out_groups(update, opts(t)) == ["g_1"]
    end

    test "resolves a relationship delete through its stored row's source" do
      t = tables()
      :ok = put_membership(t, "todo_1", "g_1", "eg_1")
      :ok = put_rel(t, link_rel("rel_1", "todo_1", "col_1"))

      update = %{subject_id: "rel_1", subject_type: "relationship", method: :delete, data: nil}

      assert EntityIndex.fan_out_preference(update, opts(t)) == {:source, "todo_1"}
      assert EntityIndex.fan_out_groups(update, opts(t)) == ["g_1"]
    end

    # A relationship row's source is its identity, so a delete is scoped to
    # the groups the stored row belongs to. The wire source cannot widen
    # that scope (#624).
    test "scopes a relationship delete by the stored row, not a foreign wire source" do
      t = tables()
      :ok = put_membership(t, "todo_victim", "g_victim", "eg_victim")
      :ok = put_membership(t, "todo_attacker", "g_attacker", "eg_attacker")
      :ok = put_rel(t, link_rel("rel_victim", "todo_victim", "col_1"))

      update = %{
        subject_id: "rel_victim",
        subject_type: "relationship",
        method: :delete,
        data: %{"fields" => %{"source_id" => %{"value" => "todo_attacker"}}}
      }

      assert EntityIndex.fan_out_groups(update, opts(t)) == ["g_victim"]
    end

    test "falls back to the stored row for a patch that omits the source" do
      t = tables()
      :ok = put_membership(t, "todo_victim", "g_victim", "eg_victim")
      :ok = put_rel(t, link_rel("rel_victim", "todo_victim", "col_1"))

      update = %{
        subject_id: "rel_victim",
        subject_type: "relationship",
        method: :patch,
        data: %{"fields" => %{"target_id" => %{"value" => "col_2"}}}
      }

      assert EntityIndex.fan_out_groups(update, opts(t)) == ["g_victim"]
    end

    test "unions a user entity's cached membership with intra-action membership" do
      t = tables()
      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      update = %{subject_id: "todo_1", subject_type: "todo", method: :put, data: %{}}

      assert EntityIndex.fan_out_preference(update, opts(t)) == {:by_id, "todo"}

      assert EntityIndex.fan_out_groups(update, opts(t) ++ [intra_action: %{"todo_1" => ["g_2"]}])
             |> Enum.sort() == ["g_1", "g_2"]
    end
  end

  describe "subject_type/2" do
    test "returns the indexed type for an entity" do
      t = tables()

      :ok = EntityTypeCache.put_type("todo_1", "todo", entity_types: t.entity_types)

      assert EntityIndex.subject_type("todo_1", opts(t)) == "todo"
    end

    test "reads a predecessor batch's planned entity type from the overlay" do
      t = tables()

      update = %{subject_id: "todo_1", subject_type: "todo", method: :put, data: %{}}

      {_mutations, overlay} =
        CacheMutationPlanner.plan([update], %{
          group_members_by_id: t.group_members_by_id,
          entity_groups_by_id: t.entity_groups_by_id
        })

      opts = Keyword.put(opts(t), :overlay, overlay)

      assert EntityIndex.subject_type("todo_1", opts) == "todo"
      assert EntityIndex.exists?("todo_1", opts)
    end

    test "returns nil for an unknown entity" do
      t = tables()

      assert EntityIndex.subject_type("todo_unknown", opts(t)) == nil
    end

    test "raises when the entity_types table is missing from opts" do
      _t = tables()

      assert_raise KeyError, fn -> EntityIndex.subject_type("todo_1", []) end
    end
  end

  describe "membership/2" do
    test "resolves a membership row to its entity and group" do
      t = tables()

      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      assert EntityIndex.membership("eg_1", opts(t)) == {"todo_1", "g_1"}
    end

    test "returns nil for an unknown membership id" do
      t = tables()

      assert EntityIndex.membership("eg_unknown", opts(t)) == nil
    end
  end

  describe "relationship_groups/4" do
    test "prefers the wire source_id for a put on a not-yet-cached row" do
      t = tables()

      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      assert EntityIndex.relationship_groups(:put, "todo_1", "rel_new", opts(t)) == ["g_1"]
    end

    test "falls back to the by-id edge's source on a delete (no wire source)" do
      t = tables()

      :ok = put_membership(t, "todo_1", "g_1", "eg_1")
      :ok = put_rel(t, link_rel("rel_1", "todo_1", "col_1"))

      assert EntityIndex.relationship_groups(:delete, nil, "rel_1", opts(t)) == ["g_1"]
    end

    test "resolves a delete from the stored row, whatever the wire source says" do
      t = tables()

      :ok = put_membership(t, "todo_victim", "g_victim", "eg_victim")
      :ok = put_membership(t, "todo_attacker", "g_attacker", "eg_attacker")
      :ok = put_rel(t, link_rel("rel_victim", "todo_victim", "col_1"))

      assert EntityIndex.relationship_groups(:delete, "todo_attacker", "rel_victim", opts(t)) == [
               "g_victim"
             ]
    end

    test "uses the wire source for a delete when no committed row exists" do
      t = tables()

      :ok = put_membership(t, "todo_1", "g_1", "eg_1")

      assert EntityIndex.relationship_groups(:delete, "todo_1", "rel_new", opts(t)) == ["g_1"]
    end
  end
end
