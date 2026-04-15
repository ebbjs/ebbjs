import { describe, it, expect } from "vitest";
import { createMemoryAdapter } from "./memory-adapter";
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
        data: { title: { value: "Hello", update_id: "u_1", hlc: "1711036800000" } },
      },
    ],
  };

  const action2: Action = {
    id: "a_2",
    actor_id: "a_user1",
    hlc: "1711036800001",
    gsn: 2,
    updates: [
      {
        id: "u_2",
        subject_id: "todo_1",
        subject_type: "todo",
        method: "patch",
        data: { title: { value: "Updated", update_id: "u_2", hlc: "1711036800001" } },
      },
    ],
  };

  describe("actions.append", () => {
    it("stores action", async () => {
      const adapter = createMemoryAdapter();
      await adapter.actions.append(action);

      const actions = await adapter.actions.getAll();
      expect(actions).toEqual([action]);
    });

    it("marks affected entities dirty", async () => {
      const adapter = createMemoryAdapter();
      await adapter.actions.append(action);

      const dirty = await adapter.isDirty("todo_1");
      expect(dirty).toBe(true);
    });

    it("accumulates multiple actions", async () => {
      const adapter = createMemoryAdapter();
      await adapter.actions.append(action);
      await adapter.actions.append(action2);

      const actions = await adapter.actions.getAll();
      expect(actions).toHaveLength(2);
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
      expect(entity!.id).toBe("todo_1");
      expect(entity!.type).toBe("todo");
    });

    it("returns copy to prevent mutation", async () => {
      const adapter = createMemoryAdapter();
      await adapter.actions.append(action);

      const entity1 = await adapter.entities.get("todo_1");
      const entity2 = await adapter.entities.get("todo_1");

      (entity1 as { data: { fields: Record<string, unknown> } }).data.fields.title = "Modified";
      expect(entity2!.data.fields.title).not.toBe("Modified");
    });

    it("clears dirty flag after get", async () => {
      const adapter = createMemoryAdapter();
      await adapter.actions.append(action);
      expect(await adapter.isDirty("todo_1")).toBe(true);

      await adapter.entities.get("todo_1");
      expect(await adapter.isDirty("todo_1")).toBe(false);
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

    it("materializes dirty entities on query", async () => {
      const adapter = createMemoryAdapter();
      await adapter.actions.append(action);
      expect(await adapter.isDirty("todo_1")).toBe(true);

      await adapter.entities.query("todo");
      expect(await adapter.isDirty("todo_1")).toBe(false);
    });

    it("returns empty for unknown type", async () => {
      const adapter = createMemoryAdapter();
      const entities = await adapter.entities.query("unknown");
      expect(entities).toEqual([]);
    });
  });

  describe("cursors", () => {
    it("stores and retrieves cursor", async () => {
      const adapter = createMemoryAdapter();
      await adapter.cursors.set("group_1", 100);
      const cursor = await adapter.cursors.get("group_1");
      expect(cursor).toBe(100);
    });

    it("updates existing cursor", async () => {
      const adapter = createMemoryAdapter();
      await adapter.cursors.set("group_1", 100);
      await adapter.cursors.set("group_1", 200);
      const cursor = await adapter.cursors.get("group_1");
      expect(cursor).toBe(200);
    });
  });

  describe("reset", () => {
    it("clears all actions", async () => {
      const adapter = createMemoryAdapter();
      await adapter.actions.append(action);
      await adapter.reset();

      const actions = await adapter.actions.getAll();
      expect(actions).toEqual([]);
    });

    it("clears all dirty state", async () => {
      const adapter = createMemoryAdapter();
      await adapter.actions.append(action);
      expect(await adapter.isDirty("todo_1")).toBe(true);

      await adapter.reset();
      expect(await adapter.isDirty("todo_1")).toBe(false);
    });

    it("clears all entities", async () => {
      const adapter = createMemoryAdapter();
      await adapter.actions.append(action);
      await adapter.entities.get("todo_1");

      await adapter.reset();
      const entity = await adapter.entities.get("todo_1");
      expect(entity).toBe(null);
    });
  });
});
