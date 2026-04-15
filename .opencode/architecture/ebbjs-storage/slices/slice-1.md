# Slice: Read and Query Flow

## Goal

Demonstrate the full end-to-end storage flow: receiving actions from the server, storing them in the action log, tracking which entities need rematerialization, and reading back materialized entities either individually or by type.

## Components involved

| Component                                        | Interface used                   |
| ------------------------------------------------ | -------------------------------- |
| [ActionLog](../components/action-log.md)         | `append()`, `getForEntity()`     |
| [DirtyTracker](../components/dirty-tracker.md)   | `mark()`, `isDirty()`, `clear()` |
| [EntityStore](../components/entity-store.md)     | `get()`, `query()`               |
| [CursorStore](../components/cursor-store.md)     | `get()`, `set()`                 |
| [MemoryAdapter](../components/memory-adapter.md) | Full `StorageAdapter` interface  |

## Flow

### Receiving an action

1. Client receives an action via SSE or catch-up response
2. `storage.actions.append(action)` is called
   - ActionLog stores the action and updates its type index
   - DirtyTracker marks each `subject_id` from `action.updates` as dirty

### Reading a single entity

3. Client calls `storage.entities.get(entityId)` to read an entity
   - If the entity is not dirty and exists in cache, return a copy
   - If the entity is dirty:
     - EntityStore fetches all actions for that entity from ActionLog
     - Replays actions in GSN order, applying put/patch/delete
     - Uses HLC + lexicographic `update_id` tiebreak for field-level conflicts
     - Caches the materialized entity
     - Clears the dirty flag
   - Returns a copy of the entity (to prevent accidental mutation)

### Querying by type

4. Client calls `storage.entities.query("todo")` to get all entities of a type
   - Uses DirtyTracker to find dirty entity IDs of that type
   - Materializes only the dirty entities (clean ones are already in cache)
   - Returns copies of all entities of that type

### Storing cursors

5. Client stores GSN cursor per group via `storage.cursors.set(groupId, gsn)`
   - Cursor is stored for sync resumption (not used in v1 read path, but part of the interface)

## Acceptance criteria

- [ ] Appending an action stores it in the action log and marks affected entities dirty
- [ ] Reading an entity that is not dirty returns a cached copy without rematerialization
- [ ] Reading an entity that is dirty triggers materialization from the action log
- [ ] Materialization replays actions in GSN order
- [ ] A `put` update replaces the entity's full data
- [ ] A `patch` update merges fields, using HLC timestamp for conflict resolution and lexicographic `update_id` as tiebreaker
- [ ] A `delete` update soft-deletes the entity by setting `deleted_hlc`
- [ ] An entity with `deleted_hlc` set ignores any subsequent patch updates
- [ ] Querying by type returns all entities of that type
- [ ] Querying by type only rematerializes dirty entities; clean entities are returned from cache
- [ ] Both `get` and `query` return copies of entities to prevent accidental mutation
- [ ] Dirty flag is cleared after successful materialization

## Build order

1. **Define interfaces first** — `ActionLog`, `DirtyTracker`, `EntityStore`, `CursorStore`, `StorageAdapter`
2. **MemoryActionLog** — implement `append()`, `getAll()`, `getForEntity()`, `clear()`
3. **MemoryDirtyTracker** — implement `mark()`, `isDirty()`, `getDirtyForType()`, `clear()`, `clearAll()`
4. **MemoryEntityStore** — implement `get()`, `query()`, `set()`, `reset()` with materialization
5. **MemoryCursorStore** — implement `get()`, `set()`
6. **MemoryAdapter** — compose all components, implement full `StorageAdapter` interface
7. **Integration verification** — manually walk through the full flow: append actions, get entities, query by type, verify materialization and dirty clearing

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
├── indexeddb/                 # Future
└── index.ts                   # Re-exports createMemoryAdapter, etc.
```
