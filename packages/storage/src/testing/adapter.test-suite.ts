import { describe, expect, it } from "vitest";
import { makeHlc, type Action } from "@ebbjs/core";
import type { StorageAdapter } from "../types/storage-adapter";
import { buildConflictEntry, buildPatchAction, buildPutAction } from "./fixtures";

export interface AdapterTestSuiteOptions {
  name: string;
  factory: () => Promise<StorageAdapter> | StorageAdapter;
}

export const defineAdapterTests = ({ name, factory }: AdapterTestSuiteOptions): void => {
  describe(`${name} StorageAdapter`, () => {
    describe("actions.append", () => {
      it("stores action", async () => {
        const adapter = await factory();
        const action = buildPutAction();
        await adapter.actions.append(action);

        const actions = await adapter.actions.getAll();
        expect(actions).toEqual([action]);
      });

      it("marks affected entities dirty", async () => {
        const adapter = await factory();
        await adapter.actions.append(buildPutAction());

        const dirty = await adapter.isDirty("todo_1");
        expect(dirty).toBe(true);
      });

      it("accumulates multiple actions in insertion order", async () => {
        const adapter = await factory();
        const a1 = buildPutAction();
        const a2 = buildPatchAction();
        await adapter.actions.append(a1);
        await adapter.actions.append(a2);

        const actions = await adapter.actions.getAll();
        expect(actions).toHaveLength(2);
        expect(actions[0].id).toBe("a_1");
        expect(actions[1].id).toBe("a_2");
      });
    });

    describe("actions.getAll", () => {
      it("returns empty array when no actions appended", async () => {
        const adapter = await factory();
        const actions = await adapter.actions.getAll();
        expect(actions).toEqual([]);
      });
    });

    describe("actions.getForEntity", () => {
      it("returns actions touching a specific entity sorted by gsn", async () => {
        const adapter = await factory();
        await adapter.actions.append(buildPatchAction());
        await adapter.actions.append(buildPutAction());

        const actions = await adapter.actions.getForEntity("todo_1");
        expect(actions.map((a: Action) => a.gsn)).toEqual([1, 2]);
      });
    });

    describe("entities.get", () => {
      it("returns null for unknown entity", async () => {
        const adapter = await factory();
        const entity = await adapter.entities.get("unknown");
        expect(entity).toBe(null);
      });

      it("materializes dirty entity on get", async () => {
        const adapter = await factory();
        await adapter.actions.append(buildPutAction());

        const entity = await adapter.entities.get("todo_1");
        expect(entity).not.toBe(null);
        expect(entity!.id).toBe("todo_1");
        expect(entity!.type).toBe("todo");
      });

      it("returns copy to prevent mutation", async () => {
        const adapter = await factory();
        await adapter.actions.append(buildPutAction());

        const entity1 = await adapter.entities.get("todo_1");
        const entity2 = await adapter.entities.get("todo_1");

        (entity1 as { data: { fields: Record<string, unknown> } }).data.fields.title = {
          value: "Modified",
        };
        expect((entity2!.data.fields.title as { value: unknown }).value).not.toBe("Modified");
      });

      it("clears dirty flag after get", async () => {
        const adapter = await factory();
        await adapter.actions.append(buildPutAction());
        expect(await adapter.isDirty("todo_1")).toBe(true);

        await adapter.entities.get("todo_1");
        expect(await adapter.isDirty("todo_1")).toBe(false);
      });

      it("applies a patch update to an existing entity", async () => {
        const adapter = await factory();
        await adapter.actions.append(buildPutAction());
        const before = await adapter.entities.get("todo_1");
        expect((before!.data.fields.title as { value: unknown }).value).toBe("Hello");

        await adapter.actions.append(buildPatchAction());
        const after = await adapter.entities.get("todo_1");

        expect(after).not.toBe(null);
        expect((after!.data.fields.title as { value: unknown }).value).toBe("Updated");
        expect(after!.data.fields).not.toHaveProperty("fields");
      });

      it("preserves packed BigInt HLCs through a put→patch sequence (issue #80)", async () => {
        const adapter = await factory();
        await adapter.actions.append(buildPutAction());
        await adapter.actions.append(buildPatchAction());

        const after = await adapter.entities.get("todo_1");
        expect(after).not.toBe(null);
        expect((after!.data.fields.title as { hlc?: string }).hlc).toBe(makeHlc(1711036800000, 1));
      });
    });

    describe("entities.query", () => {
      it("returns all entities of type", async () => {
        const adapter = await factory();
        await adapter.actions.append(buildPutAction());

        const entities = await adapter.entities.query("todo");
        expect(entities).toHaveLength(1);
        expect(entities[0].id).toBe("todo_1");
      });

      it("materializes dirty entities on query", async () => {
        const adapter = await factory();
        await adapter.actions.append(buildPutAction());
        expect(await adapter.isDirty("todo_1")).toBe(true);

        await adapter.entities.query("todo");
        expect(await adapter.isDirty("todo_1")).toBe(false);
      });

      it("returns empty for unknown type", async () => {
        const adapter = await factory();
        const entities = await adapter.entities.query("unknown");
        expect(entities).toEqual([]);
      });
    });

    describe("cursors", () => {
      it("returns null for unknown group", async () => {
        const adapter = await factory();
        const cursor = await adapter.cursors.get("group_1");
        expect(cursor).toBe(null);
      });

      it("stores and retrieves cursor", async () => {
        const adapter = await factory();
        await adapter.cursors.set("group_1", 100);
        const cursor = await adapter.cursors.get("group_1");
        expect(cursor).toBe(100);
      });

      it("updates existing cursor", async () => {
        const adapter = await factory();
        await adapter.cursors.set("group_1", 100);
        await adapter.cursors.set("group_1", 200);
        const cursor = await adapter.cursors.get("group_1");
        expect(cursor).toBe(200);
      });

      it("supports multiple groups independently", async () => {
        const adapter = await factory();
        await adapter.cursors.set("group_1", 100);
        await adapter.cursors.set("group_2", 200);
        expect(await adapter.cursors.get("group_1")).toBe(100);
        expect(await adapter.cursors.get("group_2")).toBe(200);
      });
    });

    describe("dirtyTracker direct API", () => {
      it("clear removes dirty flag without touching action log", async () => {
        const adapter = await factory();
        await adapter.actions.append(buildPutAction());
        expect(await adapter.isDirty("todo_1")).toBe(true);

        await adapter.dirtyTracker.clear("todo_1");
        expect(await adapter.isDirty("todo_1")).toBe(false);

        const actions = await adapter.actions.getAll();
        expect(actions).toHaveLength(1);
      });

      it("getDirtyForType lists entities for a type", async () => {
        const adapter = await factory();
        await adapter.dirtyTracker.mark("todo_1", "todo");
        await adapter.dirtyTracker.mark("todo_2", "todo");
        await adapter.dirtyTracker.mark("doc_1", "document");

        const dirty = await adapter.dirtyTracker.getDirtyForType("todo");
        expect(dirty).toHaveLength(2);
        expect(dirty).toContain("todo_1");
        expect(dirty).toContain("todo_2");
      });
    });

    describe("reset", () => {
      it("clears all actions", async () => {
        const adapter = await factory();
        await adapter.actions.append(buildPutAction());
        await adapter.reset();

        const actions = await adapter.actions.getAll();
        expect(actions).toEqual([]);
      });

      it("clears all dirty state", async () => {
        const adapter = await factory();
        await adapter.actions.append(buildPutAction());
        expect(await adapter.isDirty("todo_1")).toBe(true);

        await adapter.reset();
        expect(await adapter.isDirty("todo_1")).toBe(false);
      });

      it("clears all entities", async () => {
        const adapter = await factory();
        await adapter.actions.append(buildPutAction());
        await adapter.entities.get("todo_1");

        await adapter.reset();
        const entity = await adapter.entities.get("todo_1");
        expect(entity).toBe(null);
      });
    });

    describe("conflicts", () => {
      it("stores and reads back a conflict", async () => {
        const adapter = await factory();
        const entry = buildConflictEntry();
        await adapter.conflicts.put(entry);

        expect(await adapter.conflicts.get("a_1")).toEqual(entry);
      });

      it("keeps conflicts across a reset", async () => {
        const adapter = await factory();
        const entry = buildConflictEntry();
        await adapter.conflicts.put(entry);

        await adapter.reset();

        expect(await adapter.conflicts.get("a_1")).toEqual(entry);
      });
    });
  });
};
