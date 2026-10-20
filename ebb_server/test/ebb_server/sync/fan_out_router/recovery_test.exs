defmodule EbbServer.Sync.FanOutRouter.RecoveryTest do
  @moduledoc """
  Tests for `EbbServer.Sync.FanOutRouter.Recovery`, the durable-log scan a
  Router restart uses to re-derive its pending ranges and group sets.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  alias EbbServer.Storage.RocksDB
  alias EbbServer.Sync.FanOutRouter.Recovery

  describe "recover_committed/2" do
    test "folds present GSNs into contiguous ranges and groups them by GSN" do
      put_action!(2, "act_2")
      put_action!(3, "act_3")
      put_action!(5, "act_5")

      put_group_action!("g_a", 2, "act_2")
      put_group_action!("g_b", 2, "act_2")
      put_group_action!("g_a", 3, "act_3")
      put_group_action!("g_a", 5, "act_5")
      # Outside [1, 5]: must not leak into the recovery window.
      put_group_action!("g_c", 10, "act_10")

      assert {ranges, groups_by_gsn} = Recovery.recover_committed(1, 5)
      assert ranges == [{2, 3}, {5, 5}]

      assert groups_by_gsn == %{
               2 => ["g_a", "g_b"],
               3 => ["g_a"],
               5 => ["g_a"]
             }
    end

    test "returns no ranges and no groups when the window has no committed actions" do
      assert Recovery.recover_committed(1, 3) == {[], %{}}
    end

    test "a bounded window ignores actions above its end" do
      put_action!(1, "act_1")
      put_action!(2, "act_2")
      put_action!(9, "act_9")

      assert {ranges, _groups} = Recovery.recover_committed(1, 2)
      assert ranges == [{1, 2}]
    end
  end

  defp put_action!(gsn, action_id) do
    action = %{
      "id" => action_id,
      "gsn" => gsn,
      "actor_id" => "actor",
      "hlc" => 0,
      "updates" => []
    }

    :ok =
      RocksDB.write_batch([
        {:put, RocksDB.cf_actions(), RocksDB.encode_gsn_key(gsn), :erlang.term_to_binary(action)}
      ])
  end

  defp put_group_action!(group_id, gsn, action_id) do
    key = RocksDB.encode_group_action_key(group_id, gsn)
    :ok = RocksDB.write_batch([{:put, RocksDB.cf_group_actions(), key, action_id}])
  end
end
