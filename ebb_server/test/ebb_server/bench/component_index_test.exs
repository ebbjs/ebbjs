defmodule EbbServer.Bench.ComponentIndexTest do
  @moduledoc """
  Pins the workload the component-index measurement writes.

  The benchmark's Actions are built in the validated shape directly (no
  `ActionValidator` pass), so a string method or a component missing its
  split would only fail once the real `Writer` saw it. These are the two
  properties the `Writer` depends on.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Bench.ComponentIndex

  test "build_action emits one validated update per component with atom methods" do
    action = ComponentIndex.build_action(3, 7)

    assert action.id == "a_ci_7"
    assert action.actor_id == "a_bench"
    assert action.hlc > 0

    assert action.updates |> Enum.map(& &1.method) |> Enum.uniq() == [:replace]

    todo = Enum.filter(action.updates, &String.starts_with?(&1.component, "todo/"))
    membership = Enum.filter(action.updates, &String.starts_with?(&1.component, "entityGroup/"))

    assert length(todo) == 3
    assert length(membership) == 2

    for update <- todo ++ membership do
      assert update.model <> "/" <> update.field == update.component
    end
  end

  test "build_actions offsets the sequence so a warm-up and measured pool do not collide" do
    warmup = ComponentIndex.build_actions(2, 2)
    measured = ComponentIndex.build_actions(2, 2, 2)

    assert Enum.map(warmup, & &1.id) == ["a_ci_1", "a_ci_2"]
    assert Enum.map(measured, & &1.id) == ["a_ci_3", "a_ci_4"]
  end

  test "index_shape reports k component entries and their key bytes" do
    assert %{ops: 4, bytes: bytes} = ComponentIndex.index_shape(4)
    assert bytes > 4 * byte_size("todo/f1")
  end
end
