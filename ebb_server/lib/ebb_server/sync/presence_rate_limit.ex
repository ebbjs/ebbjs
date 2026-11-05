defmodule EbbServer.Sync.PresenceRateLimit do
  @moduledoc """
  Per-actor token-bucket limit for `POST /sync/presence`, and the ETS-backed
  bucket store it reads.

  ## Placement

  Runs in `EbbServer.Sync.Router`'s pipeline after
  `EbbServer.Sync.AuthPlug` — it needs `conn.assigns.actor_id` — and before
  `plug(:match)`, so a limited request is rejected before the route touches
  the entity index or the fan-out. It inspects only `POST /sync/presence`;
  every other request passes through untouched. The Action path deliberately
  has no server-side limit here: the client already batches Actions through
  its flush scheduler, while presence does not.

  ## Why the bucket is keyed by actor

  `GroupServer` keys its subscribers by connection pid, so one actor with two
  tabs is two subscribers and receives every presence packet twice. The
  amplifier this bounds is the actor's share of the fan-out, not a single
  socket's, so the bucket is keyed by `actor_id`: two connections from one
  actor share one budget.

  ## Configuration

  `config :ebb_server, :presence_rate_limit, {per_second, burst}`

  `per_second` is the sustained refill rate and `burst` the bucket capacity,
  both positive integers. The default is `{100, 200}`. The client debounces a
  send by 100 ms per `(entity, channel)` per tab, but a channel may declare a
  shorter `debounceMs`, so a limit sized to the cursor-only two-tab workload
  (20 sends a second) would reject legitimate peers. 100 a second covers
  several channels and tabs — including a 16 ms channel — while still bounding
  one actor's share of the fan-out; an app that paces faster raises the limit.

  ## State: ETS, not a GenServer

  Buckets live in a public ETS table owned by
  `EbbServer.Sync.PresenceRateLimit.Buckets`, a small process under
  `EbbServer.Sync.Supervisor`. A plug call is then one ETS read, one pure
  token-bucket step, and one ETS write — no `GenServer.call`. A single
  GenServer holding the counters would be simpler, but it would funnel every
  presence POST through one mailbox right before the fan-out that the route
  already has to do, turning a cheap per-actor counter into a serialisation
  point. The trade-off is that concurrent requests from the same actor can
  read the same bucket before either writes it, so a lost decrement admits at
  most one extra request per race. That is acceptable for an amplifier cap;
  it is not a quota.

  The owner process exists only for the table's lifetime and to sweep idle
  buckets. Because every request carries its own `now`, the arithmetic stays a
  pure function of `(bucket, now, rate)` and is testable without a clock.
  """

  @behaviour Plug

  alias EbbServer.Sync.PresenceRateLimit.Buckets

  @default_rate {100, 200}

  @impl true
  def init(opts), do: opts

  @impl true
  def call(%Plug.Conn{method: "POST", path_info: ["sync", "presence"]} = conn, _opts) do
    case conn.assigns[:actor_id] do
      actor_id when is_binary(actor_id) -> limit(conn, actor_id)
      _no_actor -> conn
    end
  end

  def call(conn, _opts), do: conn

  defp limit(conn, actor_id) do
    case Buckets.consume(actor_id, now_ms(), rate()) do
      :ok ->
        conn

      {:limited, retry_after_ms} ->
        conn
        |> Plug.Conn.put_resp_header("retry-after", retry_after_seconds(retry_after_ms))
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(429, Jason.encode!(%{"error" => "rate_limited"}))
        |> Plug.Conn.halt()
    end
  end

  @doc """
  The configured `{per_second, burst}` rate.

  An invalid value raises rather than silently disabling the limit: a
  misconfigured node should fail loudly, not quietly drop the protection.
  """
  @spec rate() :: Buckets.rate()
  def rate do
    case Application.get_env(:ebb_server, :presence_rate_limit, @default_rate) do
      {per_second, burst} = rate
      when is_integer(per_second) and per_second > 0 and is_integer(burst) and burst > 0 ->
        rate

      other ->
        raise ArgumentError,
              ":presence_rate_limit must be {per_second, burst} with positive integers, " <>
                "got: #{inspect(other)}"
    end
  end

  defp now_ms, do: System.monotonic_time(:millisecond)

  # `Retry-After` is whole seconds, rounded up so a client that honours it
  # cannot retry before a token is actually available.
  defp retry_after_seconds(retry_after_ms) do
    max(Buckets.ceil_div(retry_after_ms, 1000), 1) |> Integer.to_string()
  end
end
