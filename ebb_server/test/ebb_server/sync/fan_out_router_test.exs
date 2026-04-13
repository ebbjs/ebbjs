defmodule EbbServer.Sync.FanOutRouterTest do
  @moduledoc """
  Unit tests for FanOutRouter core algorithms.

  Tests split_pushable/3 and process_batch/4 which are pure functions
  containing the watermark gating logic. No infrastructure needed.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Sync.FanOutRouter

  describe "split_pushable/3" do
    test "empty pending returns two empty lists" do
      assert FanOutRouter.split_pushable([], 0, 10) == {[], []}
    end

    test "single range pushable when from <= last_pushed + 1 and to <= watermark" do
      pending = [{1, 5}]
      assert FanOutRouter.split_pushable(pending, 0, 10) == {[{1, 5}], []}
    end

    test "single range not pushable when from > last_pushed + 1" do
      pending = [{5, 10}]
      assert FanOutRouter.split_pushable(pending, 0, 20) == {[], [{5, 10}]}
    end

    test "single range not pushable when to > watermark" do
      pending = [{1, 15}]
      assert FanOutRouter.split_pushable(pending, 0, 10) == {[], [{1, 15}]}
    end

    test "only first range is pushable - second fails from check" do
      pending = [{1, 3}, {4, 6}]
      assert FanOutRouter.split_pushable(pending, 0, 10) == {[{1, 3}, {4, 6}], []}
    end

    test "third range also fails from check" do
      pending = [{1, 3}, {4, 6}, {7, 9}]
      assert FanOutRouter.split_pushable(pending, 0, 10) == {[{1, 3}, {4, 6}, {7, 9}], []}
    end

    test "from equal to last_pushed + 1 is pushable" do
      pending = [{4, 6}]
      assert FanOutRouter.split_pushable(pending, 3, 20) == {[{4, 6}], []}
    end

    test "watermark boundary - to equal to watermark is pushable" do
      pending = [{1, 10}]
      assert FanOutRouter.split_pushable(pending, 0, 10) == {[{1, 10}], []}
    end

    test "watermark boundary - to greater than watermark not pushable" do
      pending = [{1, 11}]
      assert FanOutRouter.split_pushable(pending, 0, 10) == {[], [{1, 11}]}
    end

    test "multiple ranges where first is pushable but second is not" do
      pending = [{1, 5}, {10, 15}]
      assert FanOutRouter.split_pushable(pending, 0, 20) == {[{1, 5}], [{10, 15}]}
    end

    test "from exactly at last_pushed boundary" do
      pending = [{2, 4}]
      assert FanOutRouter.split_pushable(pending, 1, 10) == {[{2, 4}], []}
    end

    test "to exactly at watermark boundary" do
      pending = [{1, 10}]
      assert FanOutRouter.split_pushable(pending, 0, 10) == {[{1, 10}], []}
    end
  end

  describe "split_pushable/3 — contiguous range tracking" do
    test "all contiguous ranges are pushable even when beyond original last_pushed" do
      pending = [{1, 3}, {4, 6}, {7, 9}]
      assert FanOutRouter.split_pushable(pending, 0, 10) == {[{1, 3}, {4, 6}, {7, 9}], []}
    end

    test "after first range is pushed, second becomes pushable with updated boundary" do
      pending = [{1, 3}, {4, 6}]
      assert FanOutRouter.split_pushable(pending, 3, 10) == {[{1, 3}, {4, 6}], []}
    end

    test "two-writer scenario: both batches pushed when watermark covers both" do
      pending = [{1001, 2000}, {1, 1000}]
      sorted_pending = Enum.sort_by(pending, &elem(&1, 0))

      assert FanOutRouter.split_pushable(sorted_pending, 0, 2000) ==
               {[{1, 1000}, {1001, 2000}], []}
    end

    test "three+ contiguous ranges all within watermark are all pushed" do
      pending = [{1, 2}, {3, 4}, {5, 6}]
      assert FanOutRouter.split_pushable(pending, 0, 6) == {[{1, 2}, {3, 4}, {5, 6}], []}
    end

    test "gap detected after first pushes — subsequent non-contiguous stays" do
      pending = [{1, 3}, {7, 9}]
      assert FanOutRouter.split_pushable(pending, 3, 10) == {[{1, 3}], [{7, 9}]}
    end
  end

  describe "process_batch/4 — watermark-gated delivery" do
    test "first batch arrives out of order, waits for watermark" do
      state = new_state(pending_notifications: [], last_pushed_gsn: 0)
      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 1001, 2000, 0)
      assert to_push == []
      assert remaining == [{1001, 2000}]
      assert new_last == 0
    end

    test "second batch arrives and watermark advances — both ranges push in order" do
      state = new_state(pending_notifications: [{1001, 2000}], last_pushed_gsn: 0)
      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 1, 1000, 2000)
      assert to_push == [{1, 1000}, {1001, 2000}]
      assert remaining == []
      assert new_last == 2000
    end
  end

  describe "process_batch/4" do
    test "adds notification to pending when not pushable" do
      state = new_state(pending_notifications: [], last_pushed_gsn: 0)

      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 10, 20, 5)

      assert to_push == []
      assert remaining == [{10, 20}]
      assert new_last == 0
    end

    test "pushes single range when contiguous and within watermark" do
      state = new_state(pending_notifications: [], last_pushed_gsn: 0)

      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 1, 5, 10)

      assert to_push == [{1, 5}]
      assert remaining == []
      assert new_last == 5
    end

    test "second range not pushable due to gap in from sequence" do
      state = new_state(pending_notifications: [{1, 3}], last_pushed_gsn: 0)

      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 5, 10, 10)

      assert to_push == [{1, 3}]
      assert remaining == [{5, 10}]
      assert new_last == 3
    end

    test "range blocked by watermark not pushable" do
      state = new_state(pending_notifications: [], last_pushed_gsn: 0)

      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 5, 20, 10)

      assert to_push == []
      assert remaining == [{5, 20}]
      assert new_last == 0
    end

    test "new notification added to sorted pending" do
      state = new_state(pending_notifications: [], last_pushed_gsn: 0)

      {_to_push, remaining, _} = FanOutRouter.process_batch(state, 5, 10, 20)

      assert remaining == [{5, 10}]
    end

    test "continuation from previous last_pushed_gsn - second range becomes pushable" do
      state = new_state(pending_notifications: [{1, 3}], last_pushed_gsn: 3)

      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 4, 5, 10)

      assert to_push == [{1, 3}, {4, 5}]
      assert remaining == []
      assert new_last == 5
    end

    test "gap in sequence stops at first non-contiguous" do
      state = new_state(pending_notifications: [{1, 3}], last_pushed_gsn: 0)

      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 6, 10, 10)

      assert to_push == [{1, 3}]
      assert remaining == [{6, 10}]
      assert new_last == 3
    end

    test "last_pushed_gsn unchanged when nothing pushed" do
      state = new_state(pending_notifications: [{10, 15}], last_pushed_gsn: 5)

      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 20, 25, 30)

      assert to_push == []
      assert remaining == [{10, 15}, {20, 25}]
      assert new_last == 5
    end

    test "existing pending plus new notification sorted" do
      state = new_state(pending_notifications: [{1, 3}], last_pushed_gsn: 5)

      {_to_push, remaining, _} = FanOutRouter.process_batch(state, 7, 10, 20)

      assert remaining == [{7, 10}]
    end

    test "new last_pushed_gsn is last item in to_push" do
      state = new_state(pending_notifications: [], last_pushed_gsn: 0)

      {_to_push, _remaining, new_last} = FanOutRouter.process_batch(state, 1, 8, 20)

      assert new_last == 8
    end

    test "pending range with gap from last_pushed stays in pending" do
      state = new_state(pending_notifications: [{10, 15}], last_pushed_gsn: 5)

      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 20, 25, 30)

      assert to_push == []
      assert remaining == [{10, 15}, {20, 25}]
      assert new_last == 5
    end
  end

  defp new_state(attrs) do
    struct(EbbServer.Sync.FanOutRouter, attrs)
  end
end
