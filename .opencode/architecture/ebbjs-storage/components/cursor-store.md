# CursorStore

## Purpose

Stores per-group GSN cursors. Used by the sync protocol to track where in the action stream the client has consumed up to.

This is defined as an **interface** that storage adapters implement. The `MemoryCursorStore` is the in-memory implementation for v1.

## Interface

```typescript
import type { GroupId } from "@ebbjs/core";

interface CursorStore {
  get(groupId: GroupId): Promise<number | null>;
  set(groupId: GroupId, cursor: number): Promise<void>;
}
```

## Dependencies

| Dependency    | What it needs  | Reference     |
| ------------- | -------------- | ------------- |
| `@ebbjs/core` | `GroupId` type | `types/group` |

## Memory Implementation

```typescript
// storage/src/memory/cursor-store.memory.ts

import type { GroupId } from "@ebbjs/core";

interface CursorStoreState {
  cursors: readonly (readonly [groupId: GroupId, cursor: number])[];
}

const createMemoryCursorStore = (): CursorStore => {
  let state: CursorStoreState = { cursors: [] };

  return {
    async get(groupId: GroupId): Promise<number | null> {
      const entry = state.cursors.find(([gId]) => gId === groupId);
      return entry ? entry[1] : null;
    },

    async set(groupId: GroupId, cursor: number): Promise<void> {
      const exists = state.cursors.some(([gId]) => gId === groupId);
      if (exists) {
        state = {
          cursors: state.cursors.map(([gId, c]) =>
            gId === groupId ? [groupId, cursor] : [gId, c],
          ),
        };
      } else {
        state = {
          cursors: [...state.cursors, [groupId, cursor]],
        };
      }
    },
  };
};
```

### GSN vs HLC

- **GSN (Global Sequence Number)**: Integer assigned by server, used for cursors and ordering
- **HLC (Hybrid Logical Clock)**: String timestamp used for conflict resolution

CursorStore deals exclusively in GSN integers. It never handles HLC.

## Future Adapters

### SQLiteCursorStore

Would persist cursors to SQLite:

- Cursors table with group_id and cursor value
- Primary key on group_id for fast lookups

### IndexedDBCursorStore

Would use IndexedDB for browser persistence:

- Object store for cursors keyed by group ID
- Persists across sessions

## Test cases

```typescript
import { describe, it, expect } from "vitest";
import { createMemoryCursorStore } from "../memory/cursor-store.memory";

describe("MemoryCursorStore", () => {
  describe("get", () => {
    it("returns null for unknown group", async () => {
      const store = createMemoryCursorStore();
      const cursor = await store.get("group_1");
      expect(cursor).toBe(null);
    });
  });

  describe("set", () => {
    it("stores cursor for group", async () => {
      const store = createMemoryCursorStore();
      await store.set("group_1", 100);
      const cursor = await store.get("group_1");
      expect(cursor).toBe(100);
    });

    it("updates existing cursor", async () => {
      const store = createMemoryCursorStore();
      await store.set("group_1", 100);
      await store.set("group_1", 200);
      const cursor = await store.get("group_1");
      expect(cursor).toBe(200);
    });

    it("can store multiple group cursors", async () => {
      const store = createMemoryCursorStore();
      await store.set("group_1", 100);
      await store.set("group_2", 200);
      expect(await store.get("group_1")).toBe(100);
      expect(await store.get("group_2")).toBe(200);
    });
  });
});
```

## Open questions

- None for v1.
