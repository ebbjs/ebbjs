defmodule EbbServer.Storage.GsnCounterTest do
  use ExUnit.Case, async: false

  alias EbbServer.Storage.GsnCounter

  defp with_isolated_counter do
    counter_name = :"test_gsn_#{System.unique_integer([:positive])}"
    counter = :atomics.new(1, signed: false)
    :persistent_term.put(counter_name, counter)

    on_exit(fn ->
      :persistent_term.erase(counter_name)
    end)

    %{counter: counter, counter_name: counter_name}
  end

  describe "claim_gsn_range/2" do
    test "produces monotonically increasing, gap-free ranges" do
      %{counter: counter} = with_isolated_counter()

      assert {1, 1} = GsnCounter.claim_gsn_range(1, counter)
      assert {2, 4} = GsnCounter.claim_gsn_range(3, counter)
      assert {5, 5} = GsnCounter.claim_gsn_range(1, counter)
    end

    test "starts from the provided offset when counter is pre-initialized" do
      counter_name = :"test_gsn_offset_#{System.unique_integer([:positive])}"
      counter = :atomics.new(1, signed: false)
      :atomics.put(counter, 1, 100)
      :persistent_term.put(counter_name, counter)

      on_exit(fn ->
        :persistent_term.erase(counter_name)
      end)

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

  describe "reset/2" do
    test "resets GSN counter to 0" do
      %{counter: counter} = with_isolated_counter()

      assert {1, 5} = GsnCounter.claim_gsn_range(5, counter)
      assert {6, 10} = GsnCounter.claim_gsn_range(5, counter)

      :ok = GsnCounter.reset(:not_used, counter)

      assert {1, 1} = GsnCounter.claim_gsn_range(1, counter)
    end
  end

  describe "get_resources/0" do
    test "returns gsn_counter and gsn_counter_name keys" do
      resources = GsnCounter.get_resources()

      assert Map.has_key?(resources, :gsn_counter)
      assert Map.has_key?(resources, :gsn_counter_name)
      assert is_atom(resources.gsn_counter_name)
    end
  end
end
