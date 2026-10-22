defmodule EbbServer.Storage.WatermarkTrackerTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.WatermarkTracker

  defp with_isolated_tracker do
    unique_id = System.unique_integer([:positive])
    name = :"test_wm_#{unique_id}"
    table_name = :"test_committed_ranges_#{unique_id}"

    {:ok, _pid} = WatermarkTracker.start_link(name: name, table: table_name, initial_gsn: 0)

    on_exit(fn ->
      try do
        :ets.delete(table_name)
      rescue
        _ -> :ok
      end

      try do
        :persistent_term.erase({name, :gsn_ref})
      rescue
        _ -> :ok
      end

      try do
        :persistent_term.erase({name, :committed_ranges})
      rescue
        _ -> :ok
      end
    end)

    %{table: table_name, name: name}
  end

  describe "committed_watermark/0" do
    test "returns 0 when never advanced" do
      %{name: name} = with_isolated_tracker()
      assert WatermarkTracker.committed_watermark(name) == 0
    end

    test "returns N after mark_range_committed/2 + advance_watermark/0" do
      %{name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 5, name)
      assert WatermarkTracker.advance_watermark(name) == 5
      assert WatermarkTracker.committed_watermark(name) == 5
    end
  end

  describe "mark_range_committed/2" do
    test "records a single range as one row" do
      %{table: table, name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 1, name)

      assert :ets.tab2list(table) == [{1, 1}]
    end

    test "records a range as one row, not one row per GSN" do
      %{table: table, name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 1_000_000, name)

      assert :ets.tab2list(table) == [{1, 1_000_000}]
    end

    test "idempotent: inserting same GSN twice does not corrupt" do
      %{table: table, name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 1, name)
      WatermarkTracker.mark_range_committed(1, 1, name)

      entries = :ets.tab2list(table)
      assert length(entries) == 1
    end
  end

  describe "mark_range_resolved/3" do
    test "resolves a range through the same representation as committed" do
      %{table: table, name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_resolved(2, 4, name)

      assert :ets.tab2list(table) == [{2, 4}]
    end

    test "advances the frontier across a resolved hole" do
      %{name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 1, name)
      assert WatermarkTracker.advance_watermark(name) == 1

      # gsn 2 was claimed but abandoned: resolving it lets the frontier
      # cross the hole.
      WatermarkTracker.mark_range_resolved(2, 2, name)
      assert WatermarkTracker.advance_watermark(name) == 2

      WatermarkTracker.mark_range_committed(3, 3, name)
      assert WatermarkTracker.advance_watermark(name) == 3
    end

    test "is idempotent" do
      %{table: table, name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_resolved(1, 3, name)
      WatermarkTracker.mark_range_resolved(1, 3, name)

      assert WatermarkTracker.advance_watermark(name) == 3
      assert :ets.tab2list(table) == []
    end
  end

  describe "advance_watermark/0" do
    test "returns current watermark when ETS is empty" do
      %{name: name} = with_isolated_tracker()

      assert WatermarkTracker.advance_watermark(name) == 0
    end

    test "advances past contiguous range [1, 2, 3]" do
      %{name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 3, name)
      assert WatermarkTracker.advance_watermark(name) == 3
    end

    test "stops at gap: given [1, 2, 4], returns 2" do
      %{name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 2, name)
      WatermarkTracker.mark_range_committed(4, 4, name)

      assert WatermarkTracker.advance_watermark(name) == 2
    end

    test "idempotent: calling twice with same range returns same value" do
      %{name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 3, name)

      first = WatermarkTracker.advance_watermark(name)
      second = WatermarkTracker.advance_watermark(name)

      assert first == second
      assert first == 3
    end

    test "CAS loop handles concurrent calls correctly" do
      %{name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 100, name)

      results =
        1..10
        |> Enum.map(fn _ ->
          Task.async(fn -> WatermarkTracker.advance_watermark(name) end)
        end)
        |> Enum.map(&Task.await/1)

      max_result = Enum.max(results)
      min_result = Enum.min(results)

      assert max_result == 100, "Max should be 100, got #{max_result}"
      assert min_result >= 1, "Min should be at least 1, got #{min_result}"

      assert Enum.all?(results, &(&1 >= 1 and &1 <= 100)),
             "All results should be between 1 and 100"
    end

    test "advances when previous watermark > 0 and next gsn is committed (regression for FanOutRouter slice-1 bug)" do
      # Rows are keyed by an integer (the range's first GSN), so the tuple
      # ordering hazard that stalled the frontier before #277 cannot recur.
      %{name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 1, name)
      assert WatermarkTracker.advance_watermark(name) == 1

      WatermarkTracker.mark_range_committed(2, 2, name)
      assert WatermarkTracker.advance_watermark(name) == 2

      WatermarkTracker.mark_range_committed(3, 5, name)
      assert WatermarkTracker.advance_watermark(name) == 5
    end
  end

  describe "range granularity (#572)" do
    test "admits a huge range in one row and advances across it in one step" do
      %{table: table, name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 2_000_000, name)
      assert :ets.info(table, :size) == 1

      assert WatermarkTracker.advance_watermark(name) == 2_000_000
      assert :ets.info(table, :size) == 0
    end

    test "consumes a contiguous run of ranges in one call" do
      %{table: table, name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 100, name)
      WatermarkTracker.mark_range_committed(101, 250, name)
      WatermarkTracker.mark_range_committed(251, 300, name)

      assert WatermarkTracker.advance_watermark(name) == 300
      assert :ets.tab2list(table) == []
    end

    test "advances across a range that overlaps the frontier" do
      # The restart reconcile re-marks `(watermark, counter]`, so a row can
      # straddle the frontier after another process advanced it.
      %{table: table, name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 10, name)
      assert WatermarkTracker.advance_watermark(name) == 10

      WatermarkTracker.mark_range_committed(5, 20, name)
      assert WatermarkTracker.advance_watermark(name) == 20
      assert :ets.tab2list(table) == []
    end

    test "a re-marked resolved range does not stall the frontier" do
      %{table: table, name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 5, name)
      assert WatermarkTracker.advance_watermark(name) == 5

      WatermarkTracker.mark_range_committed(1, 5, name)
      assert WatermarkTracker.advance_watermark(name) == 5
      assert :ets.tab2list(table) == []
    end

    test "does not advance while a gap remains, and absorbs the tail when it fills" do
      %{name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 2, name)
      WatermarkTracker.mark_range_committed(5, 8, name)
      assert WatermarkTracker.advance_watermark(name) == 2

      WatermarkTracker.mark_range_committed(3, 4, name)
      assert WatermarkTracker.advance_watermark(name) == 8
    end
  end

  describe "committed range pruning (#277)" do
    test "deletes entries below the advanced watermark" do
      %{table: table, name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 5, name)
      assert WatermarkTracker.advance_watermark(name) == 5

      assert :ets.tab2list(table) == []
    end

    test "keeps entries above the watermark" do
      %{table: table, name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 2, name)
      WatermarkTracker.mark_range_committed(4, 4, name)

      assert WatermarkTracker.advance_watermark(name) == 2
      assert :ets.tab2list(table) == [{4, 4}]
    end

    test "table stays bounded over a long commit sequence" do
      %{table: table, name: name} = with_isolated_tracker()

      for gsn <- 1..500 do
        WatermarkTracker.mark_range_committed(gsn, gsn, name)
        WatermarkTracker.advance_watermark(name)
      end

      assert WatermarkTracker.committed_watermark(name) == 500
      assert :ets.info(table, :size) == 0
    end

    test "advancement still works after pruning" do
      %{table: table, name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 3, name)
      assert WatermarkTracker.advance_watermark(name) == 3
      assert :ets.tab2list(table) == []

      WatermarkTracker.mark_range_committed(4, 6, name)
      assert WatermarkTracker.advance_watermark(name) == 6
    end
  end
end
