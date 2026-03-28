# HTTP API

## Purpose

The Plug/Cowboy HTTP router that exposes all client-facing and internal endpoints. This is the entry point for every external interaction with the server: Action writes, entity reads (for Bun server functions), sync handshake, paginated catch-up, live SSE subscriptions, presence broadcasting, server function invocation, and peer replication.

## Responsibilities

- Route HTTP requests to the appropriate handler
- Decode MessagePack request bodies (Action writes) and JSON request bodies (entity queries, function invocation)
- Authenticate requests by forwarding to the developer's auth URL
- Delegate to Permission Checker, Writer, Entity Store, Fan-Out, and Replication as appropriate
- Encode responses (JSON for entity reads, MessagePack for sync catch-up)
- Manage SSE connections (long-lived, chunked transfer encoding)
- Return structured error responses with appropriate HTTP status codes

## Public Interface

### Module: `EbbServer.Sync.Router`

A `Plug.Router` that defines all HTTP endpoints.

### Endpoints

#### Sync Protocol

| Method | Path                     | Request                                                              | Response                                                                   | Description                                         |
| ------ | ------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| `POST` | `/sync/handshake`        | Headers: auth token. Body: `{"cursors": {...}, "schema_version": N}` | `{"actor_id": "...", "groups": [...]}`                                     | Authenticate, validate cursors, return Group list   |
| `POST` | `/sync/actions`          | Body: MessagePack `{"actions": [...]}`                               | `{"rejected": [...]}` (200) or `{"error": "unauthorized"}` (401)           | Write Actions. Blocks until durable.                |
| `GET`  | `/sync/groups/:group_id` | Query: `offset=<gsn>`                                                | JSON array of Actions + `Stream-Next-Offset` / `Stream-Up-To-Date` headers | Paginated catch-up (200 Actions/page, CDN-friendly) |
| `GET`  | `/sync/live`             | Query: `groups=A,B,C&cursors=500,200,800`                            | SSE stream (`event: data`, `event: control`, `event: presence`)            | Single SSE connection for live updates              |
| `POST` | `/sync/presence`         | Body: `{"entity_id": "...", "data": {...}}`                          | 204 No Content                                                             | Ephemeral presence broadcast                        |

#### Entity Reads (for Bun Application Server)

| Method | Path              | Request                                                     | Response               | Description                                      |
| ------ | ----------------- | ----------------------------------------------------------- | ---------------------- | ------------------------------------------------ |
| `GET`  | `/entities/:id`   | Query: `actor_id=<id>`                                      | JSON entity or 404     | Point entity read with on-demand materialization |
| `POST` | `/entities/query` | Body: `{"type": "...", "filter": {...}, "actor_id": "..."}` | JSON array of entities | Type-scoped filtered query                       |
| `POST` | `/entities/batch` | Body: `{"ids": [...], "actor_id": "..."}`                   | JSON array of entities | Batch point lookup                               |

#### Server Functions

| Method | Path               | Request                     | Response                        | Description              |
| ------ | ------------------ | --------------------------- | ------------------------------- | ------------------------ |
| `POST` | `/functions/:name` | Body: function input (JSON) | Function output (JSON) or error | Invoke a server function |

#### Replication

| Method | Path                | Request                                    | Response                            | Description                                   |
| ------ | ------------------- | ------------------------------------------ | ----------------------------------- | --------------------------------------------- |
| `GET`  | `/sync/replication` | Query: `offset=<gsn>&limit=<n>[&live=sse]` | JSON array of Actions or SSE stream | Unfiltered Action stream for peer replication |

### Response Types

```elixir
# Handshake response
@type handshake_response :: %{
  actor_id: String.t(),
  groups: [%{
    id: String.t(),
    cursor_valid: boolean(),
    reason: String.t() | nil,    # "below_low_water_mark" if cursor_valid is false
    cursor: non_neg_integer() | nil
  }]
}

# Action write response
@type write_response :: %{
  rejected: [%{
    action_id: String.t(),
    reason: String.t(),
    details: String.t() | nil
  }]
}

# Entity response (JSON)
@type entity_response :: %{
  id: String.t(),
  type: String.t(),
  data: map(),
  created_hlc: non_neg_integer(),
  updated_hlc: non_neg_integer(),
  deleted_hlc: non_neg_integer() | nil
}

# SSE events
# event: data\ndata: <Action JSON>\n\n
# event: control\ndata: {"group":"A","nextOffset":"501"}\n\n
# event: presence\ndata: {"actor_id":"...","entity_id":"...","data":{...}}\n\n
# event: control\ndata: {"reconnect":true,"reason":"membership_changed"}\n\n
```

## Dependencies

| Dependency         | What it needs                                                  | Reference                                                     |
| ------------------ | -------------------------------------------------------------- | ------------------------------------------------------------- |
| Permission Checker | `validate_and_authorize/2` for Action writes                   | [permission-checker.md](permission-checker.md#validation-api) |
| Writer             | `WriterRouter.route_write/1` for Action writes                 | [writer.md](writer.md#module-ebbserverstoragwriterrouter)     |
| Entity Store       | `get/2`, `query/3`, `get_batch/2` for entity reads             | [entity-store.md](entity-store.md#read-api)                   |
| Fan-Out            | SSE connection registration, presence broadcast                | [fan-out.md](fan-out.md)                                      |
| System Cache       | `get_actor_groups/1` for handshake Group list                  | [system-cache.md](system-cache.md#group-members)              |
| System Cache       | `committed_watermark/0` for catch-up upper bound               | [system-cache.md](system-cache.md#committed-watermark)        |
| RocksDB Store      | Iterators for catch-up reads (GSN range scan, entity-filtered) | [rocksdb-store.md](rocksdb-store.md#read-operations)          |

## Internal Design Notes

**Authentication middleware:** A Plug that runs before all endpoints (except `/sync/replication` which uses a separate peer auth mechanism). Extracts the auth token from request headers and calls the developer's auth URL:

```elixir
defmodule EbbServer.Sync.AuthPlug do
  def call(conn, _opts) do
    case forward_auth(conn) do
      {:ok, actor_id} -> assign(conn, :actor_id, actor_id)
      {:error, _} -> conn |> send_resp(401, ~s({"error":"unauthorized"})) |> halt()
    end
  end

  defp forward_auth(conn) do
    # POST to configured auth_url with the client's auth headers
    # Expect {"actor_id": "..."} on 200, reject on 401
  end
end
```

**Action write handler flow:**

```
POST /sync/actions
  1. AuthPlug: authenticate → actor_id
  2. Decode MessagePack body → raw_actions
  3. PermissionChecker.validate_and_authorize(raw_actions, actor_id)
     → {accepted, rejected}
  4. If accepted is non-empty:
     WriterRouter.route_write(accepted)
     → blocks until durable
  5. Respond 200 with {"rejected": rejected}
```

**Catch-up handler flow:**

```
GET /sync/groups/:group_id?offset=:gsn
  1. AuthPlug: authenticate → actor_id
  2. Verify actor is a member of group_id (SystemCache.is_member?)
  3. Read entity IDs for this Group (SystemCache.get_group_entities)
  4. For each entity, iterate cf_entity_actions where GSN > offset
  5. Collect unique Action IDs, fetch from cf_actions
  6. Sort by GSN, take up to 200
  7. Set response headers:
     - Stream-Next-Offset: last_gsn + 1
     - Stream-Up-To-Date: true (if < 200 results)
     - Cache-Control: public, max-age=60
     - ETag: group_id:start_gsn:end_gsn
  8. Respond with JSON array of Actions
```

**SSE connection handler:** Uses Cowboy's chunked response API. The handler process:

1. Authenticates and validates Group subscriptions
2. Registers with the Fan-Out Router (which registers with Group GenServers)
3. Enters a receive loop, forwarding messages to the SSE stream
4. Handles `:action`, `:control`, `:presence` messages
5. Sends periodic `:keepalive` comments (every 15s) to prevent proxy timeouts
6. Detects client disconnect and unregisters from Fan-Out

**MessagePack decode for writes:** Use `Msgpax.unpack!/2` on the raw request body. The decoded result has string keys (not atoms). The Permission Checker handles the string-key → atom-key conversion during validation.

**JSON encode for reads:** Use `Jason.encode!/1` for entity responses. The entity `data` field is already a JSON string in SQLite, so it can be embedded directly without re-encoding.

**Function invocation handler:**

```
POST /functions/:name
  1. AuthPlug: authenticate → actor_id
  2. Look up active function version (SQLite.get_active_function)
  3. Forward to Bun Application Server:
     POST http://localhost:3001/invoke
     Body: {"function": name, "version": version, "input": ..., "actor_id": actor_id}
  4. Bun executes the function, making ctx.get/query/create calls back to Elixir
  5. Return Bun's response to the client
```

## Open Questions

- **Cowboy vs. Bandit:** The spec uses `plug_cowboy`. Bandit is a newer, pure-Elixir HTTP server with better SSE support. Either works; Cowboy is more battle-tested. Start with Cowboy per the spec.
- **Catch-up CDN caching:** The spec mentions CDN-friendly catch-up with `Cache-Control` and `ETag` headers. For single-node deployment, this is unnecessary overhead. Implement the headers but don't require a CDN in front.
- **MessagePack vs. JSON for catch-up responses:** The spec says clients send MessagePack but doesn't specify the catch-up response format. JSON is simpler for debugging. MessagePack is more compact. Start with JSON; add MessagePack as an `Accept` header option if bandwidth becomes a concern.
- **Request body size limits:** The spec doesn't mention limits. A single `POST /sync/actions` request could contain thousands of Actions. Add a configurable body size limit (e.g., 10MB default) to prevent OOM.
