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

  test "an Update whose subject is absent from a present list is returned" do
    # Fail open: the list is present, so this is not the corrupt-record
    # fallback, but nothing may silently drop an Update with no entry.
    action = action([{"todo_1", ["g_1"]}, {"todo_2", ["g_2"]}])

    assert ids(action, "g_1") == ["u_1", "u_3"]
  end

  test "returns every Update when the list is missing" do
    action = action(nil) |> Map.delete("subject_scopes")

    assert ids(action, "g_9") == ["u_1", "u_2", "u_3"]
  end

  test "returns every Update when the list is not a subject scope list" do
    # The pre-#814 per-Update shape never reaches a reader, but a corrupt
    # record must not decode as "scope to nobody".
    action = action([["g_1"]])

    assert ids(action, "g_9") == ["u_1", "u_2", "u_3"]
  end
end
