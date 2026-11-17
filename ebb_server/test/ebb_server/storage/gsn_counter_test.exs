defmodule EbbServer.Storage.GsnCounterTest do
  @moduledoc """
  Behavioral tests for GsnCounter - atomic GSN generation.

  GsnCounter provides monotonically increasing, gap-free sequence numbers
  using Erlang's :atomics module for lock-free atomic operations.

  ## Key Behaviors Tested

  - Sequential GSNs: claim_gsn_range returns consecutive integers
  - Range claiming: can claim multiple GSNs at once
  - Monotonicity: GSNs never decrease across claims
  - Concurrency: multiple processes can claim safely
  - Reset: counter can be reset to 0

  ## Architecture Context

  GsnCounter uses :atomics for lock-free atomic increments.
  It is NOT a GenServer - all operations are direct function calls.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.GsnCounter

  defp with_isolated_counter do
    counter = :atomics.new(1, signed: false)

    %{counter: counter}
  end

  describe "claim_gsn_range/2" do
    test "produces monotonically increasing, gap-free ranges" do
      %{counter: counter} = with_isolated_counter()

      assert {1, 1} = GsnCounter.claim_gsn_range(1, counter)
      assert {2, 4} = GsnCounter.claim_gsn_range(3, counter)
      assert {5, 5} = GsnCounter.claim_gsn_range(1, counter)
    end

    test "starts from the provided offset when counter is pre-initialized" do
      counter = :atomics.new(1, signed: false)
      :atomics.put(counter, 1, 100)

      assert {101, 101} = GsnCounter.claim_gsn_range(1, counter)
    end
  end

  describe "concurrent claiming" do
    test "10 concurrent tasks produce unique, complete GSN set" do
      %{counter: counter} = with_isolated_counter()

      tasks =
        for _ <- 1..10 do
          Task.async(fn -> GsnCounter.claim_gsn_range(1, counter) end)
        end

      results = Task.await_many(tasks)
      gsns = Enum.map(results, fn {start, start} -> start end)

      assert length(Enum.uniq(gsns)) == 10
      assert Enum.sort(gsns) == Enum.to_list(1..10)
    end
  end

  describe "reset/1" do
    test "resets GSN counter to 0" do
      %{counter: counter} = with_isolated_counter()

      assert {1, 5} = GsnCounter.claim_gsn_range(5, counter)
      assert {6, 10} = GsnCounter.claim_gsn_range(5, counter)

      :ok = GsnCounter.reset(counter)

      assert {1, 1} = GsnCounter.claim_gsn_range(1, counter)
    end
  end
end
