import { describe, expect, it } from "vitest";
import { makeHlc, type Entity } from "@ebbjs/core";
import type { ActionLog } from "../types/action-log";
import type { DirtyTracker } from "../types/dirty-tracker";
import type { EntityStore } from "../types/entity-store";
import { buildPatchAction, buildPutAction } from "./fixtures";

export interface EntityStoreTestSuiteHarness {
  actionLog: ActionLog;
  dirtyTracker: DirtyTracker;
  entityStore: EntityStore;
}

export interface EntityStoreTestSuiteOptions {
  name: string;
  factory: () => Promise<EntityStoreTestSuiteHarness> | EntityStoreTestSuiteHarness;
}

const makeEntity = (overrides: Partial<Entity> = {}): Entity => ({
  id: "todo_2",
  type: "todo",
  data: { fields: { title: { value: "Direct", update_id: "u_direct", hlc: makeHlc(1) } } },
  created_hlc: makeHlc(1),
  updated_hlc: makeHlc(1),
  deleted_hlc: null,
  last_gsn: 0,
  ...overrides,
});

export const defineEntityStoreTests = ({ name, factory }: EntityStoreTestSuiteOptions): void => {
  describe(`${name} EntityStore`, () => {
    describe("get", () => {
      it("returns null for unknown entity", async () => {
        const { entityStore } = await factory();
        const entity = await entityStore.get("unknown");
        expect(entity).toBe(null);
      });

      it("materializes dirty entity on get", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(buildPutAction());
        await dirtyTracker.mark("todo_1", "todo");

        const entity = await entityStore.get("todo_1");
        expect(entity).not.toBe(null);
        expect(entity!.id).toBe("todo_1");
        expect(entity!.type).toBe("todo");
        expect(entity!.last_gsn).toBe(1);
      });

      it("returns copy to prevent mutation", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(buildPutAction());
        await dirtyTracker.mark("todo_1", "todo");

        const entity1 = await entityStore.get("todo_1");
        const entity2 = await entityStore.get("todo_1");

        (entity1 as { data: { fields: Record<string, unknown> } }).data.fields.title = "Modified";
        expect(entity2!.data.fields.title).not.toBe("Modified");
      });

      it("clears dirty flag after materialization", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(buildPutAction());
        await dirtyTracker.mark("todo_1", "todo");

        expect(await dirtyTracker.isDirty("todo_1")).toBe(true);
        await entityStore.get("todo_1");
        expect(await dirtyTracker.isDirty("todo_1")).toBe(false);
      });

      it("applies a patch update to an existing entity (LWW merge)", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(buildPutAction());
        await dirtyTracker.mark("todo_1", "todo");
        const before = await entityStore.get("todo_1");
        expect((before!.data.fields.title as { value: unknown }).value).toBe("Hello");

        await actionLog.append(buildPatchAction());
        await dirtyTracker.mark("todo_1", "todo");

        const after = await entityStore.get("todo_1");

        expect(after).not.toBe(null);
        expect((after!.data.fields.title as { value: unknown }).value).toBe("Updated");
        expect(after!.data.fields).not.toHaveProperty("fields");
      });
    });

    describe("set", () => {
      it("stores entity directly", async () => {
        const { entityStore } = await factory();
        await entityStore.set(makeEntity());

        const entity = await entityStore.get("todo_2");
        expect(entity).not.toBe(null);
        expect(entity!.id).toBe("todo_2");
      });
    });

    describe("query", () => {
      it("returns all entities of type", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(buildPutAction());
        await dirtyTracker.mark("todo_1", "todo");

        const entities = await entityStore.query("todo");
        expect(entities).toHaveLength(1);
        expect(entities[0].id).toBe("todo_1");
      });

      it("materializes dirty entities on query", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(buildPutAction());
        await dirtyTracker.mark("todo_1", "todo");

        expect(await dirtyTracker.isDirty("todo_1")).toBe(true);
        const entities = await entityStore.query("todo");
        expect(await dirtyTracker.isDirty("todo_1")).toBe(false);
        expect(entities).toHaveLength(1);
      });

      it("returns empty array for unknown type", async () => {
        const { entityStore } = await factory();
        const entities = await entityStore.query("unknown");
        expect(entities).toEqual([]);
      });

      it("returns only entities of the requested type", async () => {
        const { entityStore } = await factory();
        await entityStore.set(makeEntity({ id: "todo_1", type: "todo" }));
        await entityStore.set(makeEntity({ id: "doc_1", type: "document" }));

        const todos = await entityStore.query("todo");
        expect(todos.map((e) => e.id)).toEqual(["todo_1"]);

        const docs = await entityStore.query("document");
        expect(docs.map((e) => e.id)).toEqual(["doc_1"]);
      });
    });

    describe("reset", () => {
      it("clears all entities", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(buildPutAction());
        await dirtyTracker.mark("todo_1", "todo");
        await entityStore.get("todo_1");

        await entityStore.reset();

        const entity = await entityStore.get("todo_1");
        expect(entity).toBe(null);
      });
    });
  });
};
