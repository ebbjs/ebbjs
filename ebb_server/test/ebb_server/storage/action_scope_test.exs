defmodule EbbServer.Storage.ActionScopeTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.ActionScope

  defp action(subject_scopes) do
    %{
      "updates" => [
        %{"id" => "u_1", "subject_id" => "todo_1"},
        %{"id" => "u_2", "subject_id" => "todo_2"},
        %{"id" => "u_3", "subject_id" => "todo_3"}
      ],
      "subject_scopes" => subject_scopes
    }
  end

  defp ids(action, group_id) do
    action |> ActionScope.updates_for_group(group_id) |> Enum.map(& &1["id"])
  end

  test "returns the Updates whose own subject's scope includes the group" do
    action = action([{"todo_1", ["g_1"]}, {"todo_2", ["g_1", "g_2"]}, {"todo_3", ["g_2"]}])

    assert ids(action, "g_1") == ["u_1", "u_2"]
    assert ids(action, "g_2") == ["u_2", "u_3"]
    assert ids(action, "g_3") == []
  end

  test "one subject's scope covers every Update of it, however many components" do
    updates = for n <- 1..5, do: %{"id" => "u_#{n}", "subject_id" => "todo_1"}

    action = %{
      "updates" => updates ++ [%{"id" => "u_other", "subject_id" => "todo_2"}],
      "subject_scopes" => [{"todo_1", ["g_1"]}, {"todo_2", ["g_2"]}]
    }

    assert ids(action, "g_1") == ["u_1", "u_2", "u_3", "u_4", "u_5"]
    assert ids(action, "g_2") == ["u_other"]
  end

  test "a delete is delivered through its own subject's scope" do
    action = %{
      "updates" => [%{"id" => "u_delete", "subject_id" => "todo_1", "method" => "delete"}],
      "subject_scopes" => [{"todo_1", ["g_1"]}]
    }

    assert ids(action, "g_1") == ["u_delete"]
    assert ids(action, "g_2") == []
  end

  test "a subject listed with no groups is delivered to nobody" do
    action = action([{"todo_1", []}, {"todo_2", ["g_1"]}, {"todo_3", ["g_1"]}])

    assert ids(action, "g_1") == ["u_2", "u_3"]
  end

  test "an Update whose subject is absent from the list is returned" do
    # The shape is well formed, so this is not the decode gate's business:
    # nothing here may silently drop an Update the Action committed, even
    # though its subject has no entry.
    action = action([{"todo_1", ["g_1"]}, {"todo_2", ["g_2"]}])

    assert ids(action, "g_1") == ["u_1", "u_3"]
  end
end
