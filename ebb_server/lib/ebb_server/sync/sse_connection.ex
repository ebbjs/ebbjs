defmodule EbbServer.Sync.SSEConnection do
  @moduledoc """
  GenServer per connected client that streams Actions, control events, and
  presence messages as Server-Sent Events (SSE) over a Cowboy/Bandit chunked
  HTTP response.

  ## Responsibilities

  - Own the chunked response connection for one client
  - Receive `push_action`, `push_control`, and `push_presence` messages
  - Write SSE-formatted events to the stream
  - Send SSE keepalive comments (`: keepalive\\n\\n`) every 15 seconds
  - Detect client disconnect and clean up

  ## SSE Event Format

      event: data
      data: {"id":"act_abc","gsn":501,"actor_id":"a_user1","hlc":1711036800000,"updates":[...]}

      event: control
      data: {"group":"group_a","nextOffset":"502"}

      event: presence
      data: {"actor_id":"a_user1","entity_id":"doc_1","data":{"cursor":{"line":5,"col":12}}}

      event: control
      data: {"reconnect":true,"reason":"membership_changed"}

      : keepalive

  Events are separated by `\\n\\n`. Each field line ends with `\\n`.
  """

  use GenServer

  @type t :: %__MODULE__{
          conn: Plug.Conn.t(),
          group_ids: [String.t()],
          cursors: %{String.t() => non_neg_integer()},
          keepalive_ref: reference() | nil
        }

  defstruct [:conn, :group_ids, :cursors, :keepalive_ref]

  @spec start_link(Plug.Conn.t(), [String.t()], %{String.t() => non_neg_integer()}, keyword()) ::
          {:ok, pid()} | {:error, term()}
  def start_link(conn, group_ids, cursors, opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, {conn, group_ids, cursors}, name: name)
  end

  @spec push_action(pid(), map()) :: :ok
  def push_action(pid, action) do
    GenServer.cast(pid, {:push_action, action})
  end

  @spec push_control(pid(), map()) :: :ok
  def push_control(pid, control) do
    GenServer.cast(pid, {:push_control, control})
  end

  @spec push_presence(pid(), map()) :: :ok
  def push_presence(pid, presence) do
    GenServer.cast(pid, {:push_presence, presence})
  end

  @impl true
  def init({conn, group_ids, cursors}) do
    conn =
      conn
      |> Plug.Conn.put_resp_header("content-type", "text/event-stream")
      |> Plug.Conn.put_resp_header("cache-control", "no-cache")
      |> Plug.Conn.put_resp_header("connection", "keep-alive")
      |> Plug.Conn.send_chunked(200)

    keepalive_ref = Process.send_after(self(), :keepalive, 15_000)

    {:ok,
     %__MODULE__{
       conn: conn,
       group_ids: group_ids,
       cursors: cursors,
       keepalive_ref: keepalive_ref
     }}
  end

  @impl true
  def handle_cast({:push_action, action}, state) do
    event =
      Jason.encode!(%{
        "id" => action["id"],
        "gsn" => action["gsn"],
        "actor_id" => action["actor_id"],
        "hlc" => action["hlc"],
        "updates" => action["updates"]
      })

    chunk_and_stop(state.conn, "data", event, state)
  end

  @impl true
  def handle_cast({:push_control, control}, state) do
    event = Jason.encode!(control)
    chunk_and_stop(state.conn, "control", event, state)
  end

  @impl true
  def handle_cast({:push_presence, presence}, state) do
    event = Jason.encode!(presence)
    chunk_and_stop(state.conn, "presence", event, state)
  end

  @impl true
  def handle_info(:keepalive, state) do
    case Plug.Conn.chunk(state.conn, ": keepalive\n\n") do
      {:ok, _conn} ->
        ref = Process.send_after(self(), :keepalive, 15_000)
        {:noreply, %{state | keepalive_ref: ref}}

      {:error, :closed} ->
        {:stop, :normal, state}
    end
  end

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

  defp chunk_and_stop(conn, event_type, data, state) do
    chunk = format_sse_event(event_type, data)

    case Plug.Conn.chunk(conn, chunk) do
      {:ok, _} -> {:noreply, state}
      {:error, :closed} -> {:stop, :normal, state}
    end
  end
end
