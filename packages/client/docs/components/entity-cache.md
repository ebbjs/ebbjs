# EntityCache

## Purpose

Provides a synchronous, fast-path read layer above the StorageAdapter. React components read entities without async cross-thread communication on cache hits. On cache miss, falls through to the StorageAdapter and populates the cache.

## Responsibilities

- LRU cache of materialized entities by entity ID
- Synchronous `get()` for cache hits (main thread, no postMessage)
- Async `getOrFetch()` for cache misses (triggers storage read)
- Invalidation when entity-updated events arrive from the worker
- Bounded size with LRU eviction

## Public Interface

```typescript
interface EntityCache {
  /** Synchronous read — returns cached entity or null (no fetch on miss) */
  get(id: string): Entity | null;

  /** Async read — returns cached entity or fetches from storage */
  getOrFetch(id: string): Promise<Entity>;

  /** Direct set — used when entity-updated event populates cache */
  set(id: string, entity: Entity): void;

  /** Evict from cache — called when entity is updated via SSE event */
  invalidate(id: string): void;

  /** Clear entire cache */
  reset(): void;
}
```

## Factory Signature

```typescript
const createEntityCache = (
  storage: StorageAdapter,
  options?: {
    maxSize?: number; // default 500
  },
): EntityCache => {
  // returns a plain object implementing EntityCache
  // no class, no `new`, no `this`
};
```

## Internal Design Notes

### LRU Implementation

Uses a `Map<string, Entity>` with move-to-end-on-access eviction strategy:

- On `get(id)`: if exists, move to end (most recently used). Return null if not found.
- On `set(id, entity)`: if size > maxSize, delete oldest entry (first in Map iteration order).
- On `invalidate(id)`: delete from map.

### Cache Read Path

```
get(id)
  → cache hit: return entity synchronously
  → cache miss: return null

getOrFetch(id)
  → cache hit: return entity (wrapped in resolved Promise)
  → cache miss: await storage.entities.get(id), set in cache, return
```

### Event Invalidation

When `entity-updated` event arrives from worker (v2):

```typescript
worker.on("entity-updated", (entity: Entity) => {
  entityCache.set(entity.id, entity); // update cache with new materialized state
});
```

Invalidation is direct set (no need to delete then set — just upsert).

### Size Constraints

- Default maxSize: 500 entities
- On every `set()`, if size > maxSize, evict the oldest entry
- `reset()` clears all entries (used when sync worker disconnects and reconnects)

## Dependencies

| Dependency     | What it needs                  | Reference                             |
| -------------- | ------------------------------ | ------------------------------------- |
| StorageAdapter | `entities.get()` on cache miss | [storage-adapter](storage-adapter.md) |

## Open Questions

- None for v1 read-only scope
