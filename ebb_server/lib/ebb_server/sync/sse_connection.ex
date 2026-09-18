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
     `SSEConnectionSupervisor`). It receives `push_action` /
     `push_control` / `push_presence` messages from the `FanOutRouter`,
     formats them as SSE, and forwards each chunk to the request process
     via a plain `send/2`.
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
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, {parent_pid, group_ids, cursors}, name: name)
  end

  @spec push_action(pid(), map()) :: :ok
  def push_action(pid, action), do: GenServer.cast(pid, {:push_action, action})

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
    payload =
      Jason.encode!(%{
        "id" => action["id"],
        "gsn" => action["gsn"],
        "actor_id" => action["actor_id"],
        "hlc" => action["hlc"],
        "updates" => action["updates"]
      })

    send(state.parent_pid, {:sse_chunk, "data", payload})
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
end