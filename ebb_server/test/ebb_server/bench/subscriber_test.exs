defmodule EbbServer.Bench.SubscriberTest do
  @moduledoc """
  Pins the in-process subscriber modes: the shared-counter default and the
  lean mode that gives every subscriber its own counter and skips lag
  sampling, so a run can rule out shared-resource contention in the harness.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  alias EbbServer.Bench.Subscriber

  setup do
    ctx = %{
      group_id: "grp_bench_sub_#{:erlang.unique_integer([:positive])}",
      actor_id: "actor_bench"
    }

    %{ctx: ctx}
  end

  test "lean mode sums per-subscriber counters and reports no lag samples", %{ctx: ctx} do
    subscribers = Subscriber.start_all(3, ctx, lean: true)

    for pid <- subscribers.pids, do: send(pid, {:sse_data, chunk(2)})
    Process.sleep(50)

    assert Subscriber.delivered(subscribers) == 6

    stats = Subscriber.stop_all(subscribers)

    assert stats.subscribers == 3
    assert stats.delivered_total == 6
    assert stats.control_total == 0
    assert stats.lags == []
  end

  test "count-only mode counts frames without splitting them", %{ctx: ctx} do
    subscribers = Subscriber.start_all(3, ctx, count_only: true)

    for pid <- subscribers.pids, do: send(pid, {:sse_data, chunk(2)})
    Process.sleep(50)

    assert Subscriber.delivered(subscribers) == 6
    assert subscribers.count_only

    stats = Subscriber.stop_all(subscribers)

    assert stats.delivered_total == 6
    assert stats.lags == []
  end

  test "the shared default aggregates deliveries through one counter", %{ctx: ctx} do
    subscribers = Subscriber.start_all(3, ctx)

    for pid <- subscribers.pids, do: send(pid, {:sse_data, chunk(2)})
    Process.sleep(50)

    assert Subscriber.delivered(subscribers) == 6
    assert Subscriber.stop_all(subscribers).delivered_total == 6
  end

  test "zero subscribers is nil", %{ctx: ctx} do
    assert Subscriber.start_all(0, ctx, lean: true) == nil
    assert Subscriber.delivered(nil) == nil
    assert Subscriber.stop_all(nil) == nil
  end

  defp chunk(count) do
    Enum.map_join(1..count, fn _ -> "event: data\ndata: {\"bench\":1}\n\n" end)
  end
end
