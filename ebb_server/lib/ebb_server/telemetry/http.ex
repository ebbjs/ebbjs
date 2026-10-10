defmodule EbbServer.Telemetry.HTTP do
  @moduledoc """
  Translates Bandit's request spans into `ebb.http.request_latency_ms`.

  Bandit emits `[:bandit, :request, :start | :stop | :exception]` around every
  HTTP request. This handler pairs a request's start with its terminating
  event by `telemetry_span_context` and emits one `ebb.http.request_latency_ms`
  sample for the completed request, with `method`, `route`, and `status`
  metadata. Measuring inside the request process makes server-side API latency
  independent of MessagePack encoding and client round-trip overhead.

  The handler is attached at boot before Bandit starts and detached on
  shutdown. Start and terminating events always run in the same request
  process, so the start time lives in that process's dictionary; keying it by
  span context keeps keep-alive requests on one connection from colliding.

  ## The SSE exemption

  Requests routed to `GET /sync/live` are deliberately not sampled, so the
  same long-lived connection is not represented in two metric families. That
  endpoint blocks the request process for the lifetime of the SSE connection
  (see `EbbServer.Sync.SSEHandler`), so Bandit's span duration for it is
  minutes to hours of connection time, not request service time; as a latency
  sample it would dominate the histogram. The connection itself is already
  observable through the `ebb.fanout.active_connections` and
  `ebb.fanout.active_groups` gauges. Every other route is sampled exactly
  once, on its terminating event — never on `:start` — so no request is
  counted twice.

  The `/sync/live` literal mirrors the route in `EbbServer.Sync.Router`.

  Disable with `enabled: false` or by setting
  `config :ebb_server, EbbServer.Telemetry.HTTP, enabled: false`.
  """

  use GenServer

  alias EbbServer.Telemetry

  @handler_id {__MODULE__, :bandit}
  @events [
    [:bandit, :request, :start],
    [:bandit, :request, :stop],
    [:bandit, :request, :exception]
  ]
  @sse_route "/sync/live"
  @fallback_status 500
  @unknown "unknown"

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    opts = Keyword.merge(Application.get_env(:ebb_server, __MODULE__, []), opts)
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(opts) do
    if Keyword.get(opts, :enabled, true) do
      # Detach first so a restart after an ungraceful shutdown re-attaches
      # instead of failing with :already_exists.
      :telemetry.detach(@handler_id)
      :ok = :telemetry.attach_many(@handler_id, @events, &__MODULE__.handle_event/4, nil)
      {:ok, %{}}
    else
      :ignore
    end
  end

  @impl true
  def terminate(_reason, _state) do
    :telemetry.detach(@handler_id)
    :ok
  end

  @doc false
  def handle_event([:bandit, :request, :start], measurements, metadata, _config) do
    Process.put(start_key(metadata), measurements[:monotonic_time])
    :ok
  end

  def handle_event([:bandit, :request, :stop], measurements, metadata, _config) do
    delete_start(metadata)
    emit(measurements[:duration], metadata)
  end

  # `:exception` carries no `duration` measurement, so time it against the
  # recorded start; a start that was never recorded falls back to zero.
  def handle_event([:bandit, :request, :exception], _measurements, metadata, _config) do
    duration =
      case delete_start(metadata) do
        nil -> 0
        start -> System.monotonic_time() - start
      end

    emit(duration, metadata)
  end

  defp start_key(metadata), do: {__MODULE__, :start, metadata[:telemetry_span_context]}

  defp delete_start(metadata), do: Process.delete(start_key(metadata))

  defp emit(duration, metadata) do
    labels = labels(metadata)

    if labels.route == @sse_route do
      :ok
    else
      Telemetry.execute([:http, :request_latency_ms], %{duration: duration}, labels)
    end
  end

  # Bandit omits `conn` when an error prevents it from building one; the
  # request is still counted so unhandled failures show up in the histogram.
  defp labels(%{conn: %Plug.Conn{} = conn}) do
    %{method: conn.method, route: route(conn), status: conn.status || @fallback_status}
  end

  defp labels(_metadata), do: %{method: @unknown, route: @unknown, status: @fallback_status}

  defp route(%Plug.Conn{private: private, request_path: request_path}) do
    case private[:plug_route] do
      {route, _fun} when is_binary(route) -> route
      _ -> request_path || @unknown
    end
  end
end
