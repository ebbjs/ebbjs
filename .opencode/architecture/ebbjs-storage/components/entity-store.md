# EntityStore

## Purpose

Holds materialized (cached) entities and handles `get` and `query` operations. Entities are materialized on-demand from the action log when they are dirty.

This is defined as an **interface** that storage adapters implement. The `MemoryEntityStore` is the in-memory implementation for v1.

## Interface

```typescript
import type { Entity, Action } from "@ebbjs/core";
import type { ActionLog, DirtyTracker } from "./index";

interface EntityStore {
  get(id: string): Promise<Entity | null>;
  set(entity: Entity): Promise<void>;
  query(type: string): Promise<readonly Entity[]>;
  reset(): Promise<void>;
}
```

## Dependencies

| Dependency     | What it needs                                                                     | Reference                                     |
| -------------- | --------------------------------------------------------------------------------- | --------------------------------------------- |
| `@ebbjs/core`  | `Entity`, `Action`, `Update`, `PutData`, `PatchData`, `HLCTimestamp`; `compare()` | `types/entity`, `types/action`, `hlc/compare` |
| `ActionLog`    | `getForEntity()` to fetch actions for materialization                             | [action-log](action-log.md)                   |
| `DirtyTracker` | `isDirty()`, `getDirtyForType()`                                                  | [dirty-tracker](dirty-tracker.md)             |

## Memory Implementation

```typescript
// storage/src/memory/entity-store.memory.ts

import type { Entity, Action, Update, PutData, PatchData, HLCTimestamp } from "@ebbjs/core";
import type { ActionLog, DirtyTracker } from "../index";
import { compare } from "@ebbjs/core/hlc/compare";

interface EntityStoreState {
  entities: readonly (readonly [entityId: string, entity: Entity])[];
}

const createMemoryEntityStore = (actionLog: ActionLog, dirtyTracker: DirtyTracker): EntityStore => {
  let state: EntityStoreState = { entities: [] };

  const materialize = async (entityId: string): Promise<void> => {
    const isEntityDirty = await dirtyTracker.isDirty(entityId);
    if (!isEntityDirty) return;

    const actions = await actionLog.getForEntity(entityId);
    if (actions.length === 0) return;

    let entity: Entity | null = null;

    for (const action of actions) {
      for (const update of action.updates) {
        if (update.subject_id !== entityId) continue;
        entity = applyUpdate(entity, update, action.gsn, action.hlc);
      }
    }

    if (entity === null) return;

    // Update or insert entity
    const exists = state.entities.some(([eId]) => eId === entityId);
    if (exists) {
      state = {
        entities: state.entities.map(([eId, e]) =>
          eId === entityId ? [entityId, copyEntity(entity!)] : [eId, e],
        ),
      };
    } else {
      state = {
        entities: [...state.entities, [entityId, copyEntity(entity)]],
      };
    }

    await dirtyTracker.clear(entityId);
  };

  return {
    async get(id: string): Promise<Entity | null> {
      await materialize(id);
      const found = state.entities.find(([eId]) => eId === id);
      return found ? copyEntity(found[1]) : null;
    },

    async set(entity: Entity): Promise<void> {
      const exists = state.entities.some(([eId]) => eId === entity.id);
      if (exists) {
        state = {
          entities: state.entities.map(([eId, e]) =>
            eId === entity.id ? [eId, copyEntity(entity)] : [eId, e],
          ),
        };
      } else {
        state = {
          entities: [...state.entities, [entity.id, copyEntity(entity)]],
        };
      }
    },

    async query(type: string): Promise<readonly Entity[]> {
      const dirtyIds = await dirtyTracker.getDirtyForType(type);

      // Materialize dirty entities
      for (const id of dirtyIds) {
        await materialize(id);
      }

      return state.entities.filter(([, e]) => e.type === type).map(([, e]) => copyEntity(e));
    },

    async reset(): Promise<void> {
      state = { entities: [] };
    },
  };
};

// Internal helpers
const copyEntity = (entity: Entity): Entity => JSON.parse(JSON.stringify(entity));

const applyUpdate = (
  entity: Entity | null,
  update: Update,
  gsn: number,
  hlc: HLCTimestamp,
): Entity => {
  switch (update.method) {
    case "put":
      return {
        id: update.subject_id,
        type: update.subject_type,
        data: update.data as PutData,
        created_hlc: hlc,
        updated_hlc: hlc,
        deleted_hlc: null,
        last_gsn: gsn,
      };

    case "patch":
      if (!entity) throw new Error("Cannot patch non-existent entity");
      if (entity.deleted_hlc) return entity; // Ignore patch on deleted
      return {
        ...entity,
        data: mergeFields(entity.data, update.data as PatchData),
        updated_hlc: laterHlc(entity.updated_hlc, hlc) ? hlc : entity.updated_hlc,
        last_gsn: Math.max(entity.last_gsn, gsn),
      };

    case "delete":
      if (!entity) throw new Error("Cannot delete non-existent entity");
      return {
        ...entity,
        deleted_hlc: hlc,
        updated_hlc: hlc,
        last_gsn: Math.max(entity.last_gsn, gsn),
      };
  }
};

const mergeFields = (existing: EntityData, patch: PatchData): EntityData => {
  const merged = { ...existing.fields };

  for (const [field, patchValue] of Object.entries(patch)) {
    const existingValue = merged[field];
    if (!existingValue) {
      merged[field] = patchValue;
    } else {
      const hlcCmp = compare(existingValue.hlc ?? "", patchValue.hlc ?? "");
      if (hlcCmp < 0) {
        merged[field] = patchValue;
      } else if (hlcCmp === 0) {
        if (patchValue.update_id > existingValue.update_id) {
          merged[field] = patchValue;
        }
      }
    }
  }

  return { fields: merged };
};

const laterHlc = (a: HLCTimestamp, b: HLCTimestamp): boolean => {
  return compare(a, b) < 0;
};
```

## Merge semantics

- **put**: Full replace of entity data
- **patch**: Field-level merge. For each field, higher HLC wins; tiebreak by lexicographic `update_id`
- **delete**: Soft delete — sets `deleted_hlc`, entity still exists but is considered deleted
- **patch on deleted**: Ignored — if `deleted_hlc` is set, patch updates are silently dropped

## Future Adapters

### SQLiteEntityStore

Would persist materialized entities to SQLite:

- Entities table with full entity JSON
- Index on `type` for query optimization
- Periodic sync with action log

### IndexedDBEntityStore

Would use IndexedDB for browser persistence:

- Object store for entities keyed by ID
- Index on type for query optimization

## Test cases

```typescript
import { describe, it, expect } from "vitest";
import { createMemoryEntityStore } from "../memory/entity-store.memory";
import { createMemoryActionLog } from "../memory/action-log.memory";
import { createMemoryDirtyTracker } from "../memory/dirty-tracker.memory";
import type { Action } from "@ebbjs/core";

describe("MemoryEntityStore", () => {
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

  const makeStore = async () => {
    const actionLog = createMemoryActionLog();
    const dirtyTracker = createMemoryDirtyTracker();
    const store = createMemoryEntityStore(actionLog, dirtyTracker);
    return { store, actionLog, dirtyTracker };
  };

  describe("get", () => {
    it("returns null for unknown entity", async () => {
      const { store } = await makeStore();
      const entity = await store.get("unknown");
      expect(entity).toBe(null);
    });

    it("materializes dirty entity on get", async () => {
      const { store, actionLog, dirtyTracker } = await makeStore();
      await actionLog.append(action);
      await dirtyTracker.mark("todo_1", "todo");

      const entity = await store.get("todo_1");
      expect(entity).not.toBe(null);
      expect(entity!.type).toBe("todo");
      expect(entity!.data.fields.title.value).toBe("Hello");
    });
  });

  describe("query", () => {
    it("returns all entities of type", async () => {
      const { store, actionLog, dirtyTracker } = await makeStore();
      await actionLog.append(action);
      await dirtyTracker.mark("todo_1", "todo");

      const entities = await store.query("todo");
      expect(entities).toHaveLength(1);
      expect(entities[0].id).toBe("todo_1");
    });
  });
});
```

## Open questions

- **Pagination**: No pagination for v1 — assumes all entities of a type can fit in memory.
- **Patch on deleted entity**: Ignored — if `deleted_hlc` is set, patch updates are silently dropped.
