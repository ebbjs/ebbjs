defmodule EbbServer.Sync.TimingTest do
  @moduledoc """
  Unit tests for the span, clock and ceiling-division helpers the sync
  processes share. The nil and clamp cases are load-bearing for telemetry:
  a recovered range reports "not sampled", not "zero milliseconds".
  """

  use ExUnit.Case, async: true

  alias EbbServer.Sync.Timing

  describe "span/2" do
    test "measures elapsed time between two timestamps" do
      assert Timing.span(100, 250) == 150
    end

    test "never reports negative elapsed time" do
      assert Timing.span(250, 100) == 0
    end

    test "returns nil when either timestamp is missing" do
      assert Timing.span(nil, 100) == nil
      assert Timing.span(100, nil) == nil
      assert Timing.span(nil, nil) == nil
    end
  end

  test "now_ms/0 is monotonic and non-decreasing" do
    first = Timing.now_ms()
    second = Timing.now_ms()

    assert is_integer(first)
    assert second >= first
  end

  describe "ceil_div/2" do
    test "rounds up" do
      assert Timing.ceil_div(1, 1000) == 1
      assert Timing.ceil_div(1000, 1000) == 1
      assert Timing.ceil_div(1001, 1000) == 2
      assert Timing.ceil_div(0, 1000) == 0
    end

    test "rejects a zero divisor" do
      assert_raise FunctionClauseError, fn -> Timing.ceil_div(10, 0) end
    end
  end
end
