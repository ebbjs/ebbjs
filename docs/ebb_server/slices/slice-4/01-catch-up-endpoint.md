# Catch-Up Endpoint

## Build Order Position

**Step 3 of 5** — Builds on the Group Actions Index.

## Purpose

Serves paginated Action reads scoped to a single Group, starting from a client-provided GSN offset. The client iterates this endpoint to catch up on missed Actions before opening an SSE subscription.

## Public Interface

### Module: `EbbServer.Sync.CatchUp`

**`catch_up_group/3`**

Takes a group ID, a GSN offset, and a page limit. Returns a tuple of `{actions, meta}` where meta contains pagination state.

**Return shape:**

- `{:ok, [action], %{next_offset: integer | nil, up_to_date: boolean}}` on success
- `{:error, :not_member}` when the actor is not a member of the group

### Router Integration

The `GET /sync/groups/:group_id` route parses the `offset` query parameter, delegates to `CatchUp.catch_up_group/3`, and writes response headers before sending the JSON body. The helper `send_json_actions/3` sets either `Stream-Up-To-Date` or `Stream-Next-Offset` depending on whether the client has caught up.

### Response Headers

| Header               | Value                 | Description                                                     |
| -------------------- | --------------------- | --------------------------------------------------------------- |
| `Stream-Next-Offset` | GSN integer as string | Present when more pages exist — the offset for the next request |
| `Stream-Up-To-Date`  | `"true"`              | Present when the client is caught up (fewer results than limit) |

### Response Body

A JSON array of Action objects, each containing `id`, `actor_id`, `hlc`, `gsn`, and `updates`. Actions are sorted by GSN ascending.

## Algorithm

### Overview

Catch-up reads via a **pre-indexed group-to-actions column family** (`cf_group_actions`) maintained at write time. The index maps `(group_id, gsn) → action_id`, enabling a single RocksDB range scan to return all actions for a group in GSN order regardless of how many entities the group contains.

### Phase 1: Membership check

Verify the requesting actor is a member of the target group using `GroupCache.get_permissions/2`. Reject with `:not_member` if not found.

### Phase 2: Range scan on cf_group_actions

Construct a composite key range `[<<group_id, offset+1>>, <<group_id, watermark+1>>)` and iterate over `cf_group_actions`. Each entry yields a `{gsn, action_id}` pair. Take `limit + 1` entries — the extra entry determines whether pagination is needed.

The composite key sorts lexicographically by group_id first, then by GSN within each group, so a single seek lands at the first action for that group at or after the offset.

### Phase 3: Fetch full action bodies from cf_actions

Use the GSN range from Phase 2 to iterate `cf_actions` directly — the first and last GSN from the collected pairs define a half-open range `[first_gsn, last_gsn + 1)`. Stream over that range, filter to only the action_ids collected in Phase 2, and deserialize. The GSN is re-attached to each action from the iterator key.

### Phase 4: Pagination metadata

If fewer than `limit + 1` entries were returned by the iterator, the client is caught up — set `up_to_date: true`. Otherwise, extract the last GSN from the result set and set `next_offset` to `last_gsn + 1`.

## State

Stateless. No GenServer, no supervision tree entry. All reads go directly to RocksDB.

## Test Plan

Use `EbbServer.Integration.StorageCase` for test infrastructure and `ActionHelpers` for test action creation. The `post_actions/2` and `write_entity_in_group/5` helpers are directly reusable.

### Unit tests for `CatchUp`

**File:** `test/ebb_server/sync/catch_up_test.exs`

Test the following cases by calling `CatchUp.catch_up_group/3` directly:

- **Happy path:** After bootstrapping a group and writing entities, catch-up from offset 0 returns those actions sorted by GSN, with `up_to_date: true`
- **Offset filtering:** Catch-up from an offset greater than 0 returns only actions with GSN greater than that offset
- **Pagination detection:** Writing more than 200 actions triggers pagination — the first call returns 200 actions with a `next_offset`, and the second call with that offset returns the remainder with `up_to_date: true`
- **Empty group:** A group with no recorded actions returns an empty list with `up_to_date: true`
- **Non-member rejection:** Calling catch-up for a group the actor does not belong to returns `{:error, :not_member}`

### HTTP integration tests

**File:** `test/ebb_server/sync/router_test.exs` (or new file)

Test the wired endpoint by calling `Router.call/2` with a test conn:

- **200 with headers:** A valid request returns status 200, no `Stream-Next-Offset` header, and `Stream-Up-To-Date: true`
- **Pagination headers:** When more than 200 actions exist, the first response has `Stream-Up-To-Date` absent and `Stream-Next-Offset` set to the next GSN; the second page response has `Stream-Up-To-Date: true`
- **403 for non-member:** A request from an actor not in the group returns 403

### Test order

1. Add `cf_group_actions` to RocksDB and populate it from Writer. Existing tests still pass — no behavior change yet.
2. Build and unit-test `CatchUp` against a fresh isolated storage instance.
3. Wire into Router. Run HTTP integration tests.
4. Run the full existing test suite to confirm no regressions.

## Dependencies

| Dependency          | What it needs                                            | Reference                                                    |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| `GroupCache`        | `get_permissions/2` for membership check                 | [group-cache.md](../components/group-cache.md)               |
| `RocksDB`           | `range_iterator/3`, `cf_group_actions/1`, `cf_actions/1` | [rocksdb-store.md](../components/rocksdb-store.md)           |
| `RelationshipCache` | `get_entity_group/2` at write time only                  | [relationship-cache.md](../components/relationship-cache.md) |
| `WatermarkTracker`  | `committed_watermark/0` for the to_key bound             | [watermark-design.md](../../../watermark-design.md)          |

## Open Questions

None. The pre-indexed column family resolves both the large-group scanning problem and the N-get-per-action problem.
