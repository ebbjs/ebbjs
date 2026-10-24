defmodule EbbServer.Storage.ActionLogTest do
  @moduledoc """
  Behavioral tests for the committed-log reader.

  `ActionLog` is the shared read primitive over `cf_actions`: peer
  replication (#113) and Action export both consume it. The log is a
  resolution frontier, not a gap-free sequence — abandoned GSNs leave
  permanent holes that must read as absent, never as an error.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Storage.{ActionFormat, ActionLog, RocksDB}

  import EbbServer.TestHelpers

  setup do
    %{name: rocks_name} = start_rocks()
    %{rocks_name: rocks_name}
  end

  defp put_action(rocks_name, gsn, action) do
    key = RocksDB.encode_gsn_key(gsn)
    value = :erlang.term_to_binary(action)

    put_value(rocks_name, key, value)
  end

  defp put_value(rocks_name, key, value) do
    assert :ok =
             RocksDB.write_batch([{:put, RocksDB.cf_actions(rocks_name), key, value}],
               name: rocks_name
             )
  end

  defp new_frame(gsn, update_scopes) do
    payload =
      %{
        id: "act_new",
        actor_id: "a_1",
        hlc: 200,
        updates: [
          %{
            id: "upd_new",
            subject_id: "todo_new",
            subject_type: "todo",
            method: :put,
            data: %{"fields" => %{}}
          }
        ]
      }
      |> ActionFormat.build()
      |> ActionFormat.encode()

    {gsn, ActionFormat.frame(payload, update_scopes)}
  end

  describe "read/3" do
    test "returns the inclusive GSN range in ascending order", %{rocks_name: rocks_name} do
      for gsn <- 1..5 do
        put_action(rocks_name, gsn, %{"gsn" => gsn, "id" => "act_#{gsn}"})
      end

      actions = ActionLog.read(2, 4, rocks_name: rocks_name)

      assert Enum.map(actions, & &1["gsn"]) == [2, 3, 4]
    end

    test "returns a stored Action with string keys intact", %{rocks_name: rocks_name} do
      action = %{
        "id" => "act_1",
        "actor_id" => "a_1",
        "hlc" => 123,
        "gsn" => 1,
        "updates" => [
          %{
            "id" => "upd_1",
            "subject_id" => "todo_1",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{"fields" => %{}}
          }
        ]
      }

      put_action(rocks_name, 1, action)

      assert [^action] = ActionLog.read(1, 1, rocks_name: rocks_name)
    end

    test "skips abandoned GSN holes without error", %{rocks_name: rocks_name} do
      put_action(rocks_name, 1, %{"gsn" => 1})
      # GSN 2 was claimed and abandoned: nothing durable lands there.
      put_action(rocks_name, 3, %{"gsn" => 3})

      assert [%{"gsn" => 1}, %{"gsn" => 3}] = ActionLog.read(1, 3, rocks_name: rocks_name)
    end

    test "returns [] when the whole range is an abandoned hole", %{rocks_name: rocks_name} do
      put_action(rocks_name, 5, %{"gsn" => 5})

      assert [] = ActionLog.read(1, 3, rocks_name: rocks_name)
    end

    test "returns [] when from_gsn is greater than to_gsn", %{rocks_name: rocks_name} do
      put_action(rocks_name, 1, %{"gsn" => 1})

      assert [] = ActionLog.read(5, 2, rocks_name: rocks_name)
    end

    test "reads a database holding both a legacy map and a v1 frame", %{
      rocks_name: rocks_name
    } do
      legacy = %{
        "id" => "act_legacy",
        "actor_id" => "a_1",
        "hlc" => 100,
        "gsn" => 1,
        "update_scopes" => [["g_legacy"]],
        "updates" => [%{"id" => "upd_legacy", "subject_id" => "todo_legacy"}]
      }

      put_action(rocks_name, 1, legacy)
      {new_gsn, frame} = new_frame(2, [["g_new"]])
      put_value(rocks_name, RocksDB.encode_gsn_key(new_gsn), frame)

      assert [old, new] = ActionLog.read(1, 2, rocks_name: rocks_name)

      assert old["gsn"] == 1
      assert old["update_scopes"] == [["g_legacy"]]
      assert old["id"] == "act_legacy"

      assert new["gsn"] == 2
      assert new["update_scopes"] == [["g_new"]]
      assert new["id"] == "act_new"
      assert [%{"id" => "upd_new", "method" => "put"}] = new["updates"]
    end

    test "a legacy map without a gsn takes the key's gsn", %{rocks_name: rocks_name} do
      put_action(rocks_name, 9, %{"id" => "act_legacy", "updates" => []})

      assert [%{"gsn" => 9}] = ActionLog.read(9, 9, rocks_name: rocks_name)
    end
  end
end
