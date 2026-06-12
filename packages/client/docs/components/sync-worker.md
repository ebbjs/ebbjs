# SyncWorker

## Purpose

Orchestrates the full sync lifecycle: handshake to discover group membership, then catch-up on each group by paginating through all actions and appending them to local storage.

## Responsibilities

- Perform initial handshake to discover groups and valid cursors
- Iterate catch-up for each group the actor is a member of
- Handle pagination by looping until `upToDate: true`
- Update CursorStore with latest GSN per group after successful catch-up
- Expose `connect()` as the main entry point that wires everything together

## Public Interface

```typescript
interface SyncWorker {
  /**
   * Main entry point: perform handshake + catchup on all groups.
   * Returns after all groups are caught up and storage is up-to-date.
   */
  connect(): Promise<ConnectedState>;
}

interface ConnectedState {
  actorId: string;
  groups: Group[];
}
```

## Dependencies

| Dependency     | What it needs                                              | Reference                             |
| -------------- | ---------------------------------------------------------- | ------------------------------------- |
| SyncConnection | `handshake()`, `catchUpGroup()`                            | [sync-connection](sync-connection.md) |
| StorageAdapter | `actions.append()`, `dirtyTracker.mark()`, `cursors.set()` | [storage-adapter](storage-adapter.md) |

## Factory Signature

```typescript
const createSyncWorker = (connection: SyncConnection, storage: StorageAdapter): SyncWorker => {
  // returns a plain object implementing SyncWorker
  // no class, no `new`, no `this`
};
```

## Internal Design Notes

### Handshake Flow

```
1. SyncWorker.connect() calls connection.handshake()
2. For each group where cursor_valid === true:
   a. cursor = group.cursor (from handshake)
   b. loop: call connection.catchUpGroup(group.id, cursor)
   c. for each action in response.actions:
         - await storage.actions.append(action)
         - for each update: await storage.dirtyTracker.mark(update.subject_id, update.subject_type)
   d. update storage.cursors.set(group.id, last_gsn_from_actions)
   e. if response.nextOffset !== null: set cursor = response.nextOffset and continue loop
   f. if response.upToDate === true: move to next group
3. Return ConnectedState
```

### Cursor Management

- Initial cursor comes from handshake response (`group.cursor`)
- After each catch-up batch, cursor is updated to `response.nextOffset` (last GSN in batch)
- Cursor is persisted to `CursorStore` after each successful batch

### Error Handling

- `cursor_valid: false` for a group → skip catchup, log warning
- HTTP errors → propagate as errors (SyncWorker doesn't retry on its own for v1)

## Future: Worker Thread Migration

SyncWorker is designed to eventually run inside a Web Worker. The interface is worker-agnostic — the same `connect()` and `ConnectedState` shape works whether it runs on main thread or worker thread.

### Migration Path

**Now** (main thread):

```typescript
// index.ts
import { createSyncWorker } from "./worker-impl";
export const createClient = (config) => {
  return createSyncWorker(connection, storage); // runs on main thread
};
```

**Later** (worker thread):

```typescript
// index.ts
import { createSyncWorkerViaWorker } from "./worker-client";
export const createClient = (config) => {
  return createSyncWorkerViaWorker(connection); // runs in worker thread
};
```

The main thread code that calls `createClient()` does not change. The interface (`SyncWorker`) is the load-bearing contract. Internal implementation is swappable.

### Events for Worker Communication

When the worker runs, events propagate from worker → main thread:

```typescript
interface SyncWorker {
  on(event: "entity-updated", cb: (entity: Entity) => void): void;
  off(event: "entity-updated", cb: (entity: Entity) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  off(event: "error", cb: (err: Error) => void): void;
}
```

`entity-updated` events are used by the main thread to populate the EntityCache. For v1, these events are not used (SyncWorker runs on main thread, EntityCache is populated via direct `getOrFetch` calls).

## Open Questions

- None for v1 read-only scope
