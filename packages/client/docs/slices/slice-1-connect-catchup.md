# Slice: Establish Connection + Catchup

## Goal

The client connects to a running ebb_server (bypass auth), performs catch-up on a single seeded group, and verifies the entity in its local entity store has the correct materialized state after all actions are applied.

## Components Involved

| Component                                       | Interface subset used                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| [SyncWorker](components/sync-worker.md)         | `connect()`                                                                  |
| [SyncConnection](components/sync-connection.md) | `handshake()`, `catchUpGroup()`                                              |
| [StorageAdapter](components/storage-adapter.md) | `actions.append()`, `dirtyTracker.mark()`, `entities.get()`, `cursors.set()` |
| [EntityCache](components/entity-cache.md)       | `getOrFetch()`, `set()`                                                      |

## Flow

### Setup

```
Server seeded with:
  - group: "grp_001"
  - groupMember: actor is member of grp_001
  - entity: "ent_001" (type: "todo") with several patch updates
```

### Step 1: Handshake

```
client calls connection.handshake({})
server responds with:
  {
    actor_id: "actor_test",
    groups: [{
      id: "grp_001",
      permissions: ["read", "write"],
      cursor_valid: true,
      cursor: 0
    }]
  }
```

### Step 2: Catch-up (pagination loop)

```
cursor = 0

loop:
  response = connection.catchUpGroup("grp_001", cursor)
  // response.actions = [action_1, action_2, ...]
  // response.nextOffset = GSN of last action (or null)
  // response.upToDate = true|false

  for each action in response.actions:
    await storage.actions.append(action)
    for each update in action.updates:
      await storage.dirtyTracker.mark(update.subject_id, update.subject_type)

  if response.nextOffset !== null:
    cursor = response.nextOffset
    continue loop

  if response.upToDate === true:
    break loop
```

### Step 3: Verify Materialization via EntityCache

```
entity = await entityCache.getOrFetch("ent_001")

assert entity !== null
assert entity.type === "todo"
assert entity.data.fields contains expected fields from patch updates
assert entity.deleted_hlc === null
```

## Acceptance Criteria

- [ ] Client sends `x-ebb-actor-id: actor_test` header on all requests
- [ ] Handshake returns at least one group (`grp_001`) with `cursor_valid: true`
- [ ] Catch-up loop processes all actions (pagination works: multiple requests until `upToDate: true`)
- [ ] After catchup, `storage.actions.getAll().length > 0`
- [ ] `entityCache.getOrFetch("ent_001")` returns a materialized entity (not null)
- [ ] The materialized entity has the correct `type` and field values from all patches
- [ ] `deleted_hlc` is `null` (entity was not deleted)
- [ ] Second call to `entityCache.get("ent_001")` returns the same entity synchronously (cache hit)
- [ ] No unhandled exceptions during the full flow

## Build Order

1. **`@ebbjs/server`** — server harness + seed client (see [packages/server/docs](../server/docs/README.md))
   - `startServer()` spawns the `ebb_server` process
   - `seed()` writes seed data via HTTP (single action with multiple updates)
2. **`createSyncConnection`** — `createSyncConnection(baseUrl, actorId)` returning `SyncConnection`
   - `handshake(cursors?)` → POST `/sync/handshake`
   - `catchUpGroup(groupId, offset?)` → GET `/sync/groups/:groupId with header parsing
   - `getEntity(entityId)` → GET `/entities/:id`
3. **StorageAdapter** — `createMemoryAdapter()` from `@ebbjs/storage`
4. **`createEntityCache`** — `createEntityCache(storage, options?)` returning `EntityCache`
   - `get(id)` — synchronous, returns null on miss
   - `getOrFetch(id)` — async, fetches from storage on miss, populates cache
   - `set(id, entity)` — direct population
   - `invalidate(id)` — evict from cache
5. **`createSyncWorker`** — `createSyncWorker(connection, storage)` orchestrating handshake → catchup loop → cursor persistence
6. **Integration test** — wire up all components and verify against a running server with seeded data (using `@ebbjs/server` harness + seed)

## Seed Data Assumption

The server is pre-seeded with:

- 1 group (`id: "grp_001"`, type: "group", data: `{ name: "Test Group" }`)
- 1 group member linking `actor_test` to `grp_001`
- 1 entity (`id: "ent_001"`, type: "todo") with **at least 3 patch updates** to different fields so materialization can be observed

This slice validates that the client's materialization logic produces the same result as the server.
