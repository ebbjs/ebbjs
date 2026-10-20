defmodule EbbServer.Storage.CacheMutationPlannerTest do
  @moduledoc """
  Behavioral tests for CacheMutationPlanner - the pure cache-write plan a
  flush produces from its Updates.

  The planner reads only its explicit `tables` map and the `overlay` it is
  handed, so these tests exercise it with bare ETS tables and no Writer,
  RocksDB, or cache GenServer.

  ## Key Behaviors Tested

  - One mutation per unique cache key per plan
  - The overlay carries an unapplied plan's effects into the next plan
  - A delete in a predecessor plan is visible to a successor's patch
  - Dropping a predecessor's overlay falls back to the pre-plan cache
  - Identical repeats are dropped, distinct rows for one id are not
  - Relationship rows never merge with a cached row
  """

  use ExUnit.Case, async: true

  alias EbbServer.Storage.CacheMutationPlanner
  alias EbbServer.Storage.CacheMutationPlanner.Overlay

  import EbbServer.TestHelpers

  setup do
    group_members_by_id = :ets.new(:planner_group_members_by_id, [:set, :public])
    entity_groups_by_id = :ets.new(:planner_entity_groups_by_id, [:set, :public])

    %{
      tables: %{
        group_members_by_id: group_members_by_id,
        entity_groups_by_id: entity_groups_by_id
      },
      group_members_by_id: group_members_by_id,
      entity_groups_by_id: entity_groups_by_id
    }
  end

  describe "coalescing" do
    test "keeps one mutation per unique cache key per plan", %{tables: tables} do
      group_member =
        update("groupMember", "gm_1", :put, %{
          "actor_id" => "actor_1",
          "group_id" => "group_1",
          "permissions" => ["todo.create"]
        })

      todo = validated_update(%{subject_id: "todo_1", subject_type: "todo"})

      {mutations, _overlay} =
        CacheMutationPlanner.plan([group_member, todo, group_member, todo], tables)

      assert Enum.count(mutations, &match?({:group_member_put, %{id: "gm_1"}}, &1)) == 1
      assert Enum.count(mutations, &match?({:entity_type, "todo_1", "todo"}, &1)) == 1
    end

    test "drops an identical repeated delete", %{tables: tables} do
      delete = update("groupMember", "gm_1", :delete)

      {mutations, overlay} = CacheMutationPlanner.plan([delete, delete], tables)

      assert mutations == [
               {:entity_type, "gm_1", "groupMember"},
               {:group_member_delete, "gm_1"}
             ]

      assert Overlay.fetch(overlay, :group_members_by_id, "gm_1") == {:ok, :deleted}
      assert Overlay.fetch(overlay, :entity_types, "gm_1") == {:ok, "groupMember"}
    end

    # `GroupCache.put_group_member/2` deletes the primary row by the
    # *incoming* actor, so two different rows for one membership id in a
    # single plan must both be applied: collapsing them would strand the
    # first actor's row.
    test "keeps both rows when one membership id carries two different rows", %{tables: tables} do
      put_a =
        update("groupMember", "gm_1", :put, %{
          "actor_id" => "actor_a",
          "group_id" => "group_1",
          "permissions" => ["todo.create"]
        })

      put_b =
        update("groupMember", "gm_1", :put, %{
          "actor_id" => "actor_b",
          "group_id" => "group_1",
          "permissions" => ["todo.read"]
        })

      {mutations, overlay} = CacheMutationPlanner.plan([put_a, put_b], tables)

      assert [
               {:group_member_put, %{actor_id: "actor_a"}},
               {:group_member_put, %{actor_id: "actor_b"}}
             ] =
               Enum.filter(mutations, &match?({:group_member_put, _}, &1))

      assert {:ok, %{actor_id: "actor_b"}} =
               Overlay.fetch(overlay, :group_members_by_id, "gm_1")
    end
  end

  describe "overlay chaining" do
    test "a successor's patch merges over the predecessor's unapplied put", %{tables: tables} do
      put =
        update("entityGroup", "eg_1", :put, %{"entity_id" => "todo_1", "group_id" => "group_1"})

      {plan_1, overlay_1} = CacheMutationPlanner.plan([put], tables)
      assert [{:entity_type, "eg_1", "entityGroup"}, {:entity_group_put, row}] = plan_1
      assert row == %{id: "eg_1", entity_id: "todo_1", group_id: "group_1"}

      patch = update("entityGroup", "eg_1", :patch, %{"group_id" => "group_2"})

      {plan_2, overlay_2} = CacheMutationPlanner.plan([patch], tables, overlay_1)

      assert [{:entity_type, "eg_1", "entityGroup"}, {:entity_group_put, row}] = plan_2
      assert row == %{id: "eg_1", entity_id: "todo_1", group_id: "group_2"}
      assert Overlay.fetch(overlay_2, :entity_groups_by_id, "eg_1") == {:ok, row}
    end

    test "a successor's patch sees the predecessor's delete and does not resurrect",
         %{tables: tables, group_members_by_id: group_members_by_id} do
      # A pre-plan row the tombstone has to hide: without the delete in the
      # overlay the patch would merge this row and resurrect the membership.
      :ets.insert(
        group_members_by_id,
        {"gm_1",
         %{id: "gm_1", actor_id: "actor_old", group_id: "group_old", permissions: ["todo.read"]}}
      )

      put =
        update("groupMember", "gm_1", :put, %{
          "actor_id" => "actor_1",
          "group_id" => "group_1",
          "permissions" => ["todo.create"]
        })

      {_plan_1, overlay_1} = CacheMutationPlanner.plan([put], tables)

      delete = update("groupMember", "gm_1", :delete)

      {plan_2, overlay_2} = CacheMutationPlanner.plan([delete], tables, overlay_1)
      assert [{:entity_type, "gm_1", "groupMember"}, {:group_member_delete, "gm_1"}] = plan_2

      patch = update("groupMember", "gm_1", :patch, %{"group_id" => "group_2"})

      {plan_3, _overlay_3} = CacheMutationPlanner.plan([patch], tables, overlay_2)

      assert plan_3 == [{:entity_type, "gm_1", "groupMember"}]
    end

    test "a successor's patch moves a membership and keeps the fields it omits",
         %{tables: tables} do
      put =
        update("groupMember", "gm_1", :put, %{
          "actor_id" => "actor_1",
          "group_id" => "group_1",
          "permissions" => ["todo.create"]
        })

      {_plan_1, overlay_1} = CacheMutationPlanner.plan([put], tables)

      patch = update("groupMember", "gm_1", :patch, %{"group_id" => "group_2"})

      {plan_2, _overlay_2} = CacheMutationPlanner.plan([patch], tables, overlay_1)

      assert [_entity_type, {:group_member_put, row}] = plan_2

      assert row == %{
               id: "gm_1",
               actor_id: "actor_1",
               group_id: "group_2",
               permissions: ["todo.create"]
             }
    end
  end

  describe "abandoning a plan" do
    test "without the predecessor's overlay the patch resolves against the pre-plan cache", %{
      tables: tables,
      group_members_by_id: group_members_by_id
    } do
      :ets.insert(
        group_members_by_id,
        {"gm_1",
         %{id: "gm_1", actor_id: "actor_old", group_id: "group_old", permissions: ["todo.read"]}}
      )

      put =
        update("groupMember", "gm_1", :put, %{
          "actor_id" => "actor_1",
          "group_id" => "group_1",
          "permissions" => ["todo.create"]
        })

      {_predecessor_mutations, predecessor_overlay} = CacheMutationPlanner.plan([put], tables)

      patch = update("groupMember", "gm_1", :patch, %{"group_id" => "group_2"})

      {plan_with, _} = CacheMutationPlanner.plan([patch], tables, predecessor_overlay)
      {plan_without, _} = CacheMutationPlanner.plan([patch], tables)

      assert [{:entity_type, _, _}, {:group_member_put, with_puts}] = plan_with
      assert with_puts.actor_id == "actor_1"
      assert with_puts.permissions == ["todo.create"]

      assert [{:entity_type, _, _}, {:group_member_put, without_puts}] = plan_without
      assert without_puts.actor_id == "actor_old"
      assert without_puts.permissions == ["todo.read"]
      assert without_puts.group_id == "group_2"
    end
  end

  describe "cross-flush resolution" do
    test "the overlay carries every Update's entity type", %{tables: tables} do
      todo = validated_update(%{subject_id: "todo_1", subject_type: "todo"})

      {_mutations, overlay} = CacheMutationPlanner.plan([todo], tables)

      assert Overlay.fetch(overlay, :entity_types, "todo_1") == {:ok, "todo"}
    end

    test "an entityGroup put projects the entity to its planned groups", %{tables: tables} do
      put =
        update("entityGroup", "eg_1", :put, %{"entity_id" => "todo_1", "group_id" => "group_1"})

      {_mutations, overlay} = CacheMutationPlanner.plan([put], tables)

      assert Overlay.entity_groups(overlay, "todo_1", []) == {:ok, ["group_1"]}
    end

    test "a membership move replaces the cached group in the projection", %{tables: tables} do
      put =
        update("entityGroup", "eg_1", :put, %{"entity_id" => "todo_1", "group_id" => "group_1"})

      {_mutations, overlay_1} = CacheMutationPlanner.plan([put], tables)

      patch = update("entityGroup", "eg_1", :patch, %{"group_id" => "group_2"})

      {_mutations, overlay_2} = CacheMutationPlanner.plan([patch], tables, overlay_1)

      cached = [%{id: "eg_1", entity_id: "todo_1", group_id: "group_1"}]

      assert Overlay.entity_groups(overlay_2, "todo_1", cached) == {:ok, ["group_2"]}
    end

    test "a delete removes the cached group from the projection", %{
      tables: tables,
      entity_groups_by_id: entity_groups_by_id
    } do
      :ets.insert(
        entity_groups_by_id,
        {"eg_1", %{id: "eg_1", entity_id: "todo_1", group_id: "group_1"}}
      )

      delete = update("entityGroup", "eg_1", :delete)

      {_mutations, overlay} = CacheMutationPlanner.plan([delete], tables)

      cached = [%{id: "eg_1", entity_id: "todo_1", group_id: "group_1"}]

      assert Overlay.entity_groups(overlay, "todo_1", cached) == {:ok, []}
    end

    test "put -> patch -> delete chains across plans for one groupMember", %{tables: tables} do
      put =
        update("groupMember", "gm_1", :put, %{
          "actor_id" => "actor_1",
          "group_id" => "group_1",
          "permissions" => ["todo.create"]
        })

      {_mutations_1, overlay_1} = CacheMutationPlanner.plan([put], tables)
      patch = update("groupMember", "gm_1", :patch, %{"permissions" => ["todo.read"]})

      {_mutations_2, overlay_2} = CacheMutationPlanner.plan([patch], tables, overlay_1)
      delete = update("groupMember", "gm_1", :delete)

      {_mutations_3, overlay_3} = CacheMutationPlanner.plan([delete], tables, overlay_2)

      assert Overlay.fetch(overlay_3, :group_members_by_id, "gm_1") == {:ok, :deleted}
    end

    test "put -> patch -> delete chains across plans for one relationship", %{tables: tables} do
      put =
        update("relationship", "rel_1", :put, %{
          "source_id" => "todo_1",
          "target_id" => "todo_2",
          "type" => "parent",
          "field" => "parent"
        })

      {_mutations_1, overlay_1} = CacheMutationPlanner.plan([put], tables)
      patch = update("relationship", "rel_1", :patch, %{"target_id" => "todo_3"})

      {_mutations_2, overlay_2} = CacheMutationPlanner.plan([patch], tables, overlay_1)
      delete = update("relationship", "rel_1", :delete)

      {_mutations_3, overlay_3} = CacheMutationPlanner.plan([delete], tables, overlay_2)

      assert Overlay.fetch(overlay_3, :relationships_by_id, "rel_1") == {:ok, :deleted}
    end

    test "a delete in the predecessor stays deleted after the successor's own plan", %{
      tables: tables,
      entity_groups_by_id: entity_groups_by_id
    } do
      :ets.insert(
        entity_groups_by_id,
        {"eg_1", %{id: "eg_1", entity_id: "todo_1", group_id: "group_1"}}
      )

      {_mutations_1, overlay_1} =
        CacheMutationPlanner.plan([update("entityGroup", "eg_1", :delete)], tables)

      todo = validated_update(%{subject_id: "todo_1", subject_type: "todo"})
      {_mutations_2, overlay_2} = CacheMutationPlanner.plan([todo], tables, overlay_1)

      cached = [%{id: "eg_1", entity_id: "todo_1", group_id: "group_1"}]

      assert Overlay.entity_groups(overlay_2, "todo_1", cached) == {:ok, []}
    end

    test "two batches put the same entity into different groups", %{tables: tables} do
      first =
        update("entityGroup", "eg_1", :put, %{
          "entity_id" => "todo_1",
          "group_id" => "group_1"
        })

      {_mutations_1, overlay_1} = CacheMutationPlanner.plan([first], tables)

      second =
        update("entityGroup", "eg_2", :put, %{
          "entity_id" => "todo_1",
          "group_id" => "group_2"
        })

      {_mutations_2, overlay_2} = CacheMutationPlanner.plan([second], tables, overlay_1)

      assert Overlay.entity_groups(overlay_2, "todo_1", []) == {:ok, ["group_1", "group_2"]}
    end

    test "three plans accumulate and releasing the oldest keeps the rest", %{tables: tables} do
      put = fn id, group ->
        update("entityGroup", id, :put, %{"entity_id" => "todo_1", "group_id" => group})
      end

      {mutations_1, overlay_1} = CacheMutationPlanner.plan([put.("eg_1", "group_1")], tables)

      {mutations_2, overlay_2} =
        CacheMutationPlanner.plan([put.("eg_2", "group_2")], tables, overlay_1)

      {mutations_3, overlay_3} =
        CacheMutationPlanner.plan([put.("eg_3", "group_3")], tables, overlay_2)

      slices = [
        CacheMutationPlanner.slice(overlay_1, mutations_1),
        CacheMutationPlanner.slice(overlay_2, mutations_2),
        CacheMutationPlanner.slice(overlay_3, mutations_3)
      ]

      assert Overlay.entity_groups(CacheMutationPlanner.merge_overlays(slices), "todo_1", []) ==
               {:ok, ["group_1", "group_2", "group_3"]}

      assert Overlay.entity_groups(
               CacheMutationPlanner.merge_overlays(Enum.drop(slices, 1)),
               "todo_1",
               []
             ) ==
               {:ok, ["group_2", "group_3"]}
    end

    test "a released slice leaves the successor's own writes intact", %{tables: tables} do
      put =
        update("entityGroup", "eg_1", :put, %{"entity_id" => "todo_1", "group_id" => "group_1"})

      {mutations_1, overlay_1} = CacheMutationPlanner.plan([put], tables)
      slice_1 = CacheMutationPlanner.slice(overlay_1, mutations_1)

      patch = update("entityGroup", "eg_1", :patch, %{"group_id" => "group_2"})

      {mutations_2, overlay_2} = CacheMutationPlanner.plan([patch], tables, overlay_1)
      slice_2 = CacheMutationPlanner.slice(overlay_2, mutations_2)

      assert Overlay.entity_groups(
               CacheMutationPlanner.merge_overlays([slice_1, slice_2]),
               "todo_1",
               []
             ) ==
               {:ok, ["group_2"]}

      assert Overlay.entity_groups(CacheMutationPlanner.merge_overlays([slice_2]), "todo_1", []) ==
               {:ok, ["group_2"]}
    end
  end

  describe "relationships" do
    test "a relationship patch does not merge the row it replaces", %{tables: tables} do
      put =
        update("relationship", "rel_1", :put, %{
          "source_id" => "todo_1",
          "target_id" => "todo_2",
          "type" => "parent",
          "field" => "parent"
        })

      {_plan_1, overlay_1} = CacheMutationPlanner.plan([put], tables)

      patch = update("relationship", "rel_1", :patch, %{"source_id" => "todo_9"})

      {plan_2, overlay_2} = CacheMutationPlanner.plan([patch], tables, overlay_1)

      # The wire fields are authoritative: the patch omits `target_id`, so
      # it emits no row rather than reusing the planned one.
      assert plan_2 == [{:entity_type, "rel_1", "relationship"}]

      assert {:ok,
              %{
                id: "rel_1",
                source_id: "todo_1",
                target_id: "todo_2",
                type: "parent",
                field: "parent"
              }} = Overlay.fetch(overlay_2, :relationships_by_id, "rel_1")
    end
  end

  defp update(subject_type, subject_id, method, fields \\ %{}) do
    hlc = generate_hlc()

    data = %{
      "fields" =>
        Map.new(fields, fn {field, value} ->
          {field, %{"type" => "lww", "value" => value, "hlc" => hlc}}
        end)
    }

    %{
      id: "upd_" <> Nanoid.generate(),
      subject_id: subject_id,
      subject_type: subject_type,
      method: method,
      data: data
    }
  end
end
