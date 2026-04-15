# StorageAdapter

## Purpose

The unified interface that all storage adapters must implement. It composes the four sub-components (`ActionLog`, `DirtyTracker`, `EntityStore`, `CursorStore`) into a single entry point for the client.

## Interface

```typescript
import type { Action, Entity, GroupId } from "@ebbjs/core";
import type { ActionLog, DirtyTracker, EntityStore, CursorStore } from "./index";

interface StorageAdapter {
  readonly actions: ActionLog;
  readonly entities: EntityStore;
  readonly dirtyTracker: DirtyTracker;
  readonly cursors: CursorStore;

  isDirty(entityId: string): Promise<boolean>;
  reset(): Promise<void>;
}
```

## Sub-interfaces

Each property is an interface that adapters implement independently:

### actions

```typescript
interface ActionLog {
  append(action: Action): Promise<void>;
  getAll(): Promise<readonly Action[]>;
  getForEntity(entityId: string): Promise<readonly Action[]>;
  clear(): Promise<void>;
}
```

### entities

```typescript
interface EntityStore {
  get(id: string): Promise<Entity | null>;
  set(entity: Entity): Promise<void>;
  query(type: string): Promise<readonly Entity[]>;
  reset(): Promise<void>;
}
```

### dirtyTracker

```typescript
interface DirtyTracker {
  mark(entityId: string, entityType: string): Promise<void>;
  isDirty(entityId: string): Promise<boolean>;
  getDirtyForType(entityType: string): Promise<readonly string[]>;
  clear(entityId: string): Promise<void>;
  clearAll(): Promise<void>;
}
```

### cursors

```typescript
interface CursorStore {
  get(groupId: GroupId): Promise<number | null>;
  set(groupId: GroupId, cursor: number): Promise<void>;
}
```

## Adapter composition

Adapters compose the sub-interfaces:

```typescript
const createSomeAdapter = (): StorageAdapter => {
  const actionLog = createActionLog();
  const dirtyTracker = createDirtyTracker();
  const entityStore = createEntityStore(actionLog, dirtyTracker);
  const cursorStore = createCursorStore();

  return {
    actions: actionLog,
    entities: entityStore,
    dirtyTracker,
    cursors,
    isDirty: (id) => dirtyTracker.isDirty(id),
    reset: async () => {
      /* ... */
    },
  };
};
```

## Implementation requirements

All adapters must:

1. **Implement all sub-interfaces** — each property must satisfy its respective interface
2. **Handle async correctly** — all methods return `Promise`
3. **Return copies** — `entities.get()` and `entities.query()` must return copies to prevent mutation
4. **Support reset** — `reset()` should clear all state to initial values
5. **Coordinate dirty tracking** — when `actions.append()` is called, the adapter should mark affected entities dirty

## Future adapters

- **SQLiteAdapter** — persist all components to SQLite
- **IndexedDBAdapter** — persist all components to IndexedDB for browser use
- **HybridAdapter** — keep recent actions in memory, archive older ones to disk
