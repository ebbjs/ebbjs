# StorageAdapter

## Purpose

Wraps `@ebbjs/storage`'s `createMemoryAdapter()` and exposes it to the rest of the client. The client does not implement any storage itself — it delegates entirely to this adapter.

## Responsibilities

- Create and hold a single `StorageAdapter` instance
- Provide a stable interface for `SyncWorker` to interact with
- Never expose raw storage internals to other components

## Public Interface

Exposes the full `StorageAdapter` interface from `@ebbjs/storage`:

```typescript
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

None — this component wraps an external package.

## Internal Design Notes

- **Functional wrapper** — does not implement its own storage, just holds and exposes a `StorageAdapter` from `@ebbjs/storage`
- For v1, always calls `createMemoryAdapter()` with no configuration
- The underlying storage uses:
  - `MemoryActionLog` — stores all received actions, sorted by GSN
  - `MemoryEntityStore` — materialized entity cache with LWW merge + lexicographic tiebreak
  - `MemoryDirtyTracker` — tracks dirty entities
  - `MemoryCursorStore` — per-group GSN cursors

## Key Behavior for Client

**On receiving actions (during catch-up):**

```
for each action:
  await storage.actions.append(action)
  for each update in action.updates:
    await storage.dirtyTracker.mark(update.subject_id, update.subject_type)
```

**On reading an entity:**

```
entity = await storage.entities.get(entityId)
// Returns materialized entity from cache
// Automatically clears dirty flag after materialization
```

**Merge semantics** (handled by MemoryEntityStore):

- `put`: full entity replacement
- `patch`: field-level LWW — higher HLC wins; tiebreak by lexicographic `update_id >=`
- `delete`: soft delete (sets `deleted_hlc`); patches on deleted entities are ignored

## Open Questions

- None for v1 read-only scope
