# DirtyTracker

## Purpose

Tracks which entities need rematerialization. An entity is marked dirty when a new action affecting it is appended to the action log. It is cleared dirty after rematerialization.

This is defined as an **interface** that storage adapters implement. The `MemoryDirtyTracker` is the in-memory implementation for v1.

## Interface

```typescript
interface DirtyTracker {
  mark(entityId: string, entityType: string): Promise<void>;
  isDirty(entityId: string): Promise<boolean>;
  getDirtyForType(entityType: string): Promise<readonly string[]>;
  clear(entityId: string): Promise<void>;
  clearAll(): Promise<void>;
}
```

## Dependencies

None — pure data structures with no external dependencies.

## Memory Implementation

```typescript
// storage/src/memory/dirty-tracker.memory.ts

interface DirtyTrackerState {
  entities: readonly (readonly [entityId: string, type: string])[];
  typeIndex: readonly (readonly [type: string, entityIds: readonly string[]])[];
}

const createMemoryDirtyTracker = (): DirtyTracker => {
  let state: DirtyTrackerState = {
    entities: [],
    typeIndex: [],
  };

  return {
    async mark(entityId: string, entityType: string): Promise<void> {
      // Add to entities if not already present
      const exists = state.entities.some(([eId]) => eId === entityId);
      if (!exists) {
        state = {
          entities: [...state.entities, [entityId, entityType]],
          typeIndex: updateTypeIndex(state.typeIndex, entityType, entityId),
        };
      }
    },

    async isDirty(entityId: string): Promise<boolean> {
      return state.entities.some(([eId]) => eId === entityId);
    },

    async getDirtyForType(entityType: string): Promise<readonly string[]> {
      const entry = state.typeIndex.find(([t]) => t === entityType);
      return entry ? entry[1] : [];
    },

    async clear(entityId: string): Promise<void> {
      const entity = state.entities.find(([eId]) => eId === entityId);
      if (!entity) return;

      state = {
        entities: state.entities.filter(([eId]) => eId !== entityId),
        typeIndex: removeFromTypeIndex(state.typeIndex, entity[1], entityId),
      };
    },

    async clearAll(): Promise<void> {
      state = { entities: [], typeIndex: [] };
    },
  };
};

// Internal helpers
const updateTypeIndex = (
  typeIndex: readonly (readonly [string, readonly string[]])[],
  type: string,
  entityId: string,
): (readonly [string, readonly string[]])[] => {
  const entry = typeIndex.find(([t]) => t === type);
  if (entry) {
    if (!entry[1].includes(entityId)) {
      return typeIndex.map(([t, ids]) =>
        t === type ? ([t, [...ids, entityId]] as const) : ([t, ids] as const),
      );
    }
    return typeIndex;
  }
  return [...typeIndex, [type, [entityId]] as const];
};

const removeFromTypeIndex = (
  typeIndex: readonly (readonly [string, readonly string[]])[],
  type: string,
  entityId: string,
): (readonly [string, readonly string[]])[] => {
  return typeIndex
    .map(([t, ids]) =>
      t === type ? ([t, ids.filter((id) => id !== entityId)] as const) : ([t, ids] as const),
    )
    .filter(([, ids]) => ids.length > 0);
};
```

## Future Adapters

### SQLiteDirtyTracker

Would persist dirty state to SQLite:

- Track dirty entities with timestamps
- Periodic sync to clear dirty flags after successful materialization

### IndexedDBDirtyTracker

Would use IndexedDB for browser persistence:

- Object store for dirty entity tracking
- Efficient `getDirtyForType` via type index

## Test cases

```typescript
import { describe, it, expect } from "vitest";
import { createMemoryDirtyTracker } from "../memory/dirty-tracker.memory";

describe("MemoryDirtyTracker", () => {
  describe("mark", () => {
    it("marks an entity as dirty", async () => {
      const tracker = createMemoryDirtyTracker();
      await tracker.mark("todo_1", "todo");
      const dirty = await tracker.isDirty("todo_1");
      expect(dirty).toBe(true);
    });

    it("can mark multiple entities", async () => {
      const tracker = createMemoryDirtyTracker();
      await tracker.mark("todo_1", "todo");
      await tracker.mark("todo_2", "todo");
      expect(await tracker.isDirty("todo_1")).toBe(true);
      expect(await tracker.isDirty("todo_2")).toBe(true);
    });
  });

  describe("clear", () => {
    it("clears dirty flag for entity", async () => {
      const tracker = createMemoryDirtyTracker();
      await tracker.mark("todo_1", "todo");
      await tracker.clear("todo_1");
      expect(await tracker.isDirty("todo_1")).toBe(false);
    });
  });

  describe("getDirtyForType", () => {
    it("returns all dirty entities of a type", async () => {
      const tracker = createMemoryDirtyTracker();
      await tracker.mark("todo_1", "todo");
      await tracker.mark("todo_2", "todo");
      await tracker.mark("doc_1", "document");
      const dirty = await tracker.getDirtyForType("todo");
      expect(dirty).toEqual(["todo_1", "todo_2"]);
    });

    it("returns empty for unknown type", async () => {
      const tracker = createMemoryDirtyTracker();
      const dirty = await tracker.getDirtyForType("unknown");
      expect(dirty).toEqual([]);
    });
  });

  describe("clearAll", () => {
    it("resets all dirty state", async () => {
      const tracker = createMemoryDirtyTracker();
      await tracker.mark("todo_1", "todo");
      await tracker.clearAll();
      expect(await tracker.isDirty("todo_1")).toBe(false);
    });
  });
});
```

## Open questions

- None for v1 read path.
