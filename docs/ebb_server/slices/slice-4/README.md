# Slice 4: Sync HTTP Endpoints

## Summary

Slice 3 built the Fan-Out infrastructure (FanOutRouter, GroupServer, SSEConnection) and integrated it with the Writer. Slice 4 adds the HTTP endpoints that give clients access to that infrastructure: catch-up reads, live SSE subscriptions, presence broadcasts, and an updated handshake that validates client cursors.

These endpoints are built on top of the existing sync infrastructure and reuse it directly.

## Prerequisites

- All components from [Slice 3 README](../slice-3/README.md) — FanOutRouter, GroupServer, SSEConnection, WatermarkTracker, Writer integration
- `GroupCache.get_permissions/2` and `get_actor_groups/1`
- `WatermarkTracker.committed_watermark/0`
- `RocksDB.range_iterator/3`, `cf_group_actions/1`, `multi_get/3` (new)
- `cf_group_actions` column family added to RocksDB and populated at write time

## Components

| #   | Component                                               | File                                               | Purpose                                                                             |
| --- | ------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 0   | [Group Actions Index](../prereq-group-actions-index.md) | `RocksDB` + `Writer`                               | Pre-indexed `(group_id, gsn) → action_id` for efficient group-scoped catch-up reads |
| 1   | [Catch-Up Endpoint](01-catch-up-endpoint.md)            | `router.ex` + `lib/ebb_server/sync/catch_up.ex`    | Paginated group-scoped Action reads                                                 |
| 2   | [Live SSE Endpoint](02-live-sse-endpoint.md)            | `router.ex` + `lib/ebb_server/sync/sse_handler.ex` | Long-lived SSE subscription                                                         |
| 3   | [Presence Endpoint](03-presence-endpoint.md)            | `router.ex`                                        | Ephemeral cursor broadcast                                                          |
| 4   | [Handshake Update](04-handshake-update.md)              | `router.ex`                                        | `cursor_valid` per group                                                            |

## Build Order

1. **Handshake update** — Add `cursor_valid` to existing handshake response. No new infrastructure needed.
2. **Group Actions Index** — Add `cf_group_actions` column family to RocksDB and populate at write time in Writer. Prerequisite for catch-up.
3. **Catch-up endpoint** — New `EbbServer.Sync.CatchUp` module, wired to `GET /sync/groups/:group_id`. Uses `cf_group_actions` for O(1) group-scoped reads.
4. **Live SSE endpoint** — New `EbbServer.Sync.SSEHandler` module, wired to `GET /sync/live`. Reuses existing SSEConnection process via subscription.
5. **Presence endpoint** — Small addition to `router.ex`. FanOutRouter.broadcast_presence/3 already exists.

## Dependencies

```
HTTP API (router.ex)
├── AuthPlug (already exists)
├── SSEHandler ──→ SSEConnection (already exists, via start_link)
│              ──→ FanOutRouter.subscribe/2 (already exists)
├── CatchUp ──→ RocksDB (range_iterator, cf_group_actions, multi_get)
│           ──→ WatermarkTracker (committed_watermark)
├── FanOutRouter.broadcast_presence/3 (already exists)
└── GroupCache (get_permissions, get_actor_groups)
```

## Key Design Decisions

### Pre-indexed group-to-actions column family

Catch-Up reads Actions for a Group via a pre-indexed `(group_id, gsn) → action_id` column family maintained at write time. FanOutRouter uses `actions_in_gsn_range/3` from `cf_actions` directly.

The pre-index means catch-up is O(actions_for_group) instead of O(entities × actions_per_entity). One extra RocksDB write per update per group at write time; O(1) range scan per catch-up read.

### Single cursor for SSE subscription

The client sends one cursor value (the minimum GSN across all subscribed groups). On subscription:

- If `cursor > committed_watermark()` → send SSE control event with `reconnect: true, reason: behind_watermark, catchUpFrom: N` and close immediately
- Otherwise, subscribe via FanOutRouter and stream all new Actions with GSN > cursor

### cursor_valid computation

For each group in the handshake, `cursor_valid` is `client_cursor <= WatermarkTracker.committed_watermark()`. If `cursor_valid` is false, the response includes `reason: "behind_watermark"` and `cursor: current_watermark` so the client knows where to catch up from. Compaction horizon is a stub for now — always computed from watermark.

## Supervision Tree

No new supervision structure needed. The HTTP API is already started under the application supervisor. SSEHandler and CatchUp are stateless modules — no supervision needed.

## Acceptance Criteria

- [ ] Handshake returns `cursor_valid: true` for groups where client's cursor is at or below watermark
- [ ] Handshake returns `cursor_valid: false` with `reason` and `cursor` for groups where client's cursor is stale
- [ ] Catch-up returns Actions for a Group filtered by GSN > offset
- [ ] Catch-up pagination works: 200 per page, `Stream-Next-Offset` header set for next page
- [ ] `Stream-Up-To-Date: true` header set when client is caught up (fewer than 200 results)
- [ ] SSE subscription receives live Actions after the client's cursor
- [ ] SSE subscription closes immediately with control message when cursor > watermark
- [ ] Presence broadcasts reach other subscribers but not the sender
- [ ] All endpoints authenticate via AuthPlug and verify group membership
