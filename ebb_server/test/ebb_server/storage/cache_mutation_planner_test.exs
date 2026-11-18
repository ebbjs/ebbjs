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
  """

  use ExUnit.Case, async: true

  alias EbbServer.Storage.CacheMutationPlanner
  alias EbbServer.Storage.CacheMutationPlanner.Overlay
  alias EbbServer.Storage.GroupAppsCache

  import EbbServer.TestHelpers

  setup do
    grants_by_id = :ets.new(:planner_grants_by_id, [:set, :public])
    memberships_by_id = :ets.new(:planner_memberships_by_id, [:set, :public])
    group_apps = :ets.new(:planner_group_apps, [:set, :public])

    %{
      tables: %{
        grants_by_id: grants_by_id,
        memberships_by_id: memberships_by_id,
        group_apps: group_apps
      },
      grants_by_id: grants_by_id,
      memberships_by_id: memberships_by_id,
      group_apps: group_apps
    }
  end

  describe "coalescing" do
    test "keeps one mutation per unique cache key per plan", %{tables: tables} do
      grant =
        create("grant", "gm_1", %{
          "actor_id" => "actor_1",
          "group_id" => "group_1",
          "permissions" => ["todo.create"]
        })

      todo = create("todo", "todo_1")

      {mutations, _overlay} =
        CacheMutationPlanner.plan([grant, todo, grant, todo], tables)

      assert Enum.count(mutations, &match?({:grant_put, %{id: "gm_1"}}, &1)) == 1
      assert Enum.count(mutations, &match?({:entity_model, "todo_1", "todo"}, &1)) == 1
    end

    test "drops an identical repeated delete", %{tables: tables} do
      delete = delete_row("grant", "gm_1")

      {mutations, overlay} = CacheMutationPlanner.plan([delete, delete], tables)

      assert mutations == [
               {:entity_model, "gm_1", "ebb"},
               {:grant_delete, "gm_1"}
             ]

      assert Overlay.fetch(overlay, :grants_by_id, "gm_1") == {:ok, :deleted}
      assert Overlay.fetch(overlay, :entity_models, "gm_1") == {:ok, "ebb"}
    end

    # `GrantCache.put_grant/2` deletes the primary row by the
    # *incoming* actor, so two different rows for one membership id in a
    # single plan must both be applied: collapsing them would strand the
    # first actor's row.
    test "keeps both writes when one membership id carries two different values", %{
      tables: tables
    } do
      put_a =
        create("grant", "gm_1", %{
          "actor_id" => "actor_a",
          "group_id" => "group_1",
          "permissions" => ["todo.create"]
        })

      put_b =
        create("grant", "gm_1", %{
          "actor_id" => "actor_b",
          "group_id" => "group_1",
          "permissions" => ["todo.read"]
        })

      {mutations, overlay} = CacheMutationPlanner.plan([put_a, put_b], tables)

      assert [
               {:grant_put, %{actor_id: "actor_a"}},
               {:grant_put, %{actor_id: "actor_b"}}
             ] =
               Enum.filter(mutations, &match?({:grant_put, _}, &1))

      assert {:ok, %{actor_id: "actor_b"}} =
               Overlay.fetch(overlay, :grants_by_id, "gm_1")
    end
  end

  describe "overlay chaining" do
    test "a successor's value supersedes the predecessor's projection", %{tables: tables} do
      put =
        create("membership", "eg_1", %{"entity_id" => "todo_1", "group_id" => "group_1"})

      {plan_1, overlay_1} = CacheMutationPlanner.plan([put], tables)
      assert [{:entity_model, "eg_1", "ebb"}, {:membership_put, row}] = plan_1
      assert row == %{id: "eg_1", entity_id: "todo_1", group_id: "group_1"}

      patch =
        write("membership", "eg_1", %{"entity_id" => "todo_1", "group_id" => "group_2"})

      {plan_2, overlay_2} = CacheMutationPlanner.plan([patch], tables, overlay_1)

      assert [{:entity_model, "eg_1", "ebb"}, {:membership_put, row}] = plan_2
      assert row == %{id: "eg_1", entity_id: "todo_1", group_id: "group_2"}
      assert Overlay.fetch(overlay_2, :memberships_by_id, "eg_1") == {:ok, row}
    end

    test "a successor's delete removes the predecessor's planned row", %{tables: tables} do
      put =
        create("grant", "gm_1", %{
          "actor_id" => "actor_1",
          "group_id" => "group_1",
          "permissions" => ["todo.create"]
        })

      {_plan_1, overlay_1} = CacheMutationPlanner.plan([put], tables)

      delete = delete_row("grant", "gm_1")

      {plan_2, overlay_2} = CacheMutationPlanner.plan([delete], tables, overlay_1)
      assert [{:entity_model, "gm_1", "ebb"}, {:grant_delete, "gm_1"}] = plan_2
      assert Overlay.fetch(overlay_2, :grants_by_id, "gm_1") == {:ok, :deleted}
    end

    test "a patch writes the whole value without consulting the cached row",
         %{tables: tables, grants_by_id: grants_by_id} do
      # A stale cached row is not a merge base any more: the atomic value is
      # the row, so the plan carries the wire's actor and permissions only.
      :ets.insert(
        grants_by_id,
        {"gm_1",
         %{id: "gm_1", actor_id: "actor_old", group_id: "group_old", permissions: ["todo.read"]}}
      )

      patch =
        write("grant", "gm_1", %{
          "actor_id" => "actor_1",
          "group_id" => "group_2",
          "permissions" => ["todo.create"]
        })

      {plan, _overlay} = CacheMutationPlanner.plan([patch], tables)

      assert [_entity_model, {:grant_put, row}] = plan

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
        create("grant", "gm_1", %{
          "actor_id" => "actor_1",
          "group_id" => "group_1",
          "permissions" => ["todo.create"]
        })

      {_predecessor_mutations, predecessor_overlay} = CacheMutationPlanner.plan([put], tables)

      patch =
        write("grant", "gm_1", %{
          "actor_id" => "actor_1",
          "group_id" => "group_2",
          "permissions" => ["todo.create"]
        })

      {plan_with, _} = CacheMutationPlanner.plan([patch], tables, predecessor_overlay)
      {plan_without, _} = CacheMutationPlanner.plan([patch], tables)

      # The patch's atomic value is the whole row, so releasing the
      # predecessor changes nothing about what the successor projects.
      assert [{:entity_model, _, _}, {:grant_put, with_puts}] = plan_with
      assert [{:entity_model, _, _}, {:grant_put, without_puts}] = plan_without
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
      todo = create("todo", "todo_1")

      {_mutations, overlay} = CacheMutationPlanner.plan([todo], tables)

      assert Overlay.fetch(overlay, :entity_models, "todo_1") == {:ok, "todo"}
    end

    test "an membership put projects the entity to its planned groups", %{tables: tables} do
      put =
        create("membership", "eg_1", %{"entity_id" => "todo_1", "group_id" => "group_1"})

      {_mutations, overlay} = CacheMutationPlanner.plan([put], tables)

      assert Overlay.memberships(overlay, "todo_1", []) == {:ok, ["group_1"]}
    end

    test "a membership move replaces the cached group in the projection", %{tables: tables} do
      put =
        create("membership", "eg_1", %{"entity_id" => "todo_1", "group_id" => "group_1"})

      {_mutations, overlay_1} = CacheMutationPlanner.plan([put], tables)

      patch =
        write("membership", "eg_1", %{"entity_id" => "todo_1", "group_id" => "group_2"})

      {_mutations, overlay_2} = CacheMutationPlanner.plan([patch], tables, overlay_1)

      cached = [%{id: "eg_1", entity_id: "todo_1", group_id: "group_1"}]

      assert Overlay.memberships(overlay_2, "todo_1", cached) == {:ok, ["group_2"]}
    end

    test "a delete removes the cached group from the projection", %{
      tables: tables,
      memberships_by_id: memberships_by_id
    } do
      :ets.insert(
        memberships_by_id,
        {"eg_1", %{id: "eg_1", entity_id: "todo_1", group_id: "group_1"}}
      )

      delete = delete_row("membership", "eg_1")

      {_mutations, overlay} = CacheMutationPlanner.plan([delete], tables)

      cached = [%{id: "eg_1", entity_id: "todo_1", group_id: "group_1"}]

      assert Overlay.memberships(overlay, "todo_1", cached) == {:ok, []}
    end

    test "put -> patch -> delete chains across plans for one grant", %{tables: tables} do
      put =
        create("grant", "gm_1", %{
          "actor_id" => "actor_1",
          "group_id" => "group_1",
          "permissions" => ["todo.create"]
        })

      {_mutations_1, overlay_1} = CacheMutationPlanner.plan([put], tables)

      patch =
        write("grant", "gm_1", %{
          "actor_id" => "actor_1",
          "group_id" => "group_1",
          "permissions" => ["todo.read"]
        })

      {_mutations_2, overlay_2} = CacheMutationPlanner.plan([patch], tables, overlay_1)
      delete = delete_row("grant", "gm_1")

      {_mutations_3, overlay_3} = CacheMutationPlanner.plan([delete], tables, overlay_2)

      assert Overlay.fetch(overlay_3, :grants_by_id, "gm_1") == {:ok, :deleted}
    end

    test "a delete in the predecessor stays deleted after the successor's own plan", %{
      tables: tables,
      memberships_by_id: memberships_by_id
    } do
      :ets.insert(
        memberships_by_id,
        {"eg_1", %{id: "eg_1", entity_id: "todo_1", group_id: "group_1"}}
      )

      {_mutations_1, overlay_1} =
        CacheMutationPlanner.plan([delete_row("membership", "eg_1")], tables)

      todo = create("todo", "todo_1")
      {_mutations_2, overlay_2} = CacheMutationPlanner.plan([todo], tables, overlay_1)

      cached = [%{id: "eg_1", entity_id: "todo_1", group_id: "group_1"}]

      assert Overlay.memberships(overlay_2, "todo_1", cached) == {:ok, []}
    end

    test "two batches put the same entity into different groups", %{tables: tables} do
      first =
        create("membership", "eg_1", %{
          "entity_id" => "todo_1",
          "group_id" => "group_1"
        })

      {_mutations_1, overlay_1} = CacheMutationPlanner.plan([first], tables)

      second =
        create("membership", "eg_2", %{
          "entity_id" => "todo_1",
          "group_id" => "group_2"
        })

      {_mutations_2, overlay_2} = CacheMutationPlanner.plan([second], tables, overlay_1)

      assert Overlay.memberships(overlay_2, "todo_1", []) == {:ok, ["group_1", "group_2"]}
    end

    test "three plans accumulate and releasing the oldest keeps the rest", %{tables: tables} do
      put = fn id, group ->
        create("membership", id, %{"entity_id" => "todo_1", "group_id" => group})
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

      assert Overlay.memberships(CacheMutationPlanner.merge_overlays(slices), "todo_1", []) ==
               {:ok, ["group_1", "group_2", "group_3"]}

      assert Overlay.memberships(
               CacheMutationPlanner.merge_overlays(Enum.drop(slices, 1)),
               "todo_1",
               []
             ) ==
               {:ok, ["group_2", "group_3"]}
    end

    test "a released slice leaves the successor's own writes intact", %{tables: tables} do
      put =
        create("membership", "eg_1", %{"entity_id" => "todo_1", "group_id" => "group_1"})

      {mutations_1, overlay_1} = CacheMutationPlanner.plan([put], tables)
      slice_1 = CacheMutationPlanner.slice(overlay_1, mutations_1)

      patch =
        write("membership", "eg_1", %{"entity_id" => "todo_1", "group_id" => "group_2"})

      {mutations_2, overlay_2} = CacheMutationPlanner.plan([patch], tables, overlay_1)
      slice_2 = CacheMutationPlanner.slice(overlay_2, mutations_2)

      assert Overlay.memberships(
               CacheMutationPlanner.merge_overlays([slice_1, slice_2]),
               "todo_1",
               []
             ) ==
               {:ok, ["group_2"]}

      assert Overlay.memberships(CacheMutationPlanner.merge_overlays([slice_2]), "todo_1", []) ==
               {:ok, ["group_2"]}
    end
  end

  describe "group apps" do
    test "a put writes the group's app list", %{tables: tables} do
      put = group_apps_create("g_1", ["notes"])

      {plan, overlay} = CacheMutationPlanner.plan([put], tables)

      assert plan == [
               {:entity_model, "g_1", "ebb"},
               {:group_apps_put, "g_1", ["notes"]}
             ]

      assert Overlay.fetch(overlay, :group_apps, "g_1") == {:ok, ["notes"]}
    end

    test "a put without an apps key makes the group unscoped", %{tables: tables} do
      put = group_create("g_1", %{"name" => "Group"})

      {plan, overlay} = CacheMutationPlanner.plan([put], tables)

      assert plan == [
               {:entity_model, "g_1", "ebb"},
               {:group_apps_put, "g_1", nil}
             ]

      assert Overlay.fetch(overlay, :group_apps, "g_1") == {:ok, nil}
    end

    test "a patch replaces the whole app list rather than merging it", %{
      tables: tables,
      group_apps: group_apps
    } do
      :ok = GroupAppsCache.put_group_apps("g_1", ["notes", "docs"], group_apps: group_apps)

      patch = group_apps_write("g_1", ["docs"])

      {plan, overlay} = CacheMutationPlanner.plan([patch], tables)

      # The group value is atomic, so the wire value *is* the scope; a cached
      # per-app entry cannot survive beside it.
      assert plan == [
               {:entity_model, "g_1", "ebb"},
               {:group_apps_put, "g_1", ["docs"]}
             ]

      assert Overlay.fetch(overlay, :group_apps, "g_1") == {:ok, ["docs"]}
    end

    test "two writes in one plan leave the later value", %{tables: tables} do
      first = group_apps_create("g_1", ["notes"])
      second = group_apps_create("g_1", ["docs"])

      {plan, overlay} = CacheMutationPlanner.plan([first, second], tables)

      assert {:group_apps_put, "g_1", ["docs"]} = List.last(plan)
      assert Overlay.fetch(overlay, :group_apps, "g_1") == {:ok, ["docs"]}
    end

    test "a patch that omits apps makes the group unscoped", %{tables: tables} do
      patch = group_write("g_1", %{"name" => "Renamed"})

      {plan, overlay} = CacheMutationPlanner.plan([patch], tables)

      assert plan == [
               {:entity_model, "g_1", "ebb"},
               {:group_apps_put, "g_1", nil}
             ]

      assert Overlay.fetch(overlay, :group_apps, "g_1") == {:ok, nil}
    end

    test "a delete tombstones the group's scope", %{tables: tables} do
      delete = group_delete("g_1")

      {plan, overlay} = CacheMutationPlanner.plan([delete], tables)

      assert plan == [
               {:entity_model, "g_1", "ebb"},
               {:group_apps_delete, "g_1"}
             ]

      assert Overlay.fetch(overlay, :group_apps, "g_1") == {:ok, :deleted}
    end

    test "group apps do not make a plan group-resolution serializing", %{tables: tables} do
      put = group_apps_create("g_1", ["notes"])

      {_plan, overlay} = CacheMutationPlanner.plan([put], tables)

      refute Overlay.group_resolution_affected?(overlay)
    end

    test "dropping the component deletes the cached scope", %{tables: tables} do
      # A `drop` leaves a zero-component `ebb` row: nothing carries the app
      # scope any more, so the cache row goes with the component.
      drop = %{group_write("g_1", %{}) | data: %{"fields" => %{}}}

      {plan, overlay} = CacheMutationPlanner.plan([drop], tables)

      assert {:group_apps_delete, "g_1"} in plan
      assert Overlay.fetch(overlay, :group_apps, "g_1") == {:ok, :deleted}
    end
  end

  defp group_apps_create(group_id, apps), do: group_create(group_id, %{"apps" => apps})

  defp group_apps_write(group_id, apps), do: group_write(group_id, %{"apps" => apps})

  defp group_create(group_id, fields), do: create("group", group_id, fields)

  defp group_write(group_id, fields), do: write("group", group_id, fields)

  defp group_delete(group_id), do: delete_row("group", group_id)

  defp leaf(value, hlc, update_id) do
    %{"type" => "lww", "value" => value, "hlc" => hlc, "update_id" => update_id}
  end

  # A folded row mutation, the planner's input: one row per subject, whether
  # the Action creates or deletes it, and its whole `fields` map. The three
  # cached platform components are atomic, so a platform row's fields are the
  # one leaf that carries the whole object.
  @components %{
    "group" => {:group, "group"},
    "grant" => {:grant, "grant"},
    "membership" => {:membership, "membership"}
  }

  defp create(model, subject_id, fields \\ %{}),
    do: folded(model, subject_id, %{created?: true, deleted?: false}, fields)

  defp write(model, subject_id, fields),
    do: folded(model, subject_id, %{created?: false, deleted?: false}, fields)

  defp delete_row(model, subject_id),
    do: folded(model, subject_id, %{created?: false, deleted?: true}, nil)

  defp folded(model, subject_id, facts, fields) do
    facts = Map.merge(facts, %{id: "upd_" <> Nanoid.generate(), subject_id: subject_id})

    case Map.fetch(@components, model) do
      {:ok, {kind, field}} ->
        data = unless facts.deleted?, do: %{"fields" => %{field => leaf(fields, 1, "u1")}}
        Map.merge(facts, %{model: "ebb", kind: kind, data: data})

      :error ->
        Map.merge(facts, %{model: model, kind: nil, data: user_data(facts.deleted?, fields)})
    end
  end

  defp user_data(true = _deleted?, _fields), do: nil

  defp user_data(false, fields) do
    hlc = generate_hlc()

    %{
      "fields" =>
        Map.new(fields, fn {field, value} ->
          {field, %{"type" => "lww", "value" => value, "hlc" => hlc}}
        end)
    }
  end
end
