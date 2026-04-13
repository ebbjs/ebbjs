# Live SSE Endpoint

## Build Order Position

**Step 4 of 5** — Depends on SSEConnection and FanOutRouter.subscribe from Slice 3.

## Purpose

Opens a long-lived SSE connection subscribed to one or more Groups. The client provides a single cursor (minimum GSN across all subscribed groups), and the server streams all new Actions with GSN greater than that cursor via the fan-out pipeline. If the cursor is stale (ahead of the watermark), the server sends a control event and closes immediately.

## Public Interface

### Module: `EbbServer.Sync.SSEHandler`

**`open_sse/4`**

Takes a Plug.Conn, a list of group IDs, a cursor GSN, and an actor ID. Starts an SSEConnection process, subscribes it to FanOutRouter for all groups, and takes ownership of the chunked connection. Returns `:ok`.

**Return shape:**
- `:ok` on success — SSEConnection owns the connection from here
- `{:error, :not_member}` if the actor is not a member of any requested group

### Router Integration

The `GET /sync/live` route parses `groups` (comma-separated) and `cursor` query parameters. It validates that the actor is a member of all requested groups, then either:

- **Stale cursor:** If `cursor > committed_watermark()`, sends a SSE control event with `reconnect: true, reason: behind_watermark, catchUpFrom: N` directly on the chunked response, then closes
- **Fresh cursor:** Delegates to `SSEHandler.open_sse/4` and returns `{:stop, :normal}` to transfer ownership to the SSEConnection process

The router must stop (not send its own response) after calling `SSEHandler.open_sse/4` so the SSEConnection process owns the chunked connection lifecycle.

### SSE Event Format

The SSEConnection process (from Slice 3) formats all events. Subscribers receive:

- **`event: data`** — Action JSON: `{"id", "gsn", "actor_id", "hlc", "updates"}`
- **`event: control`** — Group offset updates: `{"group", "nextOffset"}` or reconnect signal
- **`event: presence`** — Presence data: `{"actor_id", "entity_id", "data": {...}}`
- **`: keepalive`** — Comment sent every 15 seconds to prevent proxy timeouts

### Stale Cursor Response Format

When the cursor is behind the watermark, a single SSE event is sent before closing:

```
event: control
data: {"reconnect":true,"reason":"behind_watermark","catchUpFrom":42}
```

## Algorithm

### open_sse/4

The handler starts an SSEConnection process (which calls `send_chunked(200)` in its init to take ownership of the response) and immediately calls `FanOutRouter.subscribe(group_ids, sse_pid)`. FanOutRouter starts a GroupServer for each group (if not already running) and registers the SSEConnection as a subscriber.

### Pre-flight cursor check

Before starting SSEConnection, compare the client's cursor against `WatermarkTracker.committed_watermark()`. If the cursor exceeds the watermark, the client is too far behind — send a control event and close immediately rather than opening the SSE stream.

## Connection Lifecycle

1. **Router match** — Validates groups, checks cursor against watermark, calls SSEHandler
2. **SSEConnection init** — Sends SSE headers, starts 15s keepalive timer
3. **Subscription** — FanOutRouter.subscribe registers the SSEConnection process with GroupServer for each group
4. **Receive loop** — SSEConnection receives push_action, push_control, push_presence from GroupServer and writes SSE chunks
5. **Disconnect** — When the client disconnects, `chunk/2` returns `{:error, :closed}`, SSEConnection stops normally
6. **Cleanup** — FanOutRouter.unsubscribe removes the SSEConnection from all GroupServers; GroupServers self-terminate when their subscriber set is empty

SSEConnection is started with `restart: :temporary` under SSEConnectionSupervisor (simple_one_for_one). It self-terminates on disconnect.

## State

Stateless handler module. No persistent state. The SSEConnection process owns the connection state.

## Dependencies

| Dependency | What it needs | Reference |
|------------|---------------|-----------|
| `SSEConnection` | start_link/4, push_control/2 | [sse-connection.md](../slice-3/01-sse-connection.md) |
| `FanOutRouter` | subscribe/2 | [fan-out-router.md](../slice-3/03-fan-out-router.md) |
| `WatermarkTracker` | committed_watermark/0 | [watermark-design.md](../../../watermark-design.md) |
| `GroupCache` | get_permissions/2 for membership check | [group-cache.md](../components/group-cache.md) |

## Test Plan

Use `EbbServer.Integration.StorageCase` for test infrastructure.

### Unit / integration tests

**File:** `test/ebb_server/sync/sse_handler_test.exs` (new file)

- **SSE opens and subscribes:** With a valid group and cursor at or below watermark, the SSE connection starts and is registered with FanOutRouter for the given groups
- **Stale cursor sends control event:** When cursor exceeds the watermark, a control event with reconnect=true is written to the response and the stream closes
- **Non-member rejected:** A request for a group the actor does not belong to returns 403
- **Multiple groups:** Subscribing to multiple groups delivers Actions to all of them
- **Disconnect cleanup:** After a client disconnects, the SSEConnection process is removed from all GroupServer subscriber sets

### Test order

1. Build SSEHandler and wire the route in Router
2. Run SSEHandler tests
3. Run full existing test suite

## Open Questions

- **Cleanup on unexpected SSEConnection death:** If SSEConnection crashes before calling FanOutRouter.unsubscribe, GroupServers clean up via {:DOWN, ...} monitoring. Confirm this handles all crash reasons.
- **Multiple cursor values:** The original spec described per-group cursors. The simplified design uses a single cursor. If per-group cursors are needed later, SSEHandler would track them per-group and send a control event per group when one goes stale.