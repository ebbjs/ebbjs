# Slice 3: Live Sync (Catch-Up + SSE)

## Goal

A client can handshake, catch up on missed Actions for its Groups via paginated HTTP, then open a single SSE connection and receive new Actions in real-time as other clients write them.

## Components Involved

| Component                                                 | Interface Subset Used                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [RocksDB Store](../components/rocksdb-store.md)           | All from Slice 2 + `range_iterator/3` for catch-up and fan-out reads                                                |
| [SQLite Store](../components/sqlite-store.md)             | All from Slice 2                                                                                                    |
| [System Cache](../components/system-cache.md)             | All from Slice 2 + `committed_watermark/0`, `get_group_entities/1`, `mark_range_committed/2`, `advance_watermark/0` |
| [Writer](../components/writer.md)                         | All from Slice 2 + watermark advancement + fan-out notification                                                     |
| [Entity Store](../components/entity-store.md)             | All from Slice 2                                                                                                    |
| [Permission Checker](../components/permission-checker.md) | All from Slice 2                                                                                                    |
| [Fan-Out](../components/fan-out.md)                       | `FanOutRouter.subscribe/2`, `FanOutRouter.unsubscribe/1`, `GroupServer.push_actions/2`, `SSEConnection`             |
| [HTTP API](../components/http-api.md)                     | All from Slice 2 + `GET /sync/groups/:group_id?offset=:gsn`, `GET /sync/live`, `POST /sync/presence`                |

## Flow

### Phase 1: Handshake

1. **Client A sends handshake.** `POST /sync/handshake` with auth headers. Server authenticates, looks up Groups. Returns:
   ```json
   {
     "actor_id": "a_user1",
     "groups": [{ "id": "group_abc", "cursor_valid": true }]
   }
   ```

### Phase 2: Catch-Up

2. **Client A catches up.** `GET /sync/groups/group_abc?offset=0`

3. **Server reads from RocksDB.**
   - Authenticates, verifies Client A is a member of `group_abc`
   - Gets entity IDs for `group_abc` from `RelationshipCache.get_group_entities("group_abc")`
   - For each entity, iterates `cf_entity_actions` where GSN > 0
   - Collects unique Action IDs, fetches full Actions from `cf_actions`
   - Sorts by GSN, takes up to 200
   - Returns JSON array with headers:
     - `Stream-Next-Offset: 3` (if 2 Actions returned)
     - `Stream-Up-To-Date: true` (if fewer than 200)

4. **Client A processes catch-up.** Applies Actions locally, updates cursor to 2.

### Phase 3: Live Subscription

5. **Client A opens SSE.** `GET /sync/live?groups=group_abc&cursors=2`

6. **Server sets up SSE connection.**
   - Creates an `SSEConnection` process for this client
   - Calls `FanOutRouter.subscribe(["group_abc"], connection_pid)`
   - Fan-Out Router starts a `GroupServer` for `group_abc` (if not already running)
   - GroupServer adds the connection to its subscriber set
   - SSE connection enters receive loop, sends keepalive every 15s

### Phase 4: Live Delivery

7. **Client B writes an Action.** `POST /sync/actions` with a PATCH to `todo_xyz` in `group_abc`.

8. **Writer processes and notifies.** Commits to RocksDB, advances watermark, sends `{:batch_committed, 3, 3}` to Fan-Out Router.

9. **Fan-Out Router delivers.**
   - Checks `SystemCache.committed_watermark()` → 3 (watermark is current)
   - Reads Action GSN 3 from `cf_actions`
   - Finds affected entity `todo_xyz`, looks up its Group → `group_abc`
   - Dispatches to `GroupServer` for `group_abc`

10. **GroupServer pushes to subscribers.** Sends the Action to Client A's SSE connection process.

11. **SSE connection writes to stream.**

    ```
    event: data
    data: {"id":"act_xyz","gsn":3,"actor_id":"a_user2","hlc":...,"updates":[...]}

    event: control
    data: {"group":"group_abc","nextOffset":"4"}
    ```

12. **Client A receives and applies.** Updates local state, advances cursor to 3.

### Phase 5: Presence (Optional in this slice)

13. **Client A sends presence.** `POST /sync/presence {"entity_id": "todo_xyz", "data": {"cursor": {"line": 5}}}`

14. **Server broadcasts.** Fan-Out Router looks up `todo_xyz`'s Group → `group_abc`, dispatches to GroupServer, which sends to all subscribers except Client A.

15. **Client B receives presence.**
    ```
    event: presence
    data: {"actor_id":"a_user1","entity_id":"todo_xyz","data":{"cursor":{"line":5}}}
    ```

## Acceptance Criteria

- [ ] Handshake returns the actor's Group list with cursor validity
- [ ] Catch-up returns Actions for a Group filtered by GSN offset
- [ ] Catch-up pagination works: 200 Actions per page, `Stream-Next-Offset` header
- [ ] `Stream-Up-To-Date: true` header is set when client is caught up
- [ ] SSE connection receives new Actions in real-time after catch-up
- [ ] SSE events are in correct format (`event: data\ndata: ...\n\n`)
- [ ] Actions are delivered in GSN order (no gaps, no reordering)
- [ ] SSE keepalive comments are sent every 15 seconds
- [ ] Client disconnect is detected and subscriber is removed
- [ ] Group GenServer stops when last subscriber leaves
- [ ] Presence broadcasts reach other subscribers but not the sender
- [ ] Catch-up only returns Actions for entities in the requested Group (not all Actions)

## Build Order

1. **Implement committed watermark in System Cache.** Add `mark_range_committed/2`, `advance_watermark/0`, `committed_watermark/0`. With a single Writer (this slice), the watermark always equals the max GSN. Write unit tests.

2. **Extend Writer with watermark and fan-out notification.** After each batch commit, call `mark_range_committed` + `advance_watermark`, then `send(FanOutRouter, {:batch_committed, from, to})`.

3. **Build Fan-Out Router.** `EbbServer.Sync.FanOutRouter` GenServer -- handle `{:batch_committed, ...}` messages, check watermark, read Actions from RocksDB, route to Group GenServers. Implement `subscribe/2` and `unsubscribe/1`.

4. **Build Group GenServer.** `EbbServer.Sync.GroupServer` -- maintain subscriber MapSet, handle `push_actions`, monitor subscriber pids, stop when empty. Use `DynamicSupervisor` for lifecycle management.

5. **Build SSE Connection process.** `EbbServer.Sync.SSEConnection` -- receive Actions/control/presence messages, write SSE events to the Cowboy chunked response. Handle keepalive timer. Handle client disconnect.

6. **Build catch-up endpoint.** `GET /sync/groups/:group_id?offset=:gsn` -- authenticate, verify membership, read from RocksDB filtered by Group entities, paginate, set headers.

7. **Build live SSE endpoint.** `GET /sync/live?groups=...&cursors=...` -- authenticate, create SSE connection process, subscribe to Fan-Out, begin streaming.

8. **Build presence endpoint.** `POST /sync/presence` -- authenticate, route through Fan-Out to Group GenServer.

9. **Integration test: catch-up.** Write Actions, then catch up from offset 0. Verify correct Actions returned, pagination works, headers correct.

10. **Integration test: live delivery.** Open SSE, write an Action from another process, verify SSE event received. Test disconnect cleanup.

11. **Integration test: full sync flow.** Handshake → catch-up → SSE → write → receive. The complete client sync lifecycle.
