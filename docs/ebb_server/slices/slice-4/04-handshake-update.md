# Handshake Update

## Build Order Position

**Step 1 of 5** — First to build. Changes the existing `/sync/handshake` endpoint.

## Purpose

Extends the existing handshake to include `cursor_valid` per Group, telling the client whether its cursor position is still valid. This allows the client to detect staleness (e.g., after log compaction) and trigger a resync before opening an SSE subscription.

## Changes to Existing Endpoint

### Request (unchanged)

```json
{
  "cursors": {
    "group_abc": 42,
    "group_xyz": 15
  },
  "schema_version": 1
}
```

### Response (new shape)

Each group entry in the response gains three new fields:

| Field          | Type                    | Description                                                                                   |
| -------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| `cursor_valid` | boolean                 | Whether the client's cursor for this group is usable                                          |
| `reason`       | String \| null          | Reason if `cursor_valid` is false. `"behind_watermark"` for now. `null` if valid.             |
| `cursor`       | non_neg_integer \| null | If invalid, the current watermark (catch up from here). If valid, the cursor the client sent. |

Example response:

```json
{
  "actor_id": "a_user1",
  "groups": [
    {
      "id": "group_abc",
      "permissions": ["read", "write"],
      "cursor_valid": true,
      "reason": null,
      "cursor": 42
    },
    {
      "id": "group_xyz",
      "permissions": ["read"],
      "cursor_valid": false,
      "reason": "behind_watermark",
      "cursor": 100
    }
  ]
}
```

## Algorithm

### cursor_valid computation

For each group in the actor's group list:

1. Look up `client_cursor` from the cursors map (default to `0` if not provided)
2. Get `watermark = WatermarkTracker.committed_watermark()`
3. `cursor_valid = client_cursor <= watermark`

If `cursor_valid` is false, the response includes `reason: "behind_watermark"` and `cursor: current_watermark` so the client knows where to catch up from.

### Compaction stub

There is no compaction implementation yet. The watermark is always the ceiling of valid catch-up. If compaction is added later, `cursor_valid` would additionally require `client_cursor >= compaction_horizon`. For now, it is computed solely against the watermark.

### Error Handling

- If `cursors` is missing or not a map, treat as empty map `{}`
- `schema_version` is accepted but not currently validated
- Groups the actor does not belong to are not included in the response (existing behavior)

## Dependencies

| Dependency         | What it needs         | Reference                                           |
| ------------------ | --------------------- | --------------------------------------------------- |
| `GroupCache`       | get_actor_groups/1    | [group-cache.md](../components/group-cache.md)      |
| `WatermarkTracker` | committed_watermark/0 | [watermark-design.md](../../../watermark-design.md) |

## State

No new state. Changes only the response shape of the existing handshake endpoint in `router.ex`.

## Test Plan

Use `EbbServer.Integration.StorageCase` for test infrastructure.

### HTTP integration tests

**File:** `test/ebb_server/sync/router_test.exs` (handshake section)

- **Valid cursor:** A client whose cursor is at or below the watermark receives `cursor_valid: true` for that group
- **Stale cursor:** A client whose cursor exceeds the watermark receives `cursor_valid: false`, `reason: "behind_watermark"`, and `cursor: current_watermark`
- **Multiple groups with mixed validity:** A client subscribed to multiple groups with different cursor positions receives a validity assessment per group independently
- **Missing cursors map:** When no cursors are provided, default to `0` for all groups — all groups return `cursor_valid: true`

### Test order

1. Modify the handshake handler in Router
2. Run existing tests to confirm no regressions
3. Run full test suite

## Open Questions

- **`schema_version` validation:** Should the server reject handshakes with an unsupported schema version? Not needed yet, but when schema evolution is added, this field should be validated.
