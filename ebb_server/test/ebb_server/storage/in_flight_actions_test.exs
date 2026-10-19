defmodule EbbServer.Storage.InFlightActionsTest do
  @moduledoc """
  The in-flight action-id set is the concurrency guard for idempotent
  retries (ebbjs/ebbjs#535): exactly one claimant may win an action id,
  the guard is released when the claim resolves, and every operation is
  lock-free so the Writer never queues behind its owner process.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.InFlightActions

  setup do
    unique_id = System.unique_integer([:positive])
    name = :"test_inflight_#{unique_id}"
    table = :"test_inflight_ids_#{unique_id}"

    {:ok, pid} = InFlightActions.start_link(name: name, table: table)

    on_exit(fn ->
      safe_delete_table(table)
      :persistent_term.erase({name, :table})
    end)

    %{name: name, table: table, pid: pid}
  end

  describe "claim/2" do
    test "the first claimant wins and the second loses", %{name: name} do
      assert {["act_1"], []} = InFlightActions.claim(["act_1"], name)
      assert {[], ["act_1"]} = InFlightActions.claim(["act_1"], name)
    end

    test "splits a mixed batch into winners and losers", %{name: name} do
      assert {["act_seeded"], []} = InFlightActions.claim(["act_seeded"], name)

      assert {["act_fresh"], ["act_seeded"]} =
               InFlightActions.claim(["act_fresh", "act_seeded"], name)
    end
  end

  describe "release/2" do
    test "release makes an id claimable again", %{name: name} do
      assert {["act_1"], []} = InFlightActions.claim(["act_1"], name)
      assert :ok = InFlightActions.release(["act_1"], name)
      assert {["act_1"], []} = InFlightActions.claim(["act_1"], name)
    end

    test "releasing an id that is not claimed is a no-op", %{name: name} do
      assert :ok = InFlightActions.release(["act_never_claimed"], name)
      assert InFlightActions.size(name) == 0
    end

    test "releasing twice is idempotent", %{name: name} do
      assert {["act_1"], []} = InFlightActions.claim(["act_1"], name)
      assert :ok = InFlightActions.release(["act_1"], name)
      assert :ok = InFlightActions.release(["act_1"], name)
      assert InFlightActions.size(name) == 0
    end
  end

  describe "clear/1" do
    test "empties the set", %{name: name} do
      assert {["act_1", "act_2"], []} = InFlightActions.claim(["act_1", "act_2"], name)
      assert InFlightActions.size(name) == 2

      assert :ok = InFlightActions.clear(name)
      assert InFlightActions.size(name) == 0
      assert {["act_1"], []} = InFlightActions.claim(["act_1"], name)
    end
  end

  describe "size/1" do
    test "counts the currently claimed ids", %{name: name} do
      assert InFlightActions.size(name) == 0
      assert {_, []} = InFlightActions.claim(["act_1", "act_2", "act_3"], name)
      assert InFlightActions.size(name) == 3
      assert :ok = InFlightActions.release(["act_2"], name)
      assert InFlightActions.size(name) == 2
    end
  end

  describe "concurrency" do
    test "concurrent claimants produce exactly one winner per id", %{name: name} do
      ids = for i <- 1..20, do: "act_#{i}"
      claimers = 12
      test_pid = self()

      pids =
        for _ <- 1..claimers do
          spawn_link(fn ->
            receive do
              :go -> send(test_pid, {:claimed, InFlightActions.claim(ids, name)})
            end
          end)
        end

      Enum.each(pids, &send(&1, :go))

      claimed =
        for _ <- 1..claimers, into: [] do
          assert_receive {:claimed, {claimed_ids, _lost}}, 2_000
          claimed_ids
        end

      assert Enum.sort(List.flatten(claimed)) == Enum.sort(ids)
      assert InFlightActions.size(name) == length(ids)
    end
  end

  describe "lock-free API" do
    test "claim, release, clear, and size do not touch the owner process", %{
      name: name,
      pid: pid
    } do
      :ok = :sys.suspend(pid)

      assert {["act_1"], []} = InFlightActions.claim(["act_1"], name)
      assert InFlightActions.size(name) == 1
      assert {[], ["act_1"]} = InFlightActions.claim(["act_1"], name)
      assert :ok = InFlightActions.release(["act_1"], name)
      assert InFlightActions.size(name) == 0
      assert :ok = InFlightActions.clear(name)
      assert {["act_2"], []} = InFlightActions.claim(["act_2"], name)

      :ok = :sys.resume(pid)
      assert InFlightActions.size(name) == 1
    end
  end

  defp safe_delete_table(table) do
    :ets.delete(table)
  rescue
    _ -> :ok
  end
end
