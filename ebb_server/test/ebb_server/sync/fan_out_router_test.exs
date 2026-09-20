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

    test "single range pushable when to <= watermark" do
      pending = [{1, 5}]
      assert FanOutRouter.split_pushable(pending, 0, 10) == {[{1, 5}], []}
    end

    # `last_pushed_gsn` no longer affects pushability (only the watermark
    # does). A range whose end is committed is pushable regardless of
    # whether its start is contiguous with the last pushed GSN — SSE
    # tolerates out-of-order events and clients use catchUp for ordered
    # backfill of past actions. The contiguity check was removed because
    # it blocked the very first action after a fresh start (last_pushed=0
    # but actions have GSN > 1) and actions arriving after an SSE
    # subscribe with cursor=0.
    test "single range with from > last_pushed + 1 is pushable when watermark covers" do
      pending = [{5, 10}]
      assert FanOutRouter.split_pushable(pending, 0, 20) == {[{5, 10}], []}
    end

    test "single range not pushable when to > watermark" do
      pending = [{1, 15}]
      assert FanOutRouter.split_pushable(pending, 0, 10) == {[], [{1, 15}]}
    end

    test "contiguous ranges both pushable when within watermark" do
      pending = [{1, 3}, {4, 6}]
      assert FanOutRouter.split_pushable(pending, 0, 10) == {[{1, 3}, {4, 6}], []}
    end

    test "three contiguous ranges all pushable when within watermark" do
      pending = [{1, 3}, {4, 6}, {7, 9}]
      assert FanOutRouter.split_pushable(pending, 0, 10) == {[{1, 3}, {4, 6}, {7, 9}], []}
    end

    test "watermark boundary - to equal to watermark is pushable" do
      pending = [{1, 10}]
      assert FanOutRouter.split_pushable(pending, 0, 10) == {[{1, 10}], []}
    end

    test "watermark boundary - to greater than watermark not pushable" do
      pending = [{1, 11}]
      assert FanOutRouter.split_pushable(pending, 0, 10) == {[], [{1, 11}]}
    end

    # Old behavior: only the first range was pushed because the contiguity
    # check (from > last_pushed + 1) blocked the second. New behavior: both
    # are pushable because both fit in the watermark.
    test "multiple ranges are all pushable when both fit in watermark" do
      pending = [{1, 5}, {10, 15}]
      assert FanOutRouter.split_pushable(pending, 0, 20) == {[{1, 5}, {10, 15}], []}
    end

    test "second range stays in remaining when only first fits in watermark" do
      pending = [{1, 5}, {10, 50}]
      assert FanOutRouter.split_pushable(pending, 0, 20) == {[{1, 5}], [{10, 50}]}
    end

    test "from exactly at last_pushed boundary is still pushable when watermark covers" do
      pending = [{2, 4}]
      assert FanOutRouter.split_pushable(pending, 1, 10) == {[{2, 4}], []}
    end

    test "to exactly at watermark boundary" do
      pending = [{1, 10}]
      assert FanOutRouter.split_pushable(pending, 0, 10) == {[{1, 10}], []}
    end
  end

  describe "split_pushable/3 — out-of-order batches" do
    # All contiguous ranges are pushable when the watermark covers them,
    # regardless of their relationship to last_pushed_gsn.
    test "all contiguous ranges are pushable when watermark covers all" do
      pending = [{1, 3}, {4, 6}, {7, 9}]
      assert FanOutRouter.split_pushable(pending, 0, 10) == {[{1, 3}, {4, 6}, {7, 9}], []}
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

    # Old behavior: gap detection kept the second range in remaining even
    # though it was within the watermark. New behavior: only the watermark
    # matters, so the second range is pushable regardless of contiguity.
    test "non-contiguous ranges are both pushable when both fit in watermark" do
      pending = [{1, 3}, {7, 9}]
      assert FanOutRouter.split_pushable(pending, 3, 10) == {[{1, 3}, {7, 9}], []}
    end

    test "non-contiguous range stays in remaining when watermark blocks it" do
      pending = [{1, 3}, {7, 20}]
      assert FanOutRouter.split_pushable(pending, 3, 10) == {[{1, 3}], [{7, 20}]}
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
    test "adds notification to pending when not pushable (to > watermark)" do
      state = new_state(pending_notifications: [], last_pushed_gsn: 0)

      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 10, 20, 5)

      assert to_push == []
      assert remaining == [{10, 20}]
      assert new_last == 0
    end

    test "pushes single range when within watermark" do
      state = new_state(pending_notifications: [], last_pushed_gsn: 0)

      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 1, 5, 10)

      assert to_push == [{1, 5}]
      assert remaining == []
      assert new_last == 5
    end

    # Old behavior: gap from last_pushed kept the second range pending.
    # New behavior: both ranges are within the watermark, so both push.
    test "non-contiguous second range is pushable when within watermark" do
      state = new_state(pending_notifications: [{1, 3}], last_pushed_gsn: 0)

      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 5, 10, 10)

      assert to_push == [{1, 3}, {5, 10}]
      assert remaining == []
      assert new_last == 10
    end

    test "range blocked by watermark not pushable" do
      state = new_state(pending_notifications: [], last_pushed_gsn: 0)

      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 5, 20, 10)

      assert to_push == []
      assert remaining == [{5, 20}]
      assert new_last == 0
    end

    # Old behavior: the new range was added to pending because it wasn't
    # contiguous with last_pushed=0. New behavior: it pushes because the
    # watermark covers it.
    test "new notification within watermark is pushed, not added to pending" do
      state = new_state(pending_notifications: [], last_pushed_gsn: 0)

      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 5, 10, 20)

      assert to_push == [{5, 10}]
      assert remaining == []
      assert new_last == 10
    end

    test "continuation from previous last_pushed_gsn - both ranges push" do
      state = new_state(pending_notifications: [{1, 3}], last_pushed_gsn: 3)

      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 4, 5, 10)

      assert to_push == [{1, 3}, {4, 5}]
      assert remaining == []
      assert new_last == 5
    end

    # Old behavior: the second range stayed pending because of the gap.
    # New behavior: it pushes because the watermark covers it.
    test "non-contiguous second range is pushable when watermark covers it" do
      state = new_state(pending_notifications: [{1, 3}], last_pushed_gsn: 0)

      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 6, 10, 10)

      assert to_push == [{1, 3}, {6, 10}]
      assert remaining == []
      assert new_last == 10
    end

    # Old behavior: nothing was pushed because of the contiguity gap.
    # New behavior: both ranges push because the watermark covers them,
    # and last_pushed_gsn advances to the to of the highest pushed range.
    test "all in-watermark ranges push regardless of contiguity" do
      state = new_state(pending_notifications: [{10, 15}], last_pushed_gsn: 5)

      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 20, 25, 30)

      assert to_push == [{10, 15}, {20, 25}]
      assert remaining == []
      assert new_last == 25
    end

    # Same idea: existing pending + new in-watermark notification both push.
    test "existing pending plus new notification both push when watermark covers" do
      state = new_state(pending_notifications: [{1, 3}], last_pushed_gsn: 5)

      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 7, 10, 20)

      assert to_push == [{1, 3}, {7, 10}]
      assert remaining == []
      assert new_last == 10
    end

    test "new last_pushed_gsn is last item in to_push" do
      state = new_state(pending_notifications: [], last_pushed_gsn: 0)

      {_to_push, _remaining, new_last} = FanOutRouter.process_batch(state, 1, 8, 20)

      assert new_last == 8
    end

    # If only some pending ranges fit in the watermark, the unwatermarked
    # ones stay pending. last_pushed_gsn advances to the to of the last
    # PUSHED range, not the last attempted.
    test "pending range above watermark stays in remaining" do
      state = new_state(pending_notifications: [{10, 50}], last_pushed_gsn: 5)

      {to_push, remaining, new_last} = FanOutRouter.process_batch(state, 1, 8, 20)

      assert to_push == [{1, 8}]
      assert remaining == [{10, 50}]
      assert new_last == 8
    end
  end

  defp new_state(attrs) do
    struct(EbbServer.Sync.FanOutRouter, attrs)
  end
end
