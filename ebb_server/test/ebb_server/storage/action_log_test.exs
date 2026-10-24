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

  describe "read/3" do
    test "returns the inclusive GSN range in ascending order", %{rocks_name: rocks_name} do
      for gsn <- 1..5, do: put_action(rocks_name, gsn, "act_#{gsn}")

      actions = ActionLog.read(2, 4, rocks_name: rocks_name)

      assert Enum.map(actions, & &1["gsn"]) == [2, 3, 4]
      assert Enum.map(actions, & &1["id"]) == ["act_2", "act_3", "act_4"]
    end

    test "returns a stored Action with its payload, key gsn, and scopes", %{
      rocks_name: rocks_name
    } do
      put_action(rocks_name, 1, "act_1", [["g_1"]])

      assert [action] = ActionLog.read(1, 1, rocks_name: rocks_name)

      assert action == %{
               "id" => "act_1",
               "actor_id" => "a_1",
               "hlc" => 1,
               "gsn" => 1,
               "update_scopes" => [["g_1"]],
               "updates" => []
             }
    end

    test "skips abandoned GSN holes without error", %{rocks_name: rocks_name} do
      put_action(rocks_name, 1, "act_1")
      # GSN 2 was claimed and abandoned: nothing durable lands there.
      put_action(rocks_name, 3, "act_3")

      assert [%{"gsn" => 1}, %{"gsn" => 3}] = ActionLog.read(1, 3, rocks_name: rocks_name)
    end

    test "returns [] when the whole range is an abandoned hole", %{rocks_name: rocks_name} do
      put_action(rocks_name, 5, "act_5")

      assert [] = ActionLog.read(1, 3, rocks_name: rocks_name)
    end

    test "returns [] when from_gsn is greater than to_gsn", %{rocks_name: rocks_name} do
      put_action(rocks_name, 1, "act_1")

      assert [] = ActionLog.read(5, 2, rocks_name: rocks_name)
    end

    test "raises on a value that is not a stored Action", %{rocks_name: rocks_name} do
      put_value(rocks_name, RocksDB.encode_gsn_key(1), :erlang.term_to_binary(%{"gsn" => 1}))

      assert_raise ArgumentError, ~r/not a stored Action frame/, fn ->
        ActionLog.read(1, 1, rocks_name: rocks_name)
      end
    end
  end

  defp put_action(rocks_name, gsn, id, update_scopes \\ [[]]) do
    payload =
      %{"id" => id, "actor_id" => "a_1", "hlc" => gsn, "updates" => []}
      |> ActionFormat.encode()

    put_value(rocks_name, RocksDB.encode_gsn_key(gsn), ActionFormat.frame(payload, update_scopes))
  end

  defp put_value(rocks_name, key, value) do
    assert :ok =
             RocksDB.write_batch([{:put, RocksDB.cf_actions(rocks_name), key, value}],
               name: rocks_name
             )
  end
end
