# Slice 6: Peer Replication

## Goal

Two ebb server instances can replicate Actions bidirectionally: each server catches up on the other's Actions via paginated HTTP, switches to a live SSE stream, deduplicates already-seen Actions, and applies new Actions locally -- resulting in both servers converging to the same entity state.

## Components Involved

| Component                                       | Interface Subset Used                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [Replication](../components/replication.md)     | `PeerManager.start_link/1`, catch-up loop, live SSE stream, dedup, trust-and-apply                          |
| [RocksDB Store](../components/rocksdb-store.md) | `get/3` on `cf_action_dedup` (dedup check), `range_iterator/4` on `cf_actions` (serve replication endpoint) |
| [Writer](../components/writer.md)               | `WriterRouter.route_write/1` with `trust: true` (skip permission check for replicated Actions)              |
| [HTTP API](../components/http-api.md)           | `GET /sync/replication?offset=<gsn>[&limit=<n>][&live=sse]` (inbound replication endpoint)                  |
| [System Cache](../components/system-cache.md)   | System entity caches updated by Writer when replicated Actions contain GroupMember/Relationship changes     |
| [Fan-Out](../components/fan-out.md)             | Replicated Actions trigger fan-out to local SSE subscribers                                                 |

## Flow

### Setup

Two servers: **Server A** (localhost:4000) and **Server B** (localhost:4001). Each is configured with the other as a replication peer.

### Phase 1: Initial State

1. **Client writes to Server A.** 10 Actions (GSNs 1-10 on Server A) creating entities in `group_abc`.

2. **Server B has no data.** Server B starts with an empty RocksDB.

### Phase 2: Catch-Up

3. **Server B's PeerManager starts.** Configured with `peer_url: "http://localhost:4000"`. Enters `catch_up` state with cursor 0.

4. **PeerManager fetches page 1.** `GET http://localhost:4000/sync/replication?offset=0&limit=1000`

5. **Server A serves replication endpoint.** Iterates `cf_actions` from GSN 1, returns all 10 Actions. Sets `Stream-Next-Offset: 11`, `Stream-Up-To-Date: true`.

6. **PeerManager processes Actions.**
   - For each Action, checks `cf_action_dedup` → all `:not_found` (new)
   - Strips Server A's GSNs
   - Submits to local Writer with `trust: true` (skip permission check)
   - Writer assigns Server B's GSNs (1-10), commits to RocksDB
   - Writer updates system entity caches (if Actions contain GroupMember/Relationship changes)
   - Writer notifies Fan-Out (local SSE subscribers on Server B receive the Actions)

7. **PeerManager transitions to `live`.** Opens SSE: `GET http://localhost:4000/sync/replication?offset=11&live=sse`

### Phase 3: Live Replication

8. **Client writes to Server A.** New Action (GSN 11 on Server A).

9. **Server A's replication endpoint streams.** SSE event with the new Action.

10. **Server B's PeerManager receives.** Dedup check → new. Submits to local Writer → GSN 11 on Server B. Fan-out to local subscribers.

### Phase 4: Bidirectional

11. **Client writes to Server B.** New Action (GSN 12 on Server B).

12. **Server A's PeerManager catches up.** Fetches from Server B, dedup check, applies locally.

### Phase 5: Deduplication

13. **Action from Server A replicated to Server B, then back to Server A.** Server A's PeerManager receives an Action it originally wrote. Dedup check against `cf_action_dedup` → found (Action ID already exists). Skipped.

### Phase 6: Convergence

14. **Both servers have all Actions.** Entity materialization on both servers produces identical state because:
    - LWW fields: same HLCs → same winner
    - Counter fields: same per-actor counts → same totals
    - CRDT fields: Yjs merge is commutative → same state regardless of merge order

## Acceptance Criteria

- [ ] PeerManager catches up from offset 0 and receives all Actions from the peer
- [ ] Replicated Actions are assigned new local GSNs (peer's GSNs are stripped)
- [ ] Original HLCs are preserved (not reassigned)
- [ ] Duplicate Actions (same Action ID) are detected and skipped
- [ ] Replicated Actions skip permission checks (trust-and-apply)
- [ ] System entity changes in replicated Actions update local ETS caches
- [ ] Replicated Actions trigger local fan-out (SSE subscribers receive them)
- [ ] PeerManager transitions from catch-up to live SSE after catching up
- [ ] PeerManager reconnects with exponential backoff on connection failure
- [ ] Bidirectional replication: both servers converge to the same Action set
- [ ] Entity materialization produces identical state on both servers
- [ ] Replication cursor survives server restart (persisted in SQLite)
- [ ] Replication lag metric is exposed per peer

## Build Order

1. **Add replication endpoint to HTTP API.** `GET /sync/replication?offset=<gsn>&limit=<n>` -- iterate `cf_actions` by GSN range, return JSON array of Actions. Add `&live=sse` variant that streams SSE events. Use peer authentication (shared secret bearer token), not the developer's auth URL.

2. **Extend Writer to support `trust: true`.** Add an option to `WriterRouter.route_write/1` and `Writer.write_actions/2` that skips the Permission Checker. Replicated Actions are pre-validated by the originating server.

3. **Build PeerManager.** `EbbServer.Replication.PeerManager` GenServer:
   - `init`: read persisted cursor from SQLite, enter `catch_up` state
   - `catch_up`: paginated HTTP fetch loop, dedup, apply, advance cursor
   - `live`: SSE client, parse events, dedup, apply
   - `backoff`: exponential backoff on failure, retry

4. **Add replication cursor persistence.** Add `replication_cursors` table to SQLite DDL. PeerManager writes cursor after each successful batch apply.

5. **Build Replication Supervisor.** Start one PeerManager per configured peer URL.

6. **Integration test: one-way replication.** Start Server A with data, start Server B with Server A as peer. Verify Server B catches up and receives live updates.

7. **Integration test: bidirectional replication.** Both servers configured as peers. Write to each, verify both converge.

8. **Integration test: deduplication.** Verify that Actions replicated A→B→A are not re-applied on A.

9. **Integration test: connection failure and recovery.** Kill Server A, verify Server B's PeerManager enters backoff. Restart Server A, verify catch-up resumes.

10. **Integration test: system entity replication.** Create a GroupMember on Server A. Verify it appears in Server B's ETS cache after replication. Verify permission checks on Server B respect the replicated GroupMember.

11. **Convergence test.** Write conflicting LWW updates to the same entity on both servers (different HLCs). Replicate bidirectionally. Materialize on both servers. Verify identical entity state (higher HLC wins on both).
