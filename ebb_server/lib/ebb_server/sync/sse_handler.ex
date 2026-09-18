defmodule EbbServer.Sync.SSEHandler do
  @moduledoc """
  Opens and drives a long-lived SSE connection for one client.

  ## Why this module blocks the request process

  Bandit's pipeline calls our plug and waits for the returned `Plug.Conn`.
  For a chunked response, Bandit commits the response (sends an empty
  terminator chunk) the moment the plug returns, which closes the
  connection. To keep the SSE stream open, we block the request process
  in a `receive` loop here:

  1. `open_sse/4` calls `send_chunked(200)`, transitioning the conn into
     `:chunked state.
  2. It then starts an `SSEConnection` GenServer under
     `SSEConnectionSupervisor` and subscribes it to the `FanOutRouter`.
  3. It enters a `receive` loop that handles two message types:
     - `:keepalive` (self-scheduled every 15s) — chunks a `: keepalive\\n\\n` comment.
     - `{:sse_chunk, kind, payload}` from the SSEConnection — chunks the
       formatted SSE event.
  4. The loop exits when:
     - A chunk write fails with `{:error, :closed}` (client disconnect), or
     - The SSEConnection dies (its DOWN message arrives).

  When the loop exits, `open_sse/4` returns `:ok` and Bandit commits the
  response (the empty terminator chunk). The connection is then fully
  closed.

  ## Stale cursor

  If the client's cursor exceeds the committed watermark, the router
  short-circuits to `write_stale_cursor_response/2`, which sends a single
  SSE `control` event and returns `:closed`. No connection is opened in
  that case.

  ## Public Interface

  ### open_sse/4

  Takes a Plug.Conn, a list of group IDs, a cursor GSN, and an actor ID.
  Blocks the request process until the connection ends.

  ### write_stale_cursor_response/2

  Switches the conn to chunked mode, writes a single `control` event
  with `reconnect: true` and `catchUpFrom`, and returns `:closed`. Used
  by the router when the client's cursor is ahead of the watermark.

  ## Return shape

  - `:ok` after a normal SSE session ends.
  - `{:error, :not_member}` if the actor is not a member of any requested group.
  - `:closed` from `write_stale_cursor_response/2` (the router also returns this).
  """

  alias EbbServer.Storage.GroupCache
  alias EbbServer.Sync.{FanOutRouter, SSEConnection, SSEConnectionSupervisor}

  @stale_cursor_event ~S(event: control
data: {"reconnect":true,"reason":"behind_watermark","catchUpFrom":)
  @stale_cursor_suffix "\"\n\n}"
  @keepalive_interval_ms 15_000

  @spec open_sse(Plug.Conn.t(), [String.t()], non_neg_integer(), String.t()) ::
          :ok | {:error, :not_member}
  def open_sse(conn, group_ids, cursor, actor_id) do
    with :ok <- verify_membership(group_ids, actor_id) do
      open_sse_connection(conn, group_ids, cursor, actor_id)
    end
  end

  defp verify_membership(group_ids, actor_id) do
    non_member_groups =
      Enum.reject(group_ids, fn group_id ->
        GroupCache.get_permissions(actor_id, group_id) != nil
      end)

    if non_member_groups == [] or Enum.empty?(group_ids) do
      :ok
    else
      {:error, :not_member}
    end
  end

  # Runs in the Bandit request process. Calls `send_chunked`, starts the
  # forwarding GenServer, then blocks in a receive loop. The loop keeps
  # Bandit's pipeline blocked until the client disconnects (chunk returns
  # :closed) or the SSEConnection dies.
  defp open_sse_connection(conn, group_ids, cursor, _actor_id) do
    cursors = Map.new(group_ids, fn group_id -> {group_id, cursor} end)

    conn =
      conn
      |> Plug.Conn.put_resp_content_type("text/event-stream")
      |> Plug.Conn.put_resp_header("cache-control", "no-cache")
      |> Plug.Conn.put_resp_header("connection", "keep-alive")
      |> Plug.Conn.send_chunked(200)

    {:ok, sse_pid} = SSEConnectionSupervisor.start_child(self(), group_ids, cursors)
    FanOutRouter.subscribe(group_ids, sse_pid)

    run_sse_loop(conn, sse_pid)
    :ok
  end

  # Block the request process, dispatching `:sse_chunk` and `:keepalive`
  # messages until the connection is closed (write returns :closed) or the
  # forwarding GenServer exits.
  defp run_sse_loop(conn, sse_pid) do
    monitor_ref = Process.monitor(sse_pid)
    Process.send_after(self(), :keepalive, @keepalive_interval_ms)

    do_sse_loop(conn, sse_pid, monitor_ref)
  end

  defp do_sse_loop(conn, sse_pid, monitor_ref) do
    receive do
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

  @doc """
  Writes a stale cursor control event to the chunked response and returns `:closed`.

  Called by the router when the client's cursor exceeds the committed watermark.
  """
  @spec write_stale_cursor_response(Plug.Conn.t(), non_neg_integer()) :: :closed
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
      {:ok, _conn} -> :closed
      {:error, _reason} -> :closed
    end
  end
end
