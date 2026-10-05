defmodule EbbServer.Sync.FanOutFrontierTest do
  @moduledoc """
  Unit tests for the persisted last-pushed GSN frontier.

  Uses an isolated name/table so the app-level frontier owned by
  `EbbServer.Sync.Supervisor` is untouched.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Sync.FanOutFrontier

  setup do
    start_supervised!(
      {FanOutFrontier, name: :fan_out_frontier_test, table: :fan_out_frontier_test_table}
    )

    :ok
  end

  test "get/1 is :empty until a frontier is put" do
    assert FanOutFrontier.get(:fan_out_frontier_test) == :empty
  end

  test "put/2 stores the last pushed GSN and get/1 reads it back" do
    assert :ok = FanOutFrontier.put(42, :fan_out_frontier_test)
    assert FanOutFrontier.get(:fan_out_frontier_test) == {:ok, 42}
  end

  test "put/2 does not rewind the frontier" do
    :ok = FanOutFrontier.put(42, :fan_out_frontier_test)
    :ok = FanOutFrontier.put(7, :fan_out_frontier_test)

    assert FanOutFrontier.get(:fan_out_frontier_test) == {:ok, 42}
  end

  test "put/2 is a no-op when the frontier table is unavailable" do
    assert :ok = FanOutFrontier.put(7, :fan_out_frontier_never_started)
    assert FanOutFrontier.get(:fan_out_frontier_never_started) == :empty
  end

  test "reset/1 clears the frontier" do
    :ok = FanOutFrontier.put(42, :fan_out_frontier_test)
    :ok = FanOutFrontier.reset(:fan_out_frontier_test)

    assert FanOutFrontier.get(:fan_out_frontier_test) == :empty
  end

  test "get/1 returns :empty when the frontier has never been started" do
    assert FanOutFrontier.get(:fan_out_frontier_never_started) == :empty
  end
end
