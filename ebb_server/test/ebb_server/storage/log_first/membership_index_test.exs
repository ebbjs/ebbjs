defmodule EbbServer.Storage.LogFirst.MembershipIndexTest do
  @moduledoc """
  Pins the D2 resolver's semantics: versions are read at a GSN, a delete is
  resolved before the Action that removes the row, an entity's group set is
  derived from its live rows (so deleting one of two rows in the same group
  keeps the group), and the order the Writer persists is preserved.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Storage.LogFirst.MembershipIndex

  test "a row read is the newest version at or before the GSN" do
    index =
      MembershipIndex.new()
      |> MembershipIndex.put({:model, "todo_1"}, 10, "todo")
      |> MembershipIndex.put({:model, "todo_1"}, 20, "note")

    assert MembershipIndex.get(index, {:model, "todo_1"}, 9) == nil
    assert MembershipIndex.get(index, {:model, "todo_1"}, 10) == "todo"
    assert MembershipIndex.get(index, {:model, "todo_1"}, 19) == "todo"
    assert MembershipIndex.get(index, {:model, "todo_1"}, 20) == "note"
    assert MembershipIndex.get(index, {:model, "todo_1"}, 10_000) == "note"
  end

  test "a repeated value is not a new version" do
    index =
      MembershipIndex.new()
      |> MembershipIndex.put({:model, "todo_1"}, 10, "todo")
      |> MembershipIndex.put({:model, "todo_1"}, 20, "todo")

    assert MembershipIndex.stats(index).versions == 1
  end

  test "an Action's own rows resolve at its own GSN" do
    updates = [
      %{"component" => "todo/title", "subject_id" => "todo_1", "method" => "replace"},
      %{
        "component" => "entityGroup/entity_id",
        "subject_id" => "eg_1",
        "method" => "replace",
        "data" => %{"value" => "todo_1"}
      },
      %{
        "component" => "entityGroup/group_id",
        "subject_id" => "eg_1",
        "method" => "replace",
        "data" => %{"value" => "g_1"}
      },
      %{"component" => "todo/title", "subject_id" => "todo_1", "method" => "replace"}
    ]

    index = MembershipIndex.apply_action(MembershipIndex.new(), 7, updates)

    assert MembershipIndex.scope(index, hd(updates), 7) == ["g_1"]
    assert MembershipIndex.scope(index, List.last(updates), 7) == ["g_1"]
    assert MembershipIndex.scope(index, Enum.at(updates, 1), 7) == ["g_1"]
  end

  test "a delete resolves against the state before the Action" do
    create = [
      %{
        "component" => "entityGroup/entity_id",
        "subject_id" => "eg_1",
        "method" => "replace",
        "data" => %{"value" => "todo_1"}
      },
      %{
        "component" => "entityGroup/group_id",
        "subject_id" => "eg_1",
        "method" => "replace",
        "data" => %{"value" => "g_1"}
      }
    ]

    delete = [%{"subject_id" => "eg_1", "method" => "delete"}]

    index =
      MembershipIndex.new()
      |> MembershipIndex.apply_action(5, create)
      |> MembershipIndex.apply_action(9, delete)

    assert MembershipIndex.scope(index, hd(delete), 9) == ["g_1"]
    assert MembershipIndex.get(index, {:membership, "eg_1"}, 9) == nil

    update = %{"component" => "todo/title", "subject_id" => "todo_1", "method" => "replace"}

    assert MembershipIndex.scope(MembershipIndex.apply_action(index, 10, [update]), update, 10) ==
             []
  end

  test "deleting one of two rows in the same group keeps the group" do
    create = fn entity, row, group ->
      [
        %{
          "component" => "entityGroup/entity_id",
          "subject_id" => row,
          "method" => "replace",
          "data" => %{"value" => entity}
        },
        %{
          "component" => "entityGroup/group_id",
          "subject_id" => row,
          "method" => "replace",
          "data" => %{"value" => group}
        }
      ]
    end

    model = [
      %{"component" => "todo/title", "subject_id" => "todo_1", "method" => "replace"}
    ]

    index =
      MembershipIndex.new()
      |> MembershipIndex.apply_action(1, model ++ create.("todo_1", "eg_a", "g_1"))
      |> MembershipIndex.apply_action(2, create.("todo_1", "eg_b", "g_1"))
      |> MembershipIndex.apply_action(3, [%{"subject_id" => "eg_a", "method" => "delete"}])

    update = %{"component" => "todo/title", "subject_id" => "todo_1", "method" => "replace"}
    assert MembershipIndex.scope(index, update, 3) == ["g_1"]
  end

  test "re-putting a live membership row does not grow the entity's row list" do
    put = fn ->
      [
        %{
          "component" => "entityGroup/entity_id",
          "subject_id" => "eg_1",
          "method" => "replace",
          "data" => %{"value" => "todo_1"}
        },
        %{
          "component" => "entityGroup/group_id",
          "subject_id" => "eg_1",
          "method" => "replace",
          "data" => %{"value" => "g_1"}
        }
      ]
    end

    model = [%{"component" => "todo/title", "subject_id" => "todo_1", "method" => "replace"}]

    index =
      Enum.reduce(1..100, MembershipIndex.new(), fn gsn, acc ->
        MembershipIndex.apply_action(acc, gsn, model ++ put.())
      end)

    assert MembershipIndex.get(index, {:rows, "todo_1"}, 100) == ["eg_1"]

    update = %{"component" => "todo/title", "subject_id" => "todo_1", "method" => "replace"}
    assert MembershipIndex.scope(index, update, 100) == ["g_1"]
  end

  test "scope order is row insertion order, like the cache's bag lookup" do
    add = fn row, group ->
      [
        %{
          "component" => "entityGroup/entity_id",
          "subject_id" => row,
          "method" => "replace",
          "data" => %{"value" => "todo_1"}
        },
        %{
          "component" => "entityGroup/group_id",
          "subject_id" => row,
          "method" => "replace",
          "data" => %{"value" => group}
        }
      ]
    end

    model = [
      %{"component" => "todo/title", "subject_id" => "todo_1", "method" => "replace"}
    ]

    index =
      MembershipIndex.new()
      |> MembershipIndex.apply_action(1, model ++ add.("eg_b", "g_b"))
      |> MembershipIndex.apply_action(2, add.("eg_a", "g_a"))

    update = %{"component" => "todo/title", "subject_id" => "todo_1", "method" => "replace"}
    assert MembershipIndex.scope(index, update, 2) == ["g_b", "g_a"]
  end

  test "prune keeps the newest version at the horizon and drops the rest" do
    index =
      MembershipIndex.new()
      |> MembershipIndex.put({:model, "todo_1"}, 1, "todo")
      |> MembershipIndex.put({:model, "todo_1"}, 10, "note")
      |> MembershipIndex.put({:model, "todo_1"}, 20, "task")

    {pruned, dropped} = MembershipIndex.prune(index, 10)

    assert dropped == 1
    assert MembershipIndex.get(pruned, {:model, "todo_1"}, 10) == "note"
    assert MembershipIndex.get(pruned, {:model, "todo_1"}, 9) == nil
    assert MembershipIndex.get(pruned, {:model, "todo_1"}, 20) == "task"
  end

  test "a user row delete stops resolving even though its rows were filed" do
    updates = [
      %{"component" => "todo/title", "subject_id" => "todo_1", "method" => "replace"},
      %{
        "component" => "entityGroup/entity_id",
        "subject_id" => "eg_1",
        "method" => "replace",
        "data" => %{"value" => "todo_1"}
      },
      %{
        "component" => "entityGroup/group_id",
        "subject_id" => "eg_1",
        "method" => "replace",
        "data" => %{"value" => "g_1"}
      }
    ]

    index =
      MembershipIndex.new()
      |> MembershipIndex.apply_action(1, updates)
      |> MembershipIndex.apply_action(2, [%{"subject_id" => "todo_1", "method" => "delete"}])

    update = %{"component" => "todo/title", "subject_id" => "todo_1", "method" => "replace"}
    assert MembershipIndex.scope(index, update, 2) == []
  end
end
