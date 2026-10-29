defmodule EbbServer.Sync.SSEConnection do
  @moduledoc """
  GenServer per connected client that forwards server-emitted events to the
  Bandit request process that owns the chunked HTTP connection.

  ## Why a separate GenServer?

  Bandit only allows the request process (the one currently executing the
  plug handler) to call `Plug.Conn.chunk/2` on a chunked response. As soon as
  the plug handler returns, Bandit commits the response (sends an empty
  chunk terminator) and the connection closes.

  We solve this by:

  1. `SSEHandler.open_sse/4` runs in the request process. It calls
     `send_chunked/2` and then blocks in a receive loop, keeping Bandit's
     pipeline blocked.
  2. This module is a separate GenServer (started under
     `SSEConnectionSupervisor`). It receives `push_data` /
     `push_control` / `push_presence` messages from the `FanOutRouter`,
     formats control/presence as SSE, and forwards each chunk to the request
     process via a plain `send/2`. `push_data` carries a frame the
     `GroupServer` already encoded once for the whole group; a sampled
     delivery also carries the hop meta.
  3. The request process writes the chunks (it's the conn owner).
  4. When the request process exits (e.g., on client disconnect), this
     GenServer monitors it and shuts down too, triggering FanOutRouter
     unsubscribe and DynamicSupervisor cleanup.

  ## Restart strategy

  `restart: :temporary` so the DynamicSupervisor never auto-restarts a
  connection that died — the HTTP request is already gone.
  """

  use GenServer, restart: :temporary

  alias EbbServer.Telemetry

  @type t :: %__MODULE__{
          parent_pid: pid(),
          group_ids: [String.t()],
          cursors: %{String.t() => non_neg_integer()},
          parent_monitor: reference() | nil
        }

  defstruct [:parent_pid, :group_ids, :cursors, :parent_monitor]

  @spec start_link(pid(), [String.t()], %{String.t() => non_neg_integer()}, keyword()) ::
          {:ok, pid()} | {:error, term()}
  def start_link(parent_pid, group_ids, cursors, opts \\ []) do
    # No global name registration: connections are referenced only by pid.
    # Registering the module name caused every SSE attempt after the first
    # to fail with :already_started, which silently turned the stream into
    # a no-op (HTTP 200 + headers went out, then no chunks ever followed).
    # Locked by the two-tab Playwright test, which opens two simultaneous
    # SSE subscribers and asserts the second one both reaches "live" and
    # receives the first tab's edits (see ebbjs/ebbjs#86).
    _ = opts
    GenServer.start_link(__MODULE__, {parent_pid, group_ids, cursors})
  end

  # The payload is identical for every subscriber of a group, so the caller
  # encodes it once and shares the binary. A frame is typically large enough
  # to be a reference-counted binary, so the runtime shares it by reference
  # across processes rather than copying it per subscriber.
  @spec push_data(pid(), iodata()) :: :ok
  def push_data(pid, bytes), do: GenServer.cast(pid, {:push_data, bytes})

  # The sampled path only: the cast carries the GroupServer's send timestamp,
  # the range's commit time, and the group id so this process can close
  # `conn_deliver` and the request process can close `conn_chunk`.
  @spec push_data(pid(), iodata(), map()) :: :ok
  def push_data(pid, bytes, meta), do: GenServer.cast(pid, {:push_data, bytes, meta})

  @spec push_control(pid(), map()) :: :ok
  def push_control(pid, control), do: GenServer.cast(pid, {:push_control, control})

  @spec push_presence(pid(), map()) :: :ok
  def push_presence(pid, presence), do: GenServer.cast(pid, {:push_presence, presence})

  @impl true
  def init({parent_pid, group_ids, cursors}) do
    # Monitor the request process so we exit when the HTTP connection is
    # gone. This is how the FanOutRouter / GroupServers learn the
    # subscription ended: they see our DOWN message.
    ref = Process.monitor(parent_pid)

    {:ok,
     %__MODULE__{
       parent_pid: parent_pid,
       group_ids: group_ids,
       cursors: cursors,
       parent_monitor: ref
     }}
  end

  @impl true
  def handle_cast({:push_data, bytes}, state), do: deliver_data(bytes, nil, state)
  def handle_cast({:push_data, bytes, meta}, state), do: deliver_data(bytes, meta, state)

  def handle_cast({:push_control, control}, state) do
    payload = Jason.encode!(control)
    send(state.parent_pid, {:sse_chunk, "control", payload})
    {:noreply, state}
  end

  def handle_cast({:push_presence, presence}, state) do
    payload = Jason.encode!(presence)
    send(state.parent_pid, {:sse_chunk, "presence", payload})
    {:noreply, state}
  end

  defp deliver_data(bytes, meta, state) do
    send(state.parent_pid, data_message(bytes, meta))

    # The delivery reaches the request process here; the chunk write that
    # ends the chain is `conn_chunk`, emitted by the SSE handler.
    if is_map(meta) do
      Telemetry.fanout_hop(
        :conn_deliver,
        span(Map.get(meta, :cast_at), System.monotonic_time()),
        Map.get(meta, :group_id)
      )
    end

    {:noreply, state}
  end

  # A sampled delivery carries the meta through to the request process, which
  # needs the commit time to close `conn_chunk`.
  defp data_message(bytes, meta) when is_map(meta), do: {:sse_data, bytes, meta}
  defp data_message(bytes, _meta), do: {:sse_data, bytes}

  defp span(from, to) when is_integer(from) and is_integer(to), do: max(to - from, 0)
  defp span(_from, _to), do: nil

  @impl true
  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) when pid == state.parent_pid do
    # Request process died → chunked conn is gone. Exit so the supervisor
    # removes us and the GroupServer's monitor fires unsubscribe.
    {:stop, :normal, state}
  end

  @doc """
  Formats a single SSE event block as a binary: `event: <type>\ndata: <payload>\n\n`.
  """
  @spec format_sse_event(String.t(), String.t()) :: String.t()
  def format_sse_event(event_type, data) do
    IO.iodata_to_binary([
      "event: ",
      event_type,
      "\n",
      "data: ",
      data,
      "\n\n"
    ])
  end

  @doc """
  Formats an Action as its wire `data` event frame.

  Projects the Action to the five keys a subscriber consumes (`id`, `gsn`,
  `actor_id`, `hlc`, `updates`) and encodes them with `Jason.encode!/1`.
  `FanOutRouter.Frames` calls this once per (Action, distinct Update
  subset) for a released range; `GroupServer` only concatenates the
  resulting frames, so the stream is the concatenation of per-Action `data`
  frames.
  """
  @spec data_frame(map()) :: binary()
  def data_frame(action), do: format_sse_event("data", encode_action(action))

  defp encode_action(action) do
    Jason.encode!(%{
      "id" => action["id"],
      "gsn" => action["gsn"],
      "actor_id" => action["actor_id"],
      "hlc" => action["hlc"],
      "updates" => action["updates"]
    })
  end
end
