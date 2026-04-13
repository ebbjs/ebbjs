# Presence Endpoint

## Build Order Position

**Step 5 of 5** — Last to build. All infrastructure already exists in FanOutRouter.

## Purpose

Allows a client to broadcast ephemeral presence data (e.g., cursor position, selection state) for an entity. The server routes this to all other clients subscribed to the entity's Group via the fan-out pipeline.

## Public Interface

### Endpoint: `POST /sync/presence`

The route reads the JSON body, extracts `entity_id` and `data`, verifies the actor is a member of the entity's group, and routes the presence through FanOutRouter.

### Request Body

```json
{
  "entity_id": "todo_xyz",
  "data": {
    "cursor": { "line": 5, "col": 12 },
    "selection": { "start": 10, "end": 20 }
  }
}
```

`data` is an arbitrary JSON object. The server does not interpret it — it is forwarded as-is to other subscribers.

### Response

| Status | Description |
|--------|-------------|
| 204 No Content | Presence broadcast succeeded |
| 403 Forbidden | Actor is not a member of the entity's Group |
| 404 Not Found | Entity does not belong to any Group |
| 422 Unprocessable Entity | Missing entity_id or invalid JSON |

## Algorithm

### presence_broadcast/3

Resolve the entity to its Group via `RelationshipCache.get_entity_group/1`. Verify the actor is a member of that Group via `GroupCache.get_permissions/2`. If both pass, call `FanOutRouter.broadcast_presence/3`.

The routing path through FanOutRouter → GroupServer → SSEConnection already exists and filters out the originating actor automatically.

## Delivery Guarantees

Presence is **ephemeral and best-effort**:

- No persistence — if no subscribers are connected, the presence is silently dropped
- No acknowledgment to the sender
- Not replayed on reconnect

This is intentionally lossy. Presence is for live collaboration signals (cursor movement, selection) where stale data has no value. If the client needs replay, they use the catch-up mechanism for Actions.

## SSE Event Format

Subscribers receive:

```
event: presence
data: {"actor_id":"a_user1","entity_id":"todo_xyz","data":{"cursor":{"line":5,"col":12}}}
```

The `entity_id` in the presence event refers to the entity the presence is about, not the Group. Clients use this to attribute the presence to a specific entity in their local state.

## State

Stateless. No process state.

## Dependencies

| Dependency | What it needs | Reference |
|------------|---------------|-----------|
| `RelationshipCache` | get_entity_group/1 | [relationship-cache.md](../components/relationship-cache.md) |
| `GroupCache` | get_permissions/2 for membership check | [group-cache.md](../components/group-cache.md) |
| `FanOutRouter` | broadcast_presence/3 | [fan-out-router.md](../slice-3/03-fan-out-router.md) |

## Test Plan

Use `EbbServer.Integration.StorageCase` for test infrastructure.

### HTTP integration tests

**File:** `test/ebb_server/sync/router_test.exs` (presence section)

- **204 on success:** A valid presence broadcast for an entity in a subscribed group returns 204
- **404 for unknown entity:** Broadcasting presence for an entity that belongs to no group returns 404
- **403 for non-member:** Broadcasting presence for an entity in a group the actor does not belong to returns 403
- **Presence received by other subscribers:** When one client broadcasts presence and another has an open SSE connection subscribed to the same group, the second client receives a `event: presence` SSE message

### Test order

1. Add route to Router and run existing tests to confirm no regressions
2. Run full test suite

## Open Questions

None identified. The routing path is fully specified by existing components.