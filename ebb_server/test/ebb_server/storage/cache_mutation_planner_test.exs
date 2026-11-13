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
  - A relationship row merges the components its Updates do not carry
  """

  use ExUnit.Case, async: true

  alias EbbServer.Storage.CacheMutationPlanner
  alias EbbServer.Storage.CacheMutationPlanner.Overlay
  alias EbbServer.Storage.GroupAppsCache

  import EbbServer.TestHelpers

  setup do
    group_members_by_id = :ets.new(:planner_group_members_by_id, [:set, :public])
    entity_groups_by_id = :ets.new(:planner_entity_groups_by_id, [:set, :public])
    relationships_by_id = :ets.new(:planner_relationships_by_id, [:set, :public])
    group_apps = :ets.new(:planner_group_apps, [:set, :public])

    %{
      tables: %{
        group_members_by_id: group_members_by_id,
        entity_groups_by_id: entity_groups_by_id,
        relationships_by_id: relationships_by_id,
        group_apps: group_apps
      },
      group_members_by_id: group_members_by_id,
      entity_groups_by_id: entity_groups_by_id,
      group_apps: group_apps
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

      todo = update("todo", "todo_1", :put)

      {mutations, _overlay} =
        CacheMutationPlanner.plan([group_member, todo, group_member, todo], tables)

      assert Enum.count(mutations, &match?({:group_member_put, %{id: "gm_1"}}, &1)) == 1
      assert Enum.count(mutations, &match?({:entity_type, "todo_1", "todo"}, &1)) == 1
    end

    test "drops an identical repeated delete", %{tables: tables} do
      delete = update("groupMember", "gm_1", :delete)

      {mutations, overlay} = CacheMutationPlanner.plan([delete, delete], tables)

      assert mutations == [
               {:entity_type, "gm_1", "ebb"},
               {:group_member_delete, "gm_1"}
             ]

      assert Overlay.fetch(overlay, :group_members_by_id, "gm_1") == {:ok, :deleted}
      assert Overlay.fetch(overlay, :entity_types, "gm_1") == {:ok, "ebb"}
    end

    # `GroupCache.put_group_member/2` deletes the primary row by the
    # *incoming* actor, so two different rows for one membership id in a
    # single plan must both be applied: collapsing them would strand the
    # first actor's row.
    test "keeps both writes when one membership id carries two different values", %{
      tables: tables
    } do
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
    test "a successor's value supersedes the predecessor's projection", %{tables: tables} do
      put =
        update("entityGroup", "eg_1", :put, %{"entity_id" => "todo_1", "group_id" => "group_1"})

      {plan_1, overlay_1} = CacheMutationPlanner.plan([put], tables)
      assert [{:entity_type, "eg_1", "ebb"}, {:entity_group_put, row}] = plan_1
      assert row == %{id: "eg_1", entity_id: "todo_1", group_id: "group_1"}

      patch =
        update("entityGroup", "eg_1", :patch, %{"entity_id" => "todo_1", "group_id" => "group_2"})

      {plan_2, overlay_2} = CacheMutationPlanner.plan([patch], tables, overlay_1)

      assert [{:entity_type, "eg_1", "ebb"}, {:entity_group_put, row}] = plan_2
      assert row == %{id: "eg_1", entity_id: "todo_1", group_id: "group_2"}
      assert Overlay.fetch(overlay_2, :entity_groups_by_id, "eg_1") == {:ok, row}
    end

    test "a successor's delete removes the predecessor's planned row", %{tables: tables} do
      put =
        update("groupMember", "gm_1", :put, %{
          "actor_id" => "actor_1",
          "group_id" => "group_1",
          "permissions" => ["todo.create"]
        })

      {_plan_1, overlay_1} = CacheMutationPlanner.plan([put], tables)

      delete = update("groupMember", "gm_1", :delete)

      {plan_2, overlay_2} = CacheMutationPlanner.plan([delete], tables, overlay_1)
      assert [{:entity_type, "gm_1", "ebb"}, {:group_member_delete, "gm_1"}] = plan_2
      assert Overlay.fetch(overlay_2, :group_members_by_id, "gm_1") == {:ok, :deleted}
    end

    test "a planar write moves a membership without consulting the cached row",
         %{tables: tables, group_members_by_id: group_members_by_id} do
      # A stale cached row is not a merge base any more: the atomic value is
      # the row, so the plan carries the wire's actor and permissions only.
      :ets.insert(
        group_members_by_id,
        {"gm_1",
         %{id: "gm_1", actor_id: "actor_old", group_id: "group_old", permissions: ["todo.read"]}}
      )

      patch =
        update("groupMember", "gm_1", :patch, %{
          "actor_id" => "actor_1",
          "group_id" => "group_2",
          "permissions" => ["todo.create"]
        })

      {plan, _overlay} = CacheMutationPlanner.plan([patch], tables)

      assert [_entity_type, {:group_member_put, row}] = plan

      assert row == %{
               id: "gm_1",
               actor_id: "actor_1",
               group_id: "group_2",
               permissions: ["todo.create"]
             }
    end
  end

  describe "abandoning a plan" do
    test "without the predecessor's overlay the successor plans only its own value", %{
      tables: tables
    } do
      put =
        update("groupMember", "gm_1", :put, %{
          "actor_id" => "actor_1",
          "group_id" => "group_1",
          "permissions" => ["todo.create"]
        })

      {_predecessor_mutations, predecessor_overlay} = CacheMutationPlanner.plan([put], tables)

      patch =
        update("groupMember", "gm_1", :patch, %{
          "actor_id" => "actor_1",
          "group_id" => "group_2",
          "permissions" => ["todo.create"]
        })

      {plan_with, _} = CacheMutationPlanner.plan([patch], tables, predecessor_overlay)
      {plan_without, _} = CacheMutationPlanner.plan([patch], tables)

      # The patch's atomic value is the whole row, so releasing the
      # predecessor changes nothing about what the successor projects.
      assert [{:entity_type, _, _}, {:group_member_put, with_puts}] = plan_with
      assert [{:entity_type, _, _}, {:group_member_put, without_puts}] = plan_without
      assert with_puts == without_puts

      assert with_puts == %{
               id: "gm_1",
               actor_id: "actor_1",
               group_id: "group_2",
               permissions: ["todo.create"]
             }
    end
  end

  describe "cross-flush resolution" do
    test "the overlay carries every row's entity model", %{tables: tables} do
      todo = update("todo", "todo_1", :put)

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

      patch =
        update("entityGroup", "eg_1", :patch, %{"entity_id" => "todo_1", "group_id" => "group_2"})

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

      patch =
        update("groupMember", "gm_1", :patch, %{
          "actor_id" => "actor_1",
          "group_id" => "group_1",
          "permissions" => ["todo.read"]
        })

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

      patch =
        update("relationship", "rel_1", :patch, %{
          "source_id" => "todo_1",
          "target_id" => "todo_3",
          "type" => "parent",
          "field" => "parent"
        })

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

      todo = update("todo", "todo_1", :put)
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

      patch =
        update("entityGroup", "eg_1", :patch, %{"entity_id" => "todo_1", "group_id" => "group_2"})

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

  describe "group apps" do
    test "a put writes the group's app list", %{tables: tables} do
      put = group_apps_update("g_1", :put, ["notes"])

      {plan, overlay} = CacheMutationPlanner.plan([put], tables)

      assert plan == [
               {:entity_type, "g_1", "ebb"},
               {:group_apps_put, "g_1", ["notes"]}
             ]

      assert Overlay.fetch(overlay, :group_apps, "g_1") == {:ok, ["notes"]}
    end

    test "a put without an apps key makes the group unscoped", %{tables: tables} do
      put = group_update("g_1", :put, %{"name" => "Group"})

      {plan, overlay} = CacheMutationPlanner.plan([put], tables)

      assert plan == [
               {:entity_type, "g_1", "ebb"},
               {:group_apps_put, "g_1", nil}
             ]

      assert Overlay.fetch(overlay, :group_apps, "g_1") == {:ok, nil}
    end

    test "a patch replaces the whole app list rather than merging it", %{
      tables: tables,
      group_apps: group_apps
    } do
      :ok = GroupAppsCache.put_group_apps("g_1", ["notes", "docs"], group_apps: group_apps)

      patch = group_apps_update("g_1", :patch, ["docs"])

      {plan, overlay} = CacheMutationPlanner.plan([patch], tables)

      # The group value is atomic, so the wire value *is* the scope; a cached
      # per-app entry cannot survive beside it.
      assert plan == [
               {:entity_type, "g_1", "ebb"},
               {:group_apps_put, "g_1", ["docs"]}
             ]

      assert Overlay.fetch(overlay, :group_apps, "g_1") == {:ok, ["docs"]}
    end

    test "two writes in one plan leave the later value", %{tables: tables} do
      first = group_apps_update("g_1", :put, ["notes"])
      second = group_apps_update("g_1", :put, ["docs"])

      {plan, overlay} = CacheMutationPlanner.plan([first, second], tables)

      assert {:group_apps_put, "g_1", ["docs"]} = List.last(plan)
      assert Overlay.fetch(overlay, :group_apps, "g_1") == {:ok, ["docs"]}
    end

    test "a patch that omits apps makes the group unscoped", %{tables: tables} do
      patch = group_update("g_1", :patch, %{"name" => "Renamed"})

      {plan, overlay} = CacheMutationPlanner.plan([patch], tables)

      assert plan == [
               {:entity_type, "g_1", "ebb"},
               {:group_apps_put, "g_1", nil}
             ]

      assert Overlay.fetch(overlay, :group_apps, "g_1") == {:ok, nil}
    end

    test "a delete tombstones the group's scope", %{tables: tables} do
      delete = group_update("g_1", :delete, nil)

      {plan, overlay} = CacheMutationPlanner.plan([delete], tables)

      assert plan == [
               {:entity_type, "g_1", "ebb"},
               {:group_apps_delete, "g_1"}
             ]

      assert Overlay.fetch(overlay, :group_apps, "g_1") == {:ok, :deleted}
    end

    test "group apps do not make a plan group-resolution serializing", %{tables: tables} do
      put = group_apps_update("g_1", :put, ["notes"])

      {_plan, overlay} = CacheMutationPlanner.plan([put], tables)

      refute Overlay.group_resolution_affected?(overlay)
    end

    test "dropping the component deletes the cached scope", %{tables: tables} do
      # A `drop` leaves a zero-component `ebb` row: nothing carries the app
      # scope any more, so the cache row goes with the component.
      drop = %{group_update("g_1", :patch, %{}) | data: %{"fields" => %{}}}

      {plan, overlay} = CacheMutationPlanner.plan([drop], tables)

      assert {:group_apps_delete, "g_1"} in plan
      assert Overlay.fetch(overlay, :group_apps, "g_1") == {:ok, :deleted}
    end
  end

  describe "relationships" do
    test "a link patch projects the whole value the wire carries", %{tables: tables} do
      put =
        update("relationship", "rel_1", :put, %{
          "source_id" => "todo_1",
          "target_id" => "todo_2",
          "type" => "parent",
          "field" => "parent"
        })

      {_plan_1, overlay_1} = CacheMutationPlanner.plan([put], tables)

      patch =
        update("relationship", "rel_1", :patch, %{
          "source_id" => "todo_1",
          "target_id" => "todo_9",
          "type" => "parent",
          "field" => "parent"
        })

      {plan_2, overlay_2} = CacheMutationPlanner.plan([patch], tables, overlay_1)

      assert [
               {:entity_type, "rel_1", "ebb"},
               {:relationship_put,
                %{source_id: "todo_1", target_id: "todo_9", type: "parent", field: "parent"}}
             ] = Enum.sort_by(plan_2, &elem(&1, 0))

      assert {:ok,
              %{
                id: "rel_1",
                source_id: "todo_1",
                target_id: "todo_9",
                type: "parent",
                field: "parent"
              }} = Overlay.fetch(overlay_2, :relationships_by_id, "rel_1")
    end

    test "a link value with no target is not projected", %{tables: tables} do
      put = update("relationship", "rel_1", :put, %{"source_id" => "todo_1"})

      {plan, overlay} = CacheMutationPlanner.plan([put], tables)

      assert plan == [{:entity_type, "rel_1", "ebb"}]
      assert Overlay.fetch(overlay, :relationships_by_id, "rel_1") == :error
    end
  end

  defp group_apps_update(group_id, method, apps) do
    group_update(group_id, method, %{"apps" => apps})
  end

  defp group_update(group_id, method, fields) do
    update("group", group_id, method, fields)
  end

  defp leaf(value, hlc, update_id) do
    %{"type" => "lww", "value" => value, "hlc" => hlc, "update_id" => update_id}
  end

  # A folded row mutation, the planner's input: one row per subject with its
  # whole `fields` map. The four platform components are atomic, so a platform
  # row's fields are the one leaf that carries the whole object.
  @components %{
    "group" => {:group, "group"},
    "groupMember" => {:grant, "grant"},
    "entityGroup" => {:membership, "membership"},
    "relationship" => {:link, "link"}
  }

  defp update(model, subject_id, method, fields \\ %{}) do
    case Map.fetch(@components, model) do
      {:ok, {kind, field}} ->
        %{
          id: "upd_" <> Nanoid.generate(),
          subject_id: subject_id,
          model: "ebb",
          kind: kind,
          components: ["ebb/" <> field],
          method: method,
          data:
            if(method == :delete, do: nil, else: %{"fields" => %{field => leaf(fields, 1, "u1")}})
        }

      :error ->
        hlc = generate_hlc()

        data =
          if method == :delete do
            nil
          else
            %{
              "fields" =>
                Map.new(fields, fn {field, value} ->
                  {field, %{"type" => "lww", "value" => value, "hlc" => hlc}}
                end)
            }
          end

        %{
          id: "upd_" <> Nanoid.generate(),
          subject_id: subject_id,
          model: model,
          kind: nil,
          components: [],
          method: method,
          data: data
        }
    end
  end
end
