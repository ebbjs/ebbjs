defmodule EbbServer.Bench.Http do
  @moduledoc """
  Minimal HTTP client for `POST /sync/actions`.

  Uses `:httpc` (already available through `:inets`) with a tuned session
  pool so a run does not serialize on the client. Client-side cost —
  MessagePack encoding, connection reuse, and the `:httpc` request
  manager — is included in every measured latency, which is noted in the
  report. If `:httpc` ever proves to be the bottleneck the fallback is a
  hand-rolled keep-alive client over `:gen_tcp`.
  """

  alias EbbServer.Bench.Workbook

  @timeout 30_000
  @connect_timeout 5_000
  @keep_alive_length 1_000

  @doc """
  Configures the `:httpc` profile for the run's concurrency.
  """
  @spec setup(pos_integer()) :: :ok
  def setup(concurrency) do
    :httpc.set_options(
      max_sessions: max(concurrency * 2, 8),
      keep_alive: true,
      max_keep_alive_length: @keep_alive_length
    )

    :ok
  end

  @doc """
  POSTs a batch of wire Actions and returns `{latency_us, rejected}`.

  `rejected` is counted from the response body's `rejected` array so a
  silently dropped Action is never counted as accepted.
  """
  @spec post_actions(:inet.port_number(), [map()]) ::
          {:ok, non_neg_integer(), non_neg_integer()} | {:error, non_neg_integer(), term()}
  def post_actions(port, actions) do
    body = Msgpax.pack!(%{"actions" => actions}) |> IO.iodata_to_binary()
    started = System.monotonic_time(:microsecond)
    result = :httpc.request(:post, request(port, body), http_options(), body_format: :binary)
    latency = System.monotonic_time(:microsecond) - started

    case result do
      {:ok, {{_, 200, _}, _headers, response}} -> {:ok, latency, rejected_count(response)}
      {:ok, {{_, status, _}, _headers, _response}} -> {:error, latency, {:http_status, status}}
      {:error, reason} -> {:error, latency, reason}
    end
  end

  defp request(port, body) do
    headers = [
      {~c"x-ebb-actor-id", String.to_charlist(Workbook.actor_id())},
      {~c"content-type", ~c"application/msgpack"}
    ]

    {~c"http://127.0.0.1:#{port}/sync/actions", headers, ~c"application/msgpack", body}
  end

  defp http_options, do: [timeout: @timeout, connect_timeout: @connect_timeout]

  defp rejected_count(response) do
    case Jason.decode(response) do
      {:ok, %{"rejected" => rejected}} when is_list(rejected) -> length(rejected)
      _ -> 0
    end
  end
end
