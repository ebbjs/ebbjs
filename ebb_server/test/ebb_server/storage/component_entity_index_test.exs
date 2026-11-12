defmodule EbbServer.Storage.ComponentEntityIndexTest do
  @moduledoc """
  The derived index's op plan and in-memory store (#849).

  The boot seed and the Writer are exercised elsewhere; these tests pin the
  two key kinds, the last-wins reduction, and the range reader the in-memory
  store has to preserve from the column-family version.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Storage.ComponentEntityIndex

  setup do
    unique = System.unique_integer([:positive])

    tables = [
      name: :"component_entity_index_#{unique}",
      component_index: :"component_index_#{unique}",
      component_entity_labels: :"component_entity_labels_#{unique}"
    ]

    {:ok, pid} = ComponentEntityIndex.start_link(tables)
    on_exit(fn -> if Process.alive?(pid), do: GenServer.stop(pid) end)

    %{tables: tables}
  end

  describe "op plan" do
    test "a value Update puts its component entry and a delete names no component" do
      updates = [
        update("todo/title", "todo_1", :replace),
        update("todo/status", "todo_1", :merge),
        %{update("todo/title", "todo_2", :drop) | method: :drop},
        %{subject_id: "todo_3", method: :delete, component: nil}
      ]

      assert ComponentEntityIndex.update_ops(updates) == [
               {:put, {"todo/title", "todo_1"}},
               {:put, {"todo/status", "todo_1"}},
               {:delete, {"todo/title", "todo_2"}}
             ]
    end

    test "the model entry is put once per folded subject and survives a delete" do
      assert ComponentEntityIndex.action_ops(
               [%{subject_id: "todo_1", method: :delete, component: nil}],
               [{"todo", "todo_1"}, {nil, "todo_2"}]
             ) == [{:put, {"todo", "todo_1"}}]
    end

    test "reduce_ops keeps the last write per key in order" do
      ops = [
        {:put, {"todo/title", "todo_1"}},
        {:delete, {"todo/title", "todo_1"}},
        {:delete, {"todo/status", "todo_1"}},
        {:put, {"todo/status", "todo_1"}}
      ]

      # The title key's last write is its delete; the status key's is its put.
      # Applying the delete to an absent key is a no-op, so the reduced batch
      # can carry it without the live index knowing the key ever existed.
      assert Enum.sort(ComponentEntityIndex.reduce_ops(ops)) == [
               {:delete, {"todo/title", "todo_1"}},
               {:put, {"todo/status", "todo_1"}}
             ]
    end

    test "reduce_batch_ops reads per-Action lists in GSN order, so the later Action wins" do
      first = [{:put, {"todo/title", "todo_1"}}]
      second = [{:delete, {"todo/title", "todo_1"}}]

      assert ComponentEntityIndex.reduce_batch_ops([first, second]) == [
               {:delete, {"todo/title", "todo_1"}}
             ]

      assert ComponentEntityIndex.reduce_batch_ops([second, first]) == [
               {:put, {"todo/title", "todo_1"}}
             ]
    end
  end

  describe "store" do
    test "component_entry_ids returns one range of ids, ascending", %{tables: tables} do
      ComponentEntityIndex.apply_ops(
        [
          {:put, {"todo/title", "todo_b"}},
          {:put, {"todo/title", "todo_a"}},
          {:put, {"todo/status", "todo_a"}},
          {:put, {"todo", "todo_a"}}
        ],
        tables
      )

      assert ComponentEntityIndex.component_entry_ids("todo/title", tables) == [
               "todo_a",
               "todo_b"
             ]

      assert ComponentEntityIndex.component_entry_ids("todo/status", tables) == ["todo_a"]
      assert ComponentEntityIndex.component_entry_ids("todo", tables) == ["todo_a"]
      assert ComponentEntityIndex.component_entry_ids("todo/missing", tables) == []
    end

    test "each_component_entry_id yields the same range in bounded chunks", %{tables: tables} do
      ids = for index <- 1..2_500, do: "todo_#{index}"

      ComponentEntityIndex.apply_ops(
        Enum.map(ids, &{:put, {"todo/title", &1}}),
        tables
      )

      seen = :ets.new(:seen_ids, [:bag, :private])

      :ok =
        ComponentEntityIndex.each_component_entry_id(
          "todo/title",
          fn id -> :ets.insert(seen, {id}) end,
          tables
        )

      assert seen
             |> :ets.tab2list()
             |> Enum.map(&elem(&1, 0))
             |> Enum.sort() == Enum.sort(ids)

      :ets.delete(seen)
    end

    test "the model entry and a component entry are different key kinds", %{tables: tables} do
      ComponentEntityIndex.apply_ops(
        [
          {:put, {"todo", "todo_1"}},
          {:put, {"todo/title", "todo_1"}}
        ],
        tables
      )

      assert ComponentEntityIndex.component_entry_ids("todo", tables) == ["todo_1"]
      assert ComponentEntityIndex.component_entry_ids("todo/title", tables) == ["todo_1"]
      assert ComponentEntityIndex.size(tables) == 2
    end

    test "a delete removes a component entry and leaves the model entry", %{tables: tables} do
      ComponentEntityIndex.apply_ops(
        [{:put, {"todo", "todo_1"}}, {:put, {"todo/title", "todo_1"}}],
        tables
      )

      ComponentEntityIndex.apply_ops([{:delete, {"todo/title", "todo_1"}}], tables)

      assert ComponentEntityIndex.component_entry_ids("todo/title", tables) == []
      assert ComponentEntityIndex.component_entry_ids("todo", tables) == ["todo_1"]
    end

    test "last write wins when the same key is applied twice", %{tables: tables} do
      ComponentEntityIndex.apply_ops([{:put, {"todo/title", "todo_1"}}], tables)
      ComponentEntityIndex.apply_ops([{:delete, {"todo/title", "todo_1"}}], tables)
      ComponentEntityIndex.apply_ops([{:put, {"todo/title", "todo_1"}}], tables)

      assert ComponentEntityIndex.component_entry_ids("todo/title", tables) == ["todo_1"]
    end

    test "reset clears entries and label interning", %{tables: tables} do
      ComponentEntityIndex.apply_ops([{:put, {"todo/title", "todo_1"}}], tables)
      assert ComponentEntityIndex.size(tables) == 1

      :ok = ComponentEntityIndex.reset(tables)

      assert ComponentEntityIndex.size(tables) == 0
      assert ComponentEntityIndex.component_entry_ids("todo/title", tables) == []
    end
  end

  defp update(component, subject_id, method) do
    [model, field] = String.split(component, "/", parts: 2)

    %{
      id: "u_#{component}_#{subject_id}",
      subject_id: subject_id,
      component: component,
      model: model,
      field: field,
      method: method,
      data: nil
    }
  end
end
