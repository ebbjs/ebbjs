defmodule EbbServer.Sync.FanOutRouter.PlanTest do
  @moduledoc """
  Pure ordering tests for `EbbServer.Sync.FanOutRouter.Plan`.

  The plan owns watermark gating, claim-order release, and the persisted
  frontier value. These tests need no Router, GroupServer, or storage.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Sync.FanOutRouter.Plan

  describe "split_pushable/2" do
    test "an empty plan releases nothing" do
      assert Plan.split_pushable(Plan.new(), 10) == {[], Plan.new()}
    end

    test "a single range is releasable when its end is at the watermark" do
      plan = Plan.new(pending_notifications: [{1, 5}])

      assert {[{1, 5}], released} = Plan.split_pushable(plan, 10)
      assert released.pending_notifications == []
      assert released.last_pushed_gsn == 5
    end

    test "a range above the watermark stays pending" do
      plan = Plan.new(pending_notifications: [{1, 15}])

      assert {[], pending} = Plan.split_pushable(plan, 10)
      assert pending.pending_notifications == [{1, 15}]
      assert pending.last_pushed_gsn == 0
    end

    test "contiguous ranges within the watermark release in claim order" do
      plan = Plan.new(pending_notifications: [{1, 3}, {4, 6}, {7, 9}])

      assert {[{1, 3}, {4, 6}, {7, 9}], released} = Plan.split_pushable(plan, 10)
      assert released.last_pushed_gsn == 9
    end

    test "only the releasable prefix is released" do
      plan = Plan.new(pending_notifications: [{1, 5}, {6, 50}])

      assert {[{1, 5}], pending} = Plan.split_pushable(plan, 20)
      assert pending.pending_notifications == [{6, 50}]
      assert pending.last_pushed_gsn == 5
    end

    test "an earlier blocked range stops a later range that is under the watermark" do
      plan = Plan.new(pending_notifications: [{1, 30}, {21, 25}])

      assert {[], pending} = Plan.split_pushable(plan, 25)
      assert pending.pending_notifications == [{1, 30}, {21, 25}]
      assert pending.last_pushed_gsn == 0
    end

    test "a duplicate sub-frontier range does not rewind the frontier" do
      plan = Plan.new(pending_notifications: [{1, 1}], last_pushed_gsn: 2)

      assert {[{1, 1}], released} = Plan.split_pushable(plan, 10)
      assert released.last_pushed_gsn == 2
    end
  end

  describe "claim and release order" do
    test "a later claim cannot overtake an earlier one that is not acked yet" do
      plan = Plan.new() |> Plan.claim({1, 100}) |> Plan.claim({101, 200})

      assert {[], waiting} = Plan.release(plan, {101, 200}, 200)
      assert waiting.last_pushed_gsn == 0
      assert waiting.pending_notifications == [{1, 100}, {101, 200}]

      assert {[{1, 100}, {101, 200}], released} = Plan.release(waiting, {1, 100}, 200)
      assert released.pending_notifications == []
      assert released.last_pushed_gsn == 200
    end

    test "a later claim is released only after every earlier claim is acknowledged" do
      plan =
        Plan.new()
        |> Plan.claim({1, 10})
        |> Plan.claim({11, 20})
        |> Plan.claim({21, 30})

      {[], plan} = Plan.release(plan, {21, 30}, 30)
      {[], plan} = Plan.release(plan, {11, 20}, 30)
      assert plan.last_pushed_gsn == 0

      assert {[{1, 10}, {11, 20}, {21, 30}], plan} = Plan.release(plan, {1, 10}, 30)
      assert plan.last_pushed_gsn == 30
    end

    test "a resolved hole no longer blocks a later acknowledged range" do
      plan = Plan.new() |> Plan.claim({1, 10}) |> Plan.claim({11, 20})
      plan = Plan.resolve(plan, {1, 10})

      assert {[{11, 20}], released} = Plan.release(plan, {11, 20}, 20)
      assert released.pending_notifications == []
      assert released.last_pushed_gsn == 20
    end

    test "claiming a range twice keeps one release slot" do
      plan = Plan.new() |> Plan.claim({1, 5}) |> Plan.claim({1, 5})

      assert plan.pending_notifications == [{1, 5}]
    end
  end

  describe "process_batch/4" do
    test "a batch arrives above the watermark and waits" do
      plan = Plan.new()

      assert {[], waiting} = Plan.process_batch(plan, 1001, 2000, 0)
      assert waiting.pending_notifications == [{1001, 2000}]
      assert waiting.last_pushed_gsn == 0
    end

    test "a later batch and the watermark release both in claim order" do
      plan = Plan.new()
      {[], waiting} = Plan.process_batch(plan, 1001, 2000, 0)

      assert {[{1, 1000}, {1001, 2000}], released} =
               Plan.process_batch(waiting, 1, 1000, 2000)

      assert released.last_pushed_gsn == 2000
    end

    test "a batch in the watermark is released immediately" do
      assert {[{5, 10}], released} = Plan.process_batch(Plan.new(), 5, 10, 20)
      assert released.pending_notifications == []
      assert released.last_pushed_gsn == 10
    end

    test "a batch blocked by the watermark does not advance the frontier" do
      assert {[], waiting} = Plan.process_batch(Plan.new(), 5, 20, 10)
      assert waiting.pending_notifications == [{5, 20}]
      assert waiting.last_pushed_gsn == 0
    end

    test "a stale replay below the frontier pushes but does not rewind it" do
      plan = Plan.new(last_pushed_gsn: 2)

      assert {[{1, 1}], released} = Plan.process_batch(plan, 1, 1, 10)
      assert released.last_pushed_gsn == 2
    end
  end

  describe "frontier invariant over random ack orders" do
    test "last_pushed_gsn never passes an unpushed claim" do
      for iteration <- 1..300 do
        :rand.seed(:exsss, {431, iteration * 17, 9001 + iteration})
        count = :rand.uniform(6)
        ranges = random_ranges(count)

        plan = Enum.reduce(ranges, Plan.new(), &Plan.claim(&2, &1))

        {released, plan} =
          ranges
          |> Enum.shuffle()
          |> Enum.reduce({[], plan}, fn range, {released, plan} ->
            watermark = Enum.random([0, elem(range, 1), elem(List.last(ranges), 1)])
            {now, plan} = Plan.release(plan, range, watermark)
            {released ++ now, plan}
          end)

        assert released == Enum.take(ranges, length(released))
        assert_release_order(released)
        assert plan.last_pushed_gsn == last_released_to(released)

        assert Enum.all?(plan.pending_notifications, fn {from_gsn, _to} ->
                 plan.last_pushed_gsn < from_gsn
               end)
      end
    end

    test "abandoned claims are skipped without letting a later range pass an open one" do
      for iteration <- 1..200 do
        :rand.seed(:exsss, {4310, iteration * 23, 7 + iteration})
        count = :rand.uniform(6)
        ranges = random_ranges(count)
        statuses = Map.new(ranges, fn range -> {range, Enum.random([:ack, :abandon])} end)

        plan =
          ranges
          |> Enum.reduce(Plan.new(), &Plan.claim(&2, &1))

        {released, plan} =
          ranges
          |> Enum.shuffle()
          |> Enum.reduce({[], plan}, fn range, {released, plan} ->
            case Map.fetch!(statuses, range) do
              :ack ->
                {now, plan} = Plan.release(plan, range, elem(List.last(ranges), 1))
                {released ++ now, plan}

              :abandon ->
                {released, Plan.resolve(plan, range)}
            end
          end)

        {final, plan} = Plan.split_pushable(plan, elem(List.last(ranges), 1))
        released = released ++ final

        expected = Enum.reject(ranges, &(Map.fetch!(statuses, &1) == :abandon))

        assert released == expected
        assert_release_order(released)
        assert plan.pending_notifications == []
        assert plan.last_pushed_gsn == last_released_to(released)
      end
    end
  end

  defp random_ranges(count) do
    {ranges, _next} =
      Enum.map_reduce(1..count, 1, fn _index, next_gsn ->
        width = :rand.uniform(3)
        gap = :rand.uniform(3) - 1
        range = {next_gsn, next_gsn + width - 1}
        {range, next_gsn + width + gap}
      end)

    ranges
  end

  defp assert_release_order(released) do
    starts = Enum.map(released, &elem(&1, 0))
    assert starts == Enum.sort(starts)
  end

  defp last_released_to([]), do: 0
  defp last_released_to(released), do: released |> List.last() |> elem(1)
end
