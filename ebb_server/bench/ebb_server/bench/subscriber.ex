defmodule EbbServer.Bench.Subscriber do
  @moduledoc """
  In-process SSE subscribers for tier T3.

  Each subscriber is a lightweight process that owns one real
  `EbbServer.Sync.SSEConnection` (started under
  `SSEConnectionSupervisor`) and subscribes it through `FanOutRouter`.
  This exercises the same writer → `FanOutRouter` → `GroupServer` →
  `SSEConnection` path as a live HTTP client without opening thousands of
  TCP connections.

  Delivery counters live in shared ETS rather than in the subscriber's
  mailbox, so a saturation run can be stopped by killing the subscribers
  instead of waiting for a stop message queued behind millions of
  `{:sse_chunk, ...}` messages. Delivery lag is measured from a monotonic
  stamp the workbook embeds in every Action; the stamp is client-side, so it
  spans client send → commit → dispatch → subscriber delivery. The server's
  own `ebb.fanout.push_latency_ms` (captured by `EbbServer.Bench.Telemetry`)
  reports commit → dispatch separately. Only every `@sample_every` delivery
  is decoded, to keep decoding off the hot path.
  """

  alias EbbServer.Sync.{FanOutRouter, SSEConnectionSupervisor}

  @sample_every 50
  @lag_cap 200_000
  @ready_timeout 10_000
  @drain_ms 50

  @type t :: %{counters: :counters.counters_ref(), lags: :ets.tid(), pids: [pid()]}

  @doc """
  Starts `count` subscribers on the bench group. Returns `nil` for zero.
  """
  @spec start_all(non_neg_integer(), map()) :: t() | nil
  def start_all(0, _ctx), do: nil

  def start_all(count, ctx) do
    counters = :counters.new(2, [:write_concurrency])
    lags = :ets.new(:bench_subscriber_lags, [:bag, :public])

    pids =
      Enum.map(1..count, fn _ -> start(ctx, counters, lags) end)

    %{counters: counters, lags: lags, pids: pids}
  end

  @doc """
  Kills the subscribers and returns the aggregate delivery stats.
  """
  @spec stop_all(t() | nil) :: map() | nil
  def stop_all(nil), do: nil

  def stop_all(%{counters: counters, lags: lags, pids: pids}) do
    Enum.each(pids, &Process.exit(&1, :kill))
    # Let the kills land and the SSEConnection monitors fire before the
    # tree is torn down, so the final counters are stable.
    Process.sleep(@drain_ms)

    stats = %{
      subscribers: length(pids),
      delivered_total: :counters.get(counters, 1),
      control_total: :counters.get(counters, 2),
      lags: lags |> :ets.tab2list() |> Enum.map(&elem(&1, 1))
    }

    :ets.delete(lags)
    stats
  end

  defp start(ctx, counters, lags) do
    parent = self()
    pid = spawn(fn -> init(parent, ctx, counters, lags) end)

    receive do
      {:subscriber_ready, ^pid} -> pid
    after
      @ready_timeout -> raise "SSE subscriber did not become ready"
    end
  end

  defp init(parent, ctx, counters, lags) do
    {:ok, sse_pid} =
      SSEConnectionSupervisor.start_child(self(), [ctx.group_id], %{ctx.group_id => 0})

    :ok = FanOutRouter.subscribe([ctx.group_id], sse_pid, ctx.actor_id)
    send(parent, {:subscriber_ready, self()})
    loop(counters, lags, 0)
  end

  defp loop(counters, lags, delivered) do
    receive do
      {:sse_chunk, "data", payload} ->
        delivered = delivered + 1
        :counters.add(counters, 1, 1)
        if rem(delivered, @sample_every) == 0, do: maybe_record_lag(lags, payload)
        loop(counters, lags, delivered)

      {:sse_chunk, _kind, _payload} ->
        :counters.add(counters, 2, 1)
        loop(counters, lags, delivered)
    end
  end

  defp maybe_record_lag(lags, payload) do
    if :ets.info(lags, :size) < @lag_cap do
      case delivery_lag(payload) do
        nil -> :ok
        lag -> :ets.insert(lags, {:lag, lag})
      end
    end
  end

  defp delivery_lag(payload) do
    with {:ok, %{"updates" => [update | _]}} <- Jason.decode(payload),
         sent when is_integer(sent) <-
           get_in(update, ["data", "fields", "bench_sent_us", "value"]) do
      System.monotonic_time(:microsecond) - sent
    else
      _ -> nil
    end
  end
end
