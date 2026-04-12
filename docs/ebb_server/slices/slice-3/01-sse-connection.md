# SSEConnection

## Build Order Position

**Step 1 of 4** -- Build this first. No dependencies on sync infrastructure. Can be unit tested standalone with a mock `Plug.Conn`.

## Purpose

A process per connected client that receives Actions, control events, and presence messages from GroupServers and writes them to the client in Server-Sent Events (SSE) format over a Cowboy chunked HTTP response.

## Responsibilities

- Own the Cowboy chunked response connection for one client
- Receive `push_action`, `push_control`, and `push_presence` messages from GroupServers
- Write SSE-formatted events to the stream
- Send SSE keepalive comments (`: keepalive\n\n`) every 15 seconds
- Detect client disconnect and clean up

## Public Interface

### Module: `EbbServer.Sync.SSEConnection`

| Name              | Signature                                                               | Description                                                  |
| ----------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| `start_link/1`    | `start_link(conn :: Plug.Conn.t()) :: {:ok, pid()} \| {:error, term()}` | Starts the SSE connection process with an existing Plug.Conn |
| `push_action/2`   | `push_action(pid :: pid(), action :: map()) :: :ok`                     | Sends an Action event to the client                          |
| `push_control/2`  | `push_control(pid :: pid(), control :: map()) :: :ok`                   | Sends a control event (e.g., `nextOffset`)                   |
| `push_presence/2` | `push_presence(pid :: pid(), presence :: map()) :: :ok`                 | Sends a presence event                                       |

### SSE Event Format

```
event: data
data: {"id":"act_abc","gsn":501,"actor_id":"a_user1","hlc":1711036800000,"updates":[...]}

event: control
data: {"group":"group_a","nextOffset":"502"}

event: presence
data: {"actor_id":"a_user1","entity_id":"doc_1","data":{"cursor":{"line":5,"col":12}}}

event: control
data: {"reconnect":true,"reason":"membership_changed"}

: keepalive
```

Events are separated by `\n\n`. Each field line ends with `\n`.

## State

```elixir
@defmodule SSEConnection do
  @type t :: %__MODULE_{
    conn: Plug.Conn.t(),
    group_ids: [String.t()],
    cursors: %{String.t() => non_neg_integer()},
    keepalive_ref: reference() | nil
  }

  defstruct [:conn, :group_ids, :cursors, :keepalive_ref]
end
```

- `conn`: The Plug.Conn chunked response (owned by this process)
- `group_ids`: Groups this connection is subscribed to
- `cursors`: Map of `group_id => last_received_gsn` for offset tracking
- `keepalive_ref`: Timer reference for the 15-second keepalive

## Internal Design

### start_link / init

```elixir
@spec start_link(Plug.Conn.t(), [String.t()], %{String.t() => non_neg_integer()}) ::
  {:ok, pid()} | {:error, term()}
def start_link(conn, group_ids, cursors) do
  GenServer.start_link(__MODULE__, {conn, group_ids, cursors})
end

@impl true
def init({conn, group_ids, cursors}) do
  # Send SSE headers to begin chunked response
  conn = conn
    |> Plug.Conn.put_resp_header("content-type", "text/event-stream")
    |> Plug.Conn.put_resp_header("cache-control", "no-cache")
    |> Plug.Conn.put_resp_header("connection", "keep-alive")
    |> Plug.Conn.send_chunked(200)

  # Start keepalive timer
  keepalive_ref = Process.send_after(self(), :keepalive, 15_000)

  {:ok, %__MODULE__{
    conn: conn,
    group_ids: group_ids,
    cursors: cursors,
    keepalive_ref: keepalive_ref
  }}
end
```

### push_action

```elixir
@impl true
def handle_cast({:push_action, action}, state) do
  event = Jason.encode!(%{
    "id" => action["id"],
    "gsn" => action["gsn"],
    "actor_id" => action["actor_id"],
    "hlc" => action["hlc"],
    "updates" => action["updates"]
  })

  write_event(state.conn, "data", event)
  {:noreply, state}
end
```

### write_event helper

```elixir
defp write_event(conn, event_type, data) do
  chunk = IO.iodata_to_binary([
    "event: ", event_type, "\n",
    "data: ", data, "\n\n"
  ])

  case Plug.Conn.chunk(conn, chunk) do
    :ok -> {:ok, conn}
    {:error, :closed} -> {:error, :closed}
  end
end
```

### keepalive

```elixir
@impl true
def handle_info(:keepalive, state) do
  case Plug.Conn.chunk(state.conn, ": keepalive\n\n") do
    :ok ->
      ref = Process.send_after(self(), :keepalive, 15_000)
      {:noreply, %{state | keepalive_ref: ref}}
    {:error, :closed} ->
      {:stop, :normal, state}
  end
end
```

### Client disconnect

When Cowboy detects the client has disconnected, the socket is closed and `chunk/2` returns `{:error, :closed}`. The process then stops with `:normal` reason.

## Dependencies

| Dependency | What it needs              | Reference |
| ---------- | -------------------------- | --------- |
| Plug       | Chunked response writing   | hex/pm    |
| Jason      | JSON encoding for SSE data | hex/pm    |

## Supervision

Each SSEConnection is started dynamically by the HTTP API when a client opens `GET /sync/live`:

```elixir
# In the HTTP API handler
{:ok, sse_pid} = SSEConnection.start_link(conn, group_ids, cursors)
FanOutRouter.subscribe(group_ids, sse_pid)
```

Under `SSEConnectionSupervisor` (a `simple_one_for_one` supervisor):

```elixir
children = [
  worker(SSEConnection, [], restart: :temporary)
]

Supervisor.start_link(children, strategy: :simple_one_for_one, name: SSEConnectionSupervisor)
```

## Open Questions

- **Encoding**: SSE `data` field must be UTF-8. `Jason.encode!` produces valid UTF-8. Confirm no binary data ever reaches SSEConnection.
- **Backpressure**: If the client reads slowly, Cowboy's chunked response will apply backpressure. The process mailbox grows on the GroupServer side. Consider monitoring mailbox size.
