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
    test "inserts single GSN into ETS" do
      %{table: table, name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 1, name)

      entries = :ets.tab2list(table)
      assert length(entries) == 1
      assert [{{1, self()}, true}] == entries
    end

    test "inserts multiple GSNs into ETS" do
      %{table: table, name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 3, name)

      gsns =
        table
        |> :ets.tab2list()
        |> Enum.map(fn {{gsn, _pid}, _} -> gsn end)
        |> Enum.sort()

      assert gsns == [1, 2, 3]
    end

    test "idempotent: inserting same GSN twice does not corrupt" do
      %{table: table, name: name} = with_isolated_tracker()

      WatermarkTracker.mark_range_committed(1, 1, name)
      WatermarkTracker.mark_range_committed(1, 1, name)

      entries = :ets.tab2list(table)
      assert length(entries) == 1
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
  end
end
