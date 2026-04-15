import { describe, it, expect } from "vitest";
import { createMemoryEntityStore } from "./entity-store.memory";
import { createMemoryActionLog } from "./action-log.memory";
import { createMemoryDirtyTracker } from "./dirty-tracker.memory";
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
        data: { title: { value: "Hello", update_id: "u_1", hlc: "1711036800000" } },
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
      expect(entity!.id).toBe("todo_1");
      expect(entity!.type).toBe("todo");
      expect(entity!.last_gsn).toBe(1);
    });

    it("returns copy to prevent mutation", async () => {
      const { store, actionLog, dirtyTracker } = await makeStore();
      await actionLog.append(action);
      await dirtyTracker.mark("todo_1", "todo");

      const entity1 = await store.get("todo_1");
      const entity2 = await store.get("todo_1");

      // Mutate the first entity's data
      (entity1 as { data: { fields: Record<string, unknown> } }).data.fields.title = "Modified";
      // Second entity should be unchanged
      expect(entity2!.data.fields.title).not.toBe("Modified");
    });

    it("clears dirty flag after materialization", async () => {
      const { store, actionLog, dirtyTracker } = await makeStore();
      await actionLog.append(action);
      await dirtyTracker.mark("todo_1", "todo");

      expect(await dirtyTracker.isDirty("todo_1")).toBe(true);
      await store.get("todo_1");
      expect(await dirtyTracker.isDirty("todo_1")).toBe(false);
    });
  });

  describe("set", () => {
    it("stores entity directly", async () => {
      const { store } = await makeStore();
      await store.set({
        id: "todo_2",
        type: "todo",
        data: { fields: { title: { value: "Direct", update_id: "u_direct" } } },
        created_hlc: "1711036800000",
        updated_hlc: "1711036800000",
        deleted_hlc: null,
        last_gsn: 0,
      });

      const entity = await store.get("todo_2");
      expect(entity).not.toBe(null);
      expect(entity!.id).toBe("todo_2");
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

    it("materializes dirty entities on query", async () => {
      const { store, actionLog, dirtyTracker } = await makeStore();
      await actionLog.append(action);
      await dirtyTracker.mark("todo_1", "todo");

      expect(await dirtyTracker.isDirty("todo_1")).toBe(true);
      const entities = await store.query("todo");
      expect(await dirtyTracker.isDirty("todo_1")).toBe(false);
      expect(entities).toHaveLength(1);
    });

    it("returns empty array for unknown type", async () => {
      const { store } = await makeStore();
      const entities = await store.query("unknown");
      expect(entities).toEqual([]);
    });
  });

  describe("reset", () => {
    it("clears all entities", async () => {
      const { store, actionLog, dirtyTracker } = await makeStore();
      await actionLog.append(action);
      await dirtyTracker.mark("todo_1", "todo");
      await store.get("todo_1");

      await store.reset();

      const entity = await store.get("todo_1");
      expect(entity).toBe(null);
    });
  });
});
