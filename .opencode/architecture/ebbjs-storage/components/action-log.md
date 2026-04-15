# ActionLog

## Purpose

Stores received actions and provides queries to retrieve actions by entity. The action log is the source of truth — entities are derived by replaying actions.

This is defined as an **interface** that storage adapters implement. The `MemoryActionLog` is the in-memory implementation for v1; future adapters (SQLite, IndexedDB) would implement the same interface with different persistence strategies.

## Interface

```typescript
import type { Action } from "@ebbjs/core";

interface ActionLog {
  append(action: Action): Promise<void>;
  getAll(): Promise<readonly Action[]>;
  getForEntity(entityId: string): Promise<readonly Action[]>;
  clear(): Promise<void>;
}
```

## Dependencies

| Dependency    | What it needs            | Reference      |
| ------------- | ------------------------ | -------------- |
| `@ebbjs/core` | `Action`, `Update` types | `types/action` |

## Memory Implementation

```typescript
// storage/src/memory/action-log.memory.ts

interface ActionLogState {
  actions: readonly Action[];
  typeIndex: readonly (readonly [type: string, entityIds: readonly string[]])[];
}

const createMemoryActionLog = (): ActionLog => {
  let state: ActionLogState = {
    actions: [],
    typeIndex: [],
  };

  const updateTypeIndex = (
    typeIndex: readonly (readonly [string, readonly string[]])[],
    action: Action,
  ): (readonly [string, readonly string[]])[] => {
    const map = new Map<string, Set<string>>();
    for (const [type, entityIds] of typeIndex) {
      map.set(type, new Set(entityIds));
    }
    for (const update of action.updates) {
      const existing = map.get(update.subject_type);
      if (existing) {
        existing.add(update.subject_id);
      } else {
        map.set(update.subject_type, new Set([update.subject_id]));
      }
    }
    return Array.from(map.entries()).map(([type, ids]) => [type, Array.from(ids)] as const);
  };

  return {
    async append(action: Action): Promise<void> {
      state = {
        actions: [...state.actions, action],
        typeIndex: updateTypeIndex(state.typeIndex, action),
      };
    },

    async getAll(): Promise<readonly Action[]> {
      return state.actions;
    },

    async getForEntity(entityId: string): Promise<readonly Action[]> {
      const found = state.actions.filter((action) =>
        action.updates.some((update) => update.subject_id === entityId),
      );
      return found.sort((a, b) => a.gsn - b.gsn);
    },

    async clear(): Promise<void> {
      state = { actions: [], typeIndex: [] };
    },
  };
};
```

### Type index

Maintains `Map<type, Set<entityId>>` to support `entities.query(type)` without scanning all actions. Updated incrementally on each `append`.

### GSN ordering

Actions returned by `getForEntity` are sorted by `gsn` ascending. GSN is monotonically increasing, so this is equivalent to ordering by action receipt order.

## Future Adapters

### SQLiteActionLog

Would persist actions to a SQLite database:

- Actions table with full action JSON
- Index on `updates.subject_id` for entity queries
- Index on `updates.subject_type` for type queries

### IndexedDBActionLog

Would use IndexedDB for browser persistence:

- Object store for actions keyed by ID
- Index on subject_id for entity queries
- Periodic compaction to reduce storage growth

## Test cases

```typescript
import { describe, it, expect } from "vitest";
import { createMemoryActionLog } from "../memory/action-log.memory";
import type { Action } from "@ebbjs/core";

describe("MemoryActionLog", () => {
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

  describe("append", () => {
    it("stores the action", async () => {
      const log = createMemoryActionLog();
      await log.append(action);
      const actions = await log.getAll();
      expect(actions).toEqual([action]);
    });
  });

  describe("getForEntity", () => {
    it("returns actions affecting the entity", async () => {
      const log = createMemoryActionLog();
      await log.append(action);
      const found = await log.getForEntity("todo_1");
      expect(found).toEqual([action]);
    });

    it("returns empty for unknown entity", async () => {
      const log = createMemoryActionLog();
      const found = await log.getForEntity("unknown");
      expect(found).toEqual([]);
    });
  });

  describe("clear", () => {
    it("removes all actions and resets type index", async () => {
      const log = createMemoryActionLog();
      await log.append(action);
      await log.clear();
      const actions = await log.getAll();
      expect(actions).toEqual([]);
    });
  });
});
```

## Open questions

- **Persistence strategy**: Each adapter decides how to persist (or not). MemoryAdapter keeps in-memory only.
