# @ebbjs/storage

## Summary

Provides a storage adapter interface for `@ebbjs/client` that maintains a local replica of entity data. The adapter pattern allows different storage backends (memory, IndexedDB, SQLite) to be swapped without changing client code.

The storage works similarly to the server's materialized cache: entities are materialized on-demand from an action log, and a dirty tracker identifies which entities need rematerialization when new actions arrive.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      StorageAdapter                          │
│  (unified interface: actions, entities, dirty, cursors)     │
└─────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  MemoryAdapter  │  │  IndexedDB      │  │  SQLite         │
│  (in-memory)    │  │  (persistent)   │  │  (persistent)   │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

## Components

| Component                                       | Purpose                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| [StorageAdapter](components/storage-adapter.md) | Unified interface all adapters must satisfy                      |
| [ActionLog](components/action-log.md)           | Stores received actions; provides entity-level queries           |
| [DirtyTracker](components/dirty-tracker.md)     | Tracks entity IDs that need rematerialization; queryable by type |
| [EntityStore](components/entity-store.md)       | Materialized entity cache; handles get and query operations      |
| [CursorStore](components/cursor-store.md)       | Per-group GSN cursor tracking for sync resumption                |
| [MemoryAdapter](components/memory-adapter.md)   | In-memory implementation of the StorageAdapter                   |

## Interface design

Each storage component is defined as an **interface** that adapters implement:

```typescript
interface ActionLog {
  append(action: Action): Promise<void>;
  getAll(): Promise<readonly Action[]>;
  getForEntity(entityId: string): Promise<readonly Action[]>;
  clear(): Promise<void>;
}

interface DirtyTracker {
  mark(entityId: string, entityType: string): Promise<void>;
  isDirty(entityId: string): Promise<boolean>;
  getDirtyForType(entityType: string): Promise<readonly string[]>;
  clear(entityId: string): Promise<void>;
  clearAll(): Promise<void>;
}

interface EntityStore {
  get(id: string): Promise<Entity | null>;
  set(entity: Entity): Promise<void>;
  query(type: string): Promise<readonly Entity[]>;
  reset(): Promise<void>;
}

interface CursorStore {
  get(groupId: string): Promise<number | null>;
  set(groupId: string, cursor: number): Promise<void>;
}

interface StorageAdapter {
  readonly actions: ActionLog;
  readonly entities: EntityStore;
  readonly dirtyTracker: DirtyTracker;
  readonly cursors: CursorStore;

  isDirty(entityId: string): Promise<boolean>;
  reset(): Promise<void>;
}
```

## Dependencies

```
Client App
    │
    ▼
StorageAdapter (public interface)
    │
    ├──► EntityStore ──► DirtyTracker
    │                    │
    │                    ▼
    │               ActionLog
    │
    └──► CursorStore
```

## Type reuse from @ebbjs/core

The following types and functions are imported from `@ebbjs/core`:

| Type/Function                          | Source                      | Usage                               |
| -------------------------------------- | --------------------------- | ----------------------------------- |
| `Action`, `Update`                     | `types/action`              | Action log storage, materialization |
| `Entity`, `EntityData`, `FieldValue`   | `types/entity`              | Cached entities, merge semantics    |
| `NanoId`, `HLCTimestamp`               | `types/hlc`, `types/nanoid` | ID and timestamp types              |
| `GroupId`                              | `types/group`               | Cursor store keys                   |
| `compare()`, `isBefore()`, `isAfter()` | `hlc/compare`               | HLC comparison for merge            |

## Vertical slices

| #   | Slice                                    | Components involved | Purpose                                                                      |
| --- | ---------------------------------------- | ------------------- | ---------------------------------------------------------------------------- |
| 1   | [Read and Query Flow](slices/slice-1.md) | All                 | Full end-to-end: append action → dirty tracking → get entity → query by type |

## Constraints and assumptions

- **v1 is read-only**: The write path (outbox, optimistic updates, conflict resolution) is deferred to a future iteration.
- **Actions are append-only**: Once an action is stored, it is never modified or deleted. Rollback is handled by compensating actions, not by mutating the log.
- **Materialization is lazy**: Entities are only rematerialized when read, not eagerly on action receipt.
- **HLC + lexicographic tiebreak for conflicts**: Same merge semantics as the server — higher HLC wins, tiebreak by lexicographic `update_id`.
- **No pagination**: `query(type)` returns all entities of type without pagination.
- **Patch on deleted entity is ignored**: If `deleted_hlc` is set, patch updates are silently dropped.
- **Adapter-specific persistence**: Each adapter manages its own persistence strategy (MemoryAdapter keeps in-memory, future adapters persist to disk).

## File structure

```
packages/storage/src/
├── types/
│   ├── action-log.ts
│   ├── dirty-tracker.ts
│   ├── entity-store.ts
│   ├── cursor-store.ts
│   └── storage-adapter.ts
├── memory/
│   ├── action-log.memory.ts
│   ├── dirty-tracker.memory.ts
│   ├── entity-store.memory.ts
│   ├── cursor-store.memory.ts
│   └── memory-adapter.ts
├── sqlite/                    # Future
│   ├── action-log.sqlite.ts
│   └── sqlite-adapter.ts
├── indexeddb/                 # Future
│   └── ...
└── index.ts                   # Re-exports createMemoryAdapter, etc.
```

**Organization:**

- `types/` — All component interfaces
- `memory/` — In-memory implementations (v1)
- `sqlite/` — SQLite adapter (future)
- `indexeddb/` — IndexedDB adapter (future)

## Cross-cutting concerns

- **Immutability**: `entities.get()` and `entities.query()` return copies to prevent accidental mutation.
- **GSN tracking**: Each entity tracks `last_gsn` — the highest GSN of any action applied to it. Used to determine where to start replay.
- **Dirty state**: Exposed via `isDirty()` for UI indicators (e.g., sync status), but primarily used internally for query optimization.
- **Async-only interfaces**: All storage component methods are async to support future persistent backends.
