defmodule EbbServer.Storage.ActionScopeTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.ActionScope

  defp action(update_scopes) do
    %{
      "updates" => [
        %{"id" => "u_1", "subject_id" => "todo_1"},
        %{"id" => "u_2", "subject_id" => "todo_2"},
        %{"id" => "u_3", "subject_id" => "todo_3"}
      ],
      "update_scopes" => update_scopes
    }
  end

  defp ids(action, group_id) do
    action |> ActionScope.updates_for_group(group_id) |> Enum.map(& &1["id"])
  end

  test "returns the Updates whose own scope includes the group" do
    action = action([["g_1"], ["g_1", "g_2"], ["g_2"]])

    assert ids(action, "g_1") == ["u_1", "u_2"]
    assert ids(action, "g_2") == ["u_2", "u_3"]
    assert ids(action, "g_3") == []
  end

  test "returns every Update when the Action has no persisted scopes" do
    action = Map.delete(action([["g_1"], ["g_1"], ["g_1"]]), "update_scopes")

    assert ids(action, "g_9") == ["u_1", "u_2", "u_3"]
  end

  test "returns every Update when the scope list does not align with the Updates" do
    action = action([["g_1"]])

    assert ids(action, "g_9") == ["u_1", "u_2", "u_3"]
  end
end
