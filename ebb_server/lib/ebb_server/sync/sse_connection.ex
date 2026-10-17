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
     `GroupServer` already encoded once for the whole group.
  3. The request process writes the chunks (it's the conn owner).
  4. When the request process exits (e.g., on client disconnect), this
     GenServer monitors it and shuts down too, triggering FanOutRouter
     unsubscribe and DynamicSupervisor cleanup.

  ## Restart strategy

  `restart: :temporary` so the DynamicSupervisor never auto-restarts a
  connection that died — the HTTP request is already gone.
  """

  use GenServer, restart: :temporary

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

  @spec push_action(pid(), map()) :: :ok
  def push_action(pid, action), do: push_data(pid, data_frame(action))

  # The payload is identical for every subscriber of a group, so the caller
  # encodes it once and shares the binary; BEAM reference-counted binaries
  # are not copied between processes on send.
  @spec push_data(pid(), iodata()) :: :ok
  def push_data(pid, bytes), do: GenServer.cast(pid, {:push_data, bytes})

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
  def handle_cast({:push_action, action}, state) do
    send(state.parent_pid, {:sse_data, data_frame(action)})
    {:noreply, state}
  end

  def handle_cast({:push_data, bytes}, state) do
    send(state.parent_pid, {:sse_data, bytes})
    {:noreply, state}
  end

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

  The frame is byte-identical to what `format_sse_event("data", encoded)`
  produced before fan-out coalesced: the same 5-key projection encoded with
  `Jason.encode!/1`. GroupServer concatenates these frames into one binary
  and shares it with every subscriber, so the bytes on the wire are the
  concatenation of the frames the per-Action path used to emit.
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
