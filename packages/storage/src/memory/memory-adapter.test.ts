import { describe, it, expect } from "vitest";
import { createMemoryAdapter } from "./memory-adapter";
import { makeHlc, type Action } from "@ebbjs/core";

describe("MemoryAdapter", () => {
  const action: Action = {
    id: "a_1",
    actor_id: "a_user1",
    hlc: makeHlc(1711036800000),
    gsn: 1,
    updates: [
      {
        id: "u_1",
        subject_id: "todo_1",
        subject_type: "todo",
        method: "put",
        data: {
          fields: { title: { value: "Hello", update_id: "u_1", hlc: makeHlc(1711036800000) } },
        },
      },
    ],
  };

  const action2: Action = {
    id: "a_2",
    actor_id: "a_user1",
    hlc: makeHlc(1711036800000, 1),
    gsn: 2,
    updates: [
      {
        id: "u_2",
        subject_id: "todo_1",
        subject_type: "todo",
        method: "patch",
        data: {
          fields: {
            title: { value: "Updated", update_id: "u_2", hlc: makeHlc(1711036800000, 1) },
          },
        },
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

      (entity1 as { data: { fields: Record<string, unknown> } }).data.fields.title = {
        value: "Modified",
      };
      expect((entity2!.data.fields.title as { value: unknown }).value).not.toBe("Modified");
    });

    it("clears dirty flag after get", async () => {
      const adapter = createMemoryAdapter();
      await adapter.actions.append(action);
      expect(await adapter.isDirty("todo_1")).toBe(true);

      await adapter.entities.get("todo_1");
      expect(await adapter.isDirty("todo_1")).toBe(false);
    });

    it("applies a patch update to an existing entity", async () => {
      // The patch's fields merge into `data.fields` rather than nesting
      // a second `fields` envelope, so `data.fields.title` is the field
      // itself.
      const adapter = createMemoryAdapter();
      await adapter.actions.append(action);
      const before = await adapter.entities.get("todo_1");
      expect((before!.data.fields.title as { value: unknown }).value).toBe("Hello");

      await adapter.actions.append(action2);
      const after = await adapter.entities.get("todo_1");

      expect(after).not.toBe(null);
      expect(after!.data.fields).toHaveProperty("title");
      expect((after!.data.fields.title as { value: unknown }).value).toBe("Updated");
      expect(after!.data.fields).not.toHaveProperty("fields");
    });

    it("preserves packed BigInt HLCs through a put→patch sequence (issue #80)", async () => {
      // Asserts the materialized field's HLC equals the packed fixture HLC.
      const adapter = createMemoryAdapter();
      await adapter.actions.append(action);
      await adapter.actions.append(action2);

      const after = await adapter.entities.get("todo_1");
      expect(after).not.toBe(null);
      expect((after!.data.fields.title as { hlc?: string }).hlc).toBe(makeHlc(1711036800000, 1));
    });

    it("materializes a system entity (groupMember) with its fields nested under data.fields", async () => {
      // `groupMember` PUTs carry the same `{ fields: ... }` envelope as
      // user entities. The materializer unwraps it once, so the
      // system entity's fields land at `data.fields` the same way a
      // `todo` PUT's do.
      const groupMemberAction: Action = {
        id: "a_gm",
        actor_id: "a_user1",
        hlc: makeHlc(1711036800000),
        gsn: 1,
        updates: [
          {
            id: "u_gm",
            subject_id: "gm_1",
            subject_type: "groupMember",
            method: "put",
            data: {
              fields: {
                actor_id: {
                  value: "a_user1",
                  update_id: "u_gm",
                  hlc: makeHlc(1711036800000),
                },
                group_id: { value: "grp_1", update_id: "u_gm", hlc: makeHlc(1711036800000) },
              },
            },
          },
        ],
      };

      const adapter = createMemoryAdapter();
      await adapter.actions.append(groupMemberAction);

      const entity = await adapter.entities.get("gm_1");
      expect(entity).not.toBe(null);
      expect(entity!.data.fields).toHaveProperty("actor_id");
      expect(entity!.data.fields).toHaveProperty("group_id");
      expect(entity!.data.fields).not.toHaveProperty("fields");
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
