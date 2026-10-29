defmodule EbbServer.Bench.Subscriber do
  @moduledoc """
  In-process SSE subscribers for tiers T3 and T4.

  Each subscriber is a lightweight process that owns one real
  `EbbServer.Sync.SSEConnection` (started under
  `SSEConnectionSupervisor`) and subscribes it through `FanOutRouter`.
  This exercises the same writer → `FanOutRouter` → `GroupServer` →
  `SSEConnection` path as a live HTTP client without opening thousands of
  TCP connections.

  Delivery counters live in shared ETS rather than in the subscriber's
  mailbox, so a saturation run can be stopped by killing the subscribers
  instead of waiting for a stop message queued behind millions of
  `{:sse_data, ...}` messages. A sampled delivery arrives as
  `{:sse_data, bytes, meta}` and counts the same as an unsampled one.
  Delivery lag is measured from a monotonic stamp the workbook embeds in
  every Action; the stamp is client-side, so it spans client send → commit →
  dispatch → subscriber delivery. The server's
  own `ebb.fanout.push_latency_ms` (captured by `EbbServer.Bench.Telemetry`)
  reports commit → broadcast complete separately. Only every `@sample_every` delivery
  is decoded, to keep decoding off the hot path.

  With `lean: true` every subscriber owns its own counter and the shared lag
  table is skipped, so a run can tell whether the shared counter/ETS in the
  harness is the fan-out ceiling. Lean runs report no lag samples; the
  non-lean default keeps the shared counter and lag sampling.

  With `count_only: true` every subscriber also skips the per-frame split
  and lag decode, counting `event: data` occurrences with `:binary.matches/2`
  instead. The delivery count stays correct, while the consumer's CPU no
  longer competes with the server on the same schedulers, which is how a run
  separates server fan-out cost from consumer cost.
  """

  alias EbbServer.Sync.{FanOutRouter, SSEConnectionSupervisor}

  @sample_every 50
  @lag_cap 200_000
  @ready_timeout 10_000
  @drain_ms 50

  @type counters :: :counters.counters_ref() | [:counters.counters_ref()]

  @type t :: %{
          counters: counters(),
          lags: :ets.tid() | nil,
          pids: [pid()],
          lean: boolean(),
          count_only: boolean()
        }

  @doc """
  Starts `count` subscribers on the bench group. Returns `nil` for zero.
  """
  @spec start_all(non_neg_integer(), map()) :: t() | nil
  def start_all(count, ctx), do: start_all(count, ctx, [])

  @doc """
  Starts `count` subscribers on the bench group.

  `lean: true` gives every subscriber its own delivery counter and skips the
  shared lag table; the default shares one counter and samples lag.
  Returns `nil` for zero.
  """
  @spec start_all(non_neg_integer(), map(), keyword()) :: t() | nil
  def start_all(0, _ctx, _opts), do: nil

  def start_all(count, ctx, opts) do
    cond do
      Keyword.get(opts, :count_only, false) ->
        counters = for _ <- 1..count, do: :counters.new(2, [:write_concurrency])
        pids = Enum.map(counters, &start(ctx, &1, nil, true))
        %{counters: counters, lags: nil, pids: pids, lean: true, count_only: true}

      Keyword.get(opts, :lean, false) ->
        counters = for _ <- 1..count, do: :counters.new(2, [:write_concurrency])
        pids = Enum.map(counters, &start(ctx, &1, nil, false))
        %{counters: counters, lags: nil, pids: pids, lean: true, count_only: false}

      true ->
        counters = :counters.new(2, [:write_concurrency])
        lags = :ets.new(:bench_subscriber_lags, [:bag, :public])
        pids = Enum.map(1..count, fn _ -> start(ctx, counters, lags, false) end)
        %{counters: counters, lags: lags, pids: pids, lean: false, count_only: false}
    end
  end

  @doc """
  Cumulative `data` chunks delivered to all subscribers.

  `nil` when there are no subscribers, so the fixed-rate metrics can
  report the delivered rate as not measured.
  """
  @spec delivered(t() | nil) :: non_neg_integer() | nil
  def delivered(nil), do: nil

  def delivered(%{counters: counters, lean: true}) do
    Enum.reduce(counters, 0, &(:counters.get(&1, 1) + &2))
  end

  def delivered(%{counters: counters}), do: :counters.get(counters, 1)

  @doc """
  Kills the subscribers and returns the aggregate delivery stats.
  """
  @spec stop_all(t() | nil) :: map() | nil
  def stop_all(nil), do: nil

  def stop_all(%{lags: lags, pids: pids} = subscriber) do
    Enum.each(pids, &Process.exit(&1, :kill))
    # Let the kills land and the SSEConnection monitors fire before the
    # tree is torn down, so the final counters are stable.
    Process.sleep(@drain_ms)

    stats = %{
      subscribers: length(pids),
      delivered_total: delivered(subscriber),
      control_total: control_total(subscriber),
      lags: lag_samples(lags)
    }

    if lags, do: :ets.delete(lags)
    stats
  end

  defp control_total(%{counters: counters, lean: true}) do
    Enum.reduce(counters, 0, &(:counters.get(&1, 2) + &2))
  end

  defp control_total(%{counters: counters}), do: :counters.get(counters, 2)

  defp lag_samples(nil), do: []
  defp lag_samples(table), do: table |> :ets.tab2list() |> Enum.map(&elem(&1, 1))

  defp start(ctx, counters, lags, count_only?) do
    parent = self()
    pid = spawn(fn -> init(parent, ctx, counters, lags, count_only?) end)

    receive do
      {:subscriber_ready, ^pid} -> pid
    after
      @ready_timeout -> raise "SSE subscriber did not become ready"
    end
  end

  defp init(parent, ctx, counters, lags, count_only?) do
    {:ok, sse_pid} =
      SSEConnectionSupervisor.start_child(self(), [ctx.group_id], %{ctx.group_id => 0})

    :ok = FanOutRouter.subscribe([ctx.group_id], sse_pid, ctx.actor_id)
    send(parent, {:subscriber_ready, self()})
    loop(counters, lags, 0, count_only?)
  end

  defp loop(counters, lags, delivered, true) do
    receive do
      # Count frames without splitting every chunk; this is the mode that
      # keeps the consumer off the server's schedulers.
      {:sse_data, bytes} ->
        loop(counters, lags, count_only_chunk(counters, delivered, bytes), true)

      # A sampled delivery carries the GroupServer's meta; the frame count is
      # the same, so the bench ignores it.
      {:sse_data, bytes, _meta} ->
        loop(counters, lags, count_only_chunk(counters, delivered, bytes), true)

      {:sse_chunk, "data", _payload} ->
        :counters.add(counters, 1, 1)
        loop(counters, lags, delivered + 1, true)

      {:sse_chunk, _kind, _payload} ->
        :counters.add(counters, 2, 1)
        loop(counters, lags, delivered, true)
    end
  end

  defp loop(counters, lags, delivered, false) do
    receive do
      # One coalesced chunk per batch: it may carry several `data` frames.
      {:sse_data, bytes} ->
        loop(counters, lags, count_chunk(counters, lags, delivered, bytes), false)

      {:sse_data, bytes, _meta} ->
        loop(counters, lags, count_chunk(counters, lags, delivered, bytes), false)

      {:sse_chunk, "data", payload} ->
        :counters.add(counters, 1, 1)
        delivered = delivered + 1
        if rem(delivered, @sample_every) == 0, do: maybe_record_lag(lags, payload)
        loop(counters, lags, delivered, false)

      {:sse_chunk, _kind, _payload} ->
        :counters.add(counters, 2, 1)
        loop(counters, lags, delivered, false)
    end
  end

  defp count_only_chunk(counters, delivered, bytes) do
    count = length(:binary.matches(bytes, "event: data"))
    :counters.add(counters, 1, count)
    delivered + count
  end

  defp count_chunk(counters, lags, delivered, bytes) do
    payloads = data_payloads(bytes)
    :counters.add(counters, 1, length(payloads))

    Enum.reduce(payloads, delivered, fn payload, delivered ->
      delivered = delivered + 1
      if rem(delivered, @sample_every) == 0, do: maybe_record_lag(lags, payload)
      delivered
    end)
  end

  # Splits a coalesced chunk into one JSON payload per `data` frame, the
  # same split the tests use.
  defp data_payloads(bytes) do
    bytes
    |> IO.iodata_to_binary()
    |> String.split("\n\n", trim: true)
    |> Enum.map(fn frame ->
      frame
      |> String.split("\n")
      |> Enum.find_value(fn
        "data: " <> payload -> payload
        _ -> nil
      end)
    end)
  end

  # Lean mode has no shared lag table, so lag sampling is skipped entirely.
  defp maybe_record_lag(nil, _payload), do: :ok

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
