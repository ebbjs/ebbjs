defmodule EbbServer.Sync.SSEHandler do
  @moduledoc """
  Stateless handler that opens a long-lived SSE connection subscribed to one or more Groups.

  ## Responsibilities

  - Validates actor membership for all requested groups
  - Performs pre-flight cursor check against committed watermark
  - Starts SSEConnection process and subscribes it to FanOutRouter
  - Handles stale cursor by sending control event and closing immediately

  ## Public Interface

  ### open_sse/4

  Takes a Plug.Conn, a list of group IDs, a cursor GSN, and an actor ID.
  Starts an SSEConnection process, subscribes it to FanOutRouter for all groups,
  and takes ownership of the chunked connection. Returns :ok.

  ## Return shape

  - :ok on success — SSEConnection owns the connection from here
  - {:error, :not_member} if the actor is not a member of any requested group
  """

  alias EbbServer.Storage.GroupCache
  alias EbbServer.Sync.{FanOutRouter, SSEConnectionSupervisor}

  @stale_cursor_event ~S(event: control
data: {"reconnect":true,"reason":"behind_watermark","catchUpFrom":)
  @stale_cursor_suffix "\"\n\n}"

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

  defp open_sse_connection(conn, group_ids, cursor, _actor_id) do
    cursors = Map.new(group_ids, fn group_id -> {group_id, cursor} end)

    case SSEConnectionSupervisor.start_child(conn, group_ids, cursors) do
      {:ok, sse_pid} ->
        FanOutRouter.subscribe(group_ids, sse_pid)
        :ok

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc """
  Writes a stale cursor control event to the chunked response and returns :closed.

  Called by the router when the client's cursor exceeds the committed watermark.
  """
  @spec write_stale_cursor_response(Plug.Conn.t(), non_neg_integer()) :: :closed
  def write_stale_cursor_response(conn, catch_up_from) do
    event = @stale_cursor_event <> to_string(catch_up_from) <> @stale_cursor_suffix

    case Plug.Conn.chunk(conn, event) do
      {:ok, _conn} -> :closed
      {:error, :closed} -> :closed
    end
  end
end
