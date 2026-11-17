defmodule EbbServer.Sync.SSEHandler do
  @moduledoc """
  Opens and drives a long-lived SSE connection for one client.

  ## Why this module blocks the request process

  Bandit's pipeline calls our plug and waits for the returned `Plug.Conn`.
  For a chunked response, Bandit commits the response (sends an empty
  terminator chunk) the moment the plug returns, which closes the
  connection. To keep the SSE stream open, we block the request process
  in a `receive` loop here.
  """

  alias EbbServer.Storage.PermissionChecker
  alias EbbServer.Sync.{FanOutRouter, SSEConnection, SSEConnectionSupervisor}
  alias EbbServer.Telemetry

  @stale_cursor_event ~S(event: control
data: {"reconnect":true,"reason":"behind_watermark","catchUpFrom":)
  @stale_cursor_suffix "}\n\n"
  @keepalive_interval_ms 15_000

  @spec open_sse(Plug.Conn.t(), [String.t()], non_neg_integer(), String.t()) ::
          :ok | {:error, :not_member}
  def open_sse(conn, group_ids, cursor, actor_id) do
    if PermissionChecker.member_of_all_groups?(group_ids, actor_id) do
      open_sse_connection(conn, group_ids, cursor, actor_id)
    else
      {:error, :not_member}
    end
  end

  defp open_sse_connection(conn, group_ids, cursor, actor_id) do
    cursors = Map.new(group_ids, fn group_id -> {group_id, cursor} end)

    conn =
      conn
      |> Plug.Conn.put_resp_content_type("text/event-stream")
      |> Plug.Conn.put_resp_header("cache-control", "no-cache")
      |> Plug.Conn.put_resp_header("connection", "keep-alive")
      |> Plug.Conn.send_chunked(200)

    {:ok, sse_pid} = SSEConnectionSupervisor.start_child(self(), group_ids, cursors)
    # Forward the authenticated actor_id so the GroupServer can tag this
    # subscriber correctly; presence broadcasts use it to tell "self" from
    # "peer".
    FanOutRouter.subscribe(group_ids, sse_pid, actor_id)

    run_sse_loop(conn, sse_pid)
    :ok
  end

  defp run_sse_loop(conn, sse_pid) do
    monitor_ref = Process.monitor(sse_pid)
    Process.send_after(self(), :keepalive, @keepalive_interval_ms)

    do_sse_loop(conn, sse_pid, monitor_ref)
  end

  defp do_sse_loop(conn, sse_pid, monitor_ref) do
    receive do
      # A committed batch arrives as one binary covering every frame in it;
      # write them in a single chunk. SSE is a byte stream, so many events in
      # one chunk are equivalent to many chunks.
      {:sse_data, bytes} ->
        case chunk(conn, bytes) do
          :ok -> do_sse_loop(conn, sse_pid, monitor_ref)
          :closed -> :ok
        end

      {:sse_data, bytes, meta} ->
        case chunk(conn, bytes) do
          :ok ->
            emit_conn_chunk(meta)
            do_sse_loop(conn, sse_pid, monitor_ref)

          :closed ->
            :ok
        end

      {:sse_chunk, kind, payload} ->
        case chunk(conn, SSEConnection.format_sse_event(kind, payload)) do
          :ok -> do_sse_loop(conn, sse_pid, monitor_ref)
          :closed -> :ok
        end

      :keepalive ->
        case chunk(conn, ": keepalive\n\n") do
          :ok ->
            Process.send_after(self(), :keepalive, @keepalive_interval_ms)
            do_sse_loop(conn, sse_pid, monitor_ref)

          :closed ->
            :ok
        end

      {:DOWN, ^monitor_ref, :process, ^sse_pid, _reason} ->
        :ok
    end
  end

  defp chunk(conn, payload) do
    case Plug.Conn.chunk(conn, payload) do
      {:ok, _conn} -> :ok
      {:error, _reason} -> :closed
    end
  end

  # The real-socket end of the chain: the sampled delivery's commit through
  # the socket accepting the chunk. A failed write and a range recovered
  # without a commit time have no sample to take.
  defp emit_conn_chunk(%{committed_at: committed_at, group_id: group_id})
       when is_integer(committed_at) do
    Telemetry.fanout_hop(:conn_chunk, max(System.monotonic_time() - committed_at, 0), group_id)
  end

  defp emit_conn_chunk(_meta), do: :ok

  @spec write_stale_cursor_response(Plug.Conn.t(), non_neg_integer()) :: Plug.Conn.t()
  def write_stale_cursor_response(conn, catch_up_from) do
    event = @stale_cursor_event <> to_string(catch_up_from) <> @stale_cursor_suffix

    # Switch to chunked mode before writing the SSE event, otherwise
    # `Plug.Conn.chunk/2` raises. Bandit commits an empty terminator chunk
    # the moment this plug returns, so the connection is brief (one event).
    conn =
      conn
      |> Plug.Conn.put_resp_content_type("text/event-stream")
      |> Plug.Conn.put_resp_header("cache-control", "no-cache")
      |> Plug.Conn.put_resp_header("connection", "keep-alive")
      |> Plug.Conn.send_chunked(200)

    case Plug.Conn.chunk(conn, event) do
      {:ok, conn} -> conn
      {:error, _reason} -> conn
    end
  end
end
