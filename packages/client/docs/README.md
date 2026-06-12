# ebb-client v1 — Read-Only Sync Client

## Summary

The v1 client is a read-only sync client that connects to a running `ebb_server`, performs catch-up on a single group, and maintains correct materialized entity state in its local entity store. It bypasses authentication via the `x-ebb-actor-id` header and uses the in-memory `@ebbjs/storage` adapter for local state.

## Components

| Component                                       | Purpose                                                       |
| ----------------------------------------------- | ------------------------------------------------------------- |
| [SyncConnection](components/sync-connection.md) | Manages HTTP connection to server with actor-id header        |
| [SyncWorker](components/sync-worker.md)         | Orchestrates handshake + catchup flow                         |
| [StorageAdapter](components/storage-adapter.md) | Wraps `@ebbjs/storage`'s `createMemoryAdapter()`              |
| [EntityCache](components/entity-cache.md)       | LRU cache of materialized entities for fast synchronous reads |

## Architecture

```
┌── Main Thread ─────────────────────────────────────────────────────────┐
│                                                                         │
│   ┌────────────────┐                                                  │
│   │  React / UI    │                                                  │
│   └───────┬────────┘                                                  │
│           │ reads entity by id                                         │
│           ▼                                                             │
│   ┌────────────────┐                                                  │
│   │  EntityCache   │  ← LRU, synchronous hits                           │
│   │  (entity-level)│                                                  │
│   └───────┬────────┘                                                  │
│           │ cache miss →                                               │
│           ▼                                                             │
│   ┌──────────────────────────────┐                                    │
│   │  StorageAdapter              │                                    │
│   │  (@ebbjs/storage)            │                                    │
│   │  ├── ActionLog               │                                    │
│   │  ├── EntityStore             │                                    │
│   │  ├── DirtyTracker            │                                    │
│   │  └── CursorStore             │                                    │
│   └──────────────────────────────┘                                    │
│                                                                         │
└────────────────────────────────────────────────────────────────────────┘
                              ▲
                              │ entity-updated events
                              │
┌── Worker Thread (v2) ─────────────────────────────────────────────────┐
│                                                                         │
│   SSE connection → processes actions → materializes → posts updates    │
│                                                                         │
└────────────────────────────────────────────────────────────────────────┘
```

For v1, the worker thread does not exist yet. SyncWorker runs on the main thread. The EntityCache sits above StorageAdapter on the main thread and provides synchronous reads for React components.

## Dependencies

```
SyncWorker --> SyncConnection --> fetch() builtin
                         |
                         v
               StorageAdapter (@ebbjs/storage)
                         |
                         ├── ActionLog
                         ├── EntityStore
                         ├── DirtyTracker
                         └── CursorStore

EntityCache --> StorageAdapter (reads via cache misses)
```

## Vertical Slices

| #   | Slice                                                               | Components involved                         | Purpose                                                                             |
| --- | ------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | [Establish Connection + Catchup](slices/slice-1-connect-catchup.md) | SyncConnection, StorageAdapter, EntityCache | Thinnest end-to-end: connect with actor-id, catchup on a group, verify entity state |

## Data Flow

1. `SyncWorker.handshake()` → POST `/sync/handshake` → receive group membership
2. `SyncWorker.catchup(groupId, cursor?)` → GET `/sync/groups/:group_id?offset=cursor` → receive paginated actions
3. For each action: `storage.actions.append(action)` + `storage.dirtyTracker.mark(subject_id, subject_type)`
4. Entity materialization happens lazily on `storage.entities.get(id)` via built-in materialization
5. EntityCache is populated from storage on `getEntity()` calls

## Cross-cutting concerns

- **Actor ID header**: All requests include `x-ebb-actor-id: <actorId>` header (bypass auth mode)
- **Pagination**: Catchup loops until `stream-up-to-date: true` header is received
- **GSN tracking**: CursorStore tracks per-group `last_gsn` to resume from on reconnect
- **Materialization**: Handled by `@ebbjs/storage`'s `EntityStore` (LWW + lexicographic tiebreak on update_id)
- **Immutability**: All entity reads from storage return copies (handled by storage adapter)
- **LRU caching**: EntityCache provides synchronous reads with LRU eviction; populated on cache miss from StorageAdapter

## Constraints and assumptions

- Server is seeded with exactly: 1 group, 1 group member, 1 entity with several patch updates
- Server is running in `:bypass` auth mode (no auth callback required)
- Client stores all received actions in-memory (no persistence for v1)
- Client does not subscribe to live SSE stream for v1 (catchup-only)
- The client does not write actions (read-only for v1)
- EntityCache is entity-level only (not query-level) — query caching deferred to v2
