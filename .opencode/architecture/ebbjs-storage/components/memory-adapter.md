# MemoryAdapter

## Purpose

In-memory implementation of the `StorageAdapter` interface. Used for v1 and testing. Composes `MemoryActionLog`, `MemoryDirtyTracker`, `MemoryEntityStore`, and `MemoryCursorStore`.

## Interface

```typescript
import type { Action, Entity, GroupId, StorageAdapter } from "@ebbjs/core";

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

| Dependency     | What it needs  | Reference                         |
| -------------- | -------------- | --------------------------------- |
| `ActionLog`    | Action storage | [action-log](action-log.md)       |
| `DirtyTracker` | Dirty tracking | [dirty-tracker](dirty-tracker.md) |
| `EntityStore`  | Entity cache   | [entity-store](entity-store.md)   |
| `CursorStore`  | Cursor storage | [cursor-store](cursor-store.md)   |

## Implementation

```typescript
// storage/src/memory/memory-adapter.ts

import type { Action, Entity, GroupId, StorageAdapter } from "@ebbjs/core";
import type { ActionLog, DirtyTracker, EntityStore, CursorStore } from "../types";

import { createMemoryActionLog } from "../action-log/memory";
import { createMemoryDirtyTracker } from "../dirty-tracker/memory";
import { createMemoryEntityStore } from "../entity-store/memory";
import { createMemoryCursorStore } from "../cursor-store/memory";

const createMemoryAdapter = (): StorageAdapter => {
  const actionLog = createMemoryActionLog();
  const dirtyTracker = createMemoryDirtyTracker();
  const entityStore = createMemoryEntityStore(actionLog, dirtyTracker);
  const cursorStore = createMemoryCursorStore();

  return {
    actions: {
      async append(action: Action): Promise<void> {
        await actionLog.append(action);
        // Mark affected entities dirty
        for (const update of action.updates) {
          await dirtyTracker.mark(update.subject_id, update.subject_type);
        }
      },

      async getAll(): Promise<readonly Action[]> {
        return actionLog.getAll();
      },

      async getForEntity(entityId: string): Promise<readonly Action[]> {
        return actionLog.getForEntity(entityId);
      },

      async clear(): Promise<void> {
        await actionLog.clear();
        await dirtyTracker.clearAll();
        await entityStore.reset();
      },
    },

    entities: entityStore,

    dirtyTracker: {
      async mark(entityId: string, entityType: string): Promise<void> {
        await dirtyTracker.mark(entityId, entityType);
      },

      async isDirty(entityId: string): Promise<boolean> {
        return dirtyTracker.isDirty(entityId);
      },

      async getDirtyForType(entityType: string): Promise<readonly string[]> {
        return dirtyTracker.getDirtyForType(entityType);
      },

      async clear(entityId: string): Promise<void> {
        await dirtyTracker.clear(entityId);
      },

      async clearAll(): Promise<void> {
        await dirtyTracker.clearAll();
      },
    },

    cursors: cursorStore,

    async isDirty(entityId: string): Promise<boolean> {
      return dirtyTracker.isDirty(entityId);
    },

    async reset(): Promise<void> {
      // Create fresh instances
      // Note: In practice, you might want to call reset() on each component
      // or recreate the instances
      await actionLog.clear();
      await dirtyTracker.clearAll();
      await entityStore.reset();
    },
  };
};
```

## Adapter Pattern

The MemoryAdapter demonstrates the adapter composition pattern:

```
StorageAdapter (interface)
    │
    ├── actions: ActionLog (interface)
    ├── entities: EntityStore (interface)
    ├── dirtyTracker: DirtyTracker (interface)
    ├── cursors: CursorStore (interface)
    │
    └── isDirty(), reset() — cross-cutting operations
```

Each sub-component is created via its own factory function, allowing:

- Independent implementation of each interface
- Easy swapping for persistent backends (SQLite, IndexedDB)
- Testability — each component can be tested in isolation

## Future Adapters

To create a persistent adapter (e.g., SQLiteAdapter):

1. Implement each interface (`ActionLog`, `DirtyTracker`, `EntityStore`, `CursorStore`) with SQLite
2. Compose them the same way MemoryAdapter does
3. Return the same `StorageAdapter` interface

```typescript
const createSQLiteAdapter = (): StorageAdapter => {
  const actionLog = createSQLiteActionLog(db);
  const dirtyTracker = createSQLiteDirtyTracker(db);
  const entityStore = createSQLiteEntityStore(db, actionLog, dirtyTracker);
  const cursorStore = createSQLiteCursorStore(db);

  return {
    actions: actionLog,
    entities: entityStore,
    dirtyTracker,
    cursors: cursorStore,
    isDirty: (id) => dirtyTracker.isDirty(id),
    reset: () => {
      /* reset all */
    },
  };
};
```

## Test cases

```typescript
import { describe, it, expect } from "vitest";
import { createMemoryAdapter } from "./memory/memory-adapter";
import type { Action } from "@ebbjs/core";

describe("MemoryAdapter", () => {
  const action: Action = {
    id: "a_1",
    actor_id: "a_user1",
    hlc: "1711036800000",
    gsn: 1,
    updates: [
      {
        id: "u_1",
        subject_id: "todo_1",
        subject_type: "todo",
        method: "put",
        data: { title: { value: "Hello", update_id: "u_1" } },
      },
    ],
  };

  describe("actions.append", () => {
    it("stores action and marks entity dirty", async () => {
      const adapter = createMemoryAdapter();
      await adapter.actions.append(action);

      const actions = await adapter.actions.getAll();
      expect(actions).toEqual([action]);

      const dirty = await adapter.isDirty("todo_1");
      expect(dirty).toBe(true);
    });
  });

  describe("entities.get", () => {
    it("returns null for unknown entity", async () => {
      const adapter = createMemoryAdapter();
      const entity = await adapter.entities.get("unknown");
      expect(entity).toBe(null);
    });

    it("materializes dirty entity on get", async () => {
      const adapter = createMemoryAdapter();
      await adapter.actions.append(action);

      const entity = await adapter.entities.get("todo_1");
      expect(entity).not.toBe(null);
      expect(entity!.type).toBe("todo");
      expect(entity!.data.fields.title.value).toBe("Hello");
    });
  });

  describe("entities.query", () => {
    it("returns all entities of type", async () => {
      const adapter = createMemoryAdapter();
      await adapter.actions.append(action);

      const entities = await adapter.entities.query("todo");
      expect(entities).toHaveLength(1);
      expect(entities[0].id).toBe("todo_1");
    });
  });

  describe("cursors", () => {
    it("stores and retrieves cursor", async () => {
      const adapter = createMemoryAdapter();
      await adapter.cursors.set("group_1", 100);
      const cursor = await adapter.cursors.get("group_1");
      expect(cursor).toBe(100);
    });
  });

  describe("reset", () => {
    it("clears all state", async () => {
      const adapter = createMemoryAdapter();
      await adapter.actions.append(action);
      await adapter.reset();

      const actions = await adapter.actions.getAll();
      expect(actions).toEqual([]);

      const entity = await adapter.entities.get("todo_1");
      expect(entity).toBe(null);
    });
  });
});
```

## Open questions

- **Seeding for tests**: Not needed — tests set up state via `append()` calls, which exercises the full materialization flow.
- **Adapter recreation vs reset()**: Whether `reset()` should call `clear()` on each component or recreate instances entirely.
