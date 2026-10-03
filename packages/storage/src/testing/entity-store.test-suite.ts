import { describe, expect, it } from "vitest";
import { makeHlc, type Entity } from "@ebbjs/core";
import type { ActionLog } from "../types/action-log";
import type { DirtyTracker } from "../types/dirty-tracker";
import type { EntityStore } from "../types/entity-store";
import {
  buildPatchAction,
  buildPutAction,
  buildRelationshipDeleteAction,
  buildRelationshipPatchAction,
  buildRelationshipPutAction,
  buildRelationshipRetargetAction,
} from "./fixtures";

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

/** A materialized Relationship row, for direct `set()` writes. */
const makeRelationshipEntity = (
  overrides: {
    id?: string;
    sourceId?: string;
    targetId?: string;
    field?: string;
    type?: string;
    deleted?: string | null;
  } = {},
): Entity => {
  const id = overrides.id ?? "rel_2";
  const updateId = `u_${id}`;
  const field = (value: string) => ({ value, update_id: updateId, hlc: makeHlc(1) });

  return {
    id,
    type: "relationship",
    data: {
      fields: {
        source_id: field(overrides.sourceId ?? "todo_1"),
        target_id: field(overrides.targetId ?? "list_1"),
        type: field(overrides.type ?? "todo_list"),
        field: field(overrides.field ?? "list"),
        kind: field("link"),
      },
    },
    created_hlc: makeHlc(1),
    updated_hlc: makeHlc(1),
    deleted_hlc: overrides.deleted ?? null,
    last_gsn: 0,
  };
};

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

    describe("queryByRelationship", () => {
      const listQuery = (entityStore: EntityStore) =>
        entityStore.queryByRelationship({ as: "list", type: "todo_list", targetId: "list_1" });

      const seedListEdge = async (
        actionLog: ActionLog,
        dirtyTracker: DirtyTracker,
        row: {
          id: string;
          sourceId: string;
          targetId?: string;
          field?: string;
          type?: string;
        },
      ): Promise<void> => {
        await actionLog.append(
          buildRelationshipPutAction({
            id: row.id,
            sourceId: row.sourceId,
            targetId: row.targetId ?? "list_1",
            field: row.field ?? "list",
            type: row.type ?? "todo_list",
          }),
        );
        await dirtyTracker.mark(row.id, "relationship");
      };

      it("returns source ids for a (field, type, target_id) triple", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedListEdge(actionLog, dirtyTracker, { id: "rel_1", sourceId: "todo_1" });

        expect(await listQuery(entityStore)).toEqual(["todo_1"]);
      });

      it("materializes dirty relationship rows on query", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedListEdge(actionLog, dirtyTracker, { id: "rel_1", sourceId: "todo_1" });
        expect(await dirtyTracker.isDirty("rel_1")).toBe(true);

        await listQuery(entityStore);
        expect(await dirtyTracker.isDirty("rel_1")).toBe(false);
      });

      it("returns every distinct source targeting the same id in ascending order", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedListEdge(actionLog, dirtyTracker, { id: "rel_b", sourceId: "todo_b" });
        await seedListEdge(actionLog, dirtyTracker, { id: "rel_a", sourceId: "todo_a" });
        await seedListEdge(actionLog, dirtyTracker, { id: "rel_b2", sourceId: "todo_b" });

        expect(await listQuery(entityStore)).toEqual(["todo_a", "todo_b"]);
      });

      it("returns empty for an unknown triple", async () => {
        const { entityStore } = await factory();
        expect(await listQuery(entityStore)).toEqual([]);
      });

      it("does not match a different accessor, type, or target", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedListEdge(actionLog, dirtyTracker, { id: "rel_1", sourceId: "todo_1" });

        expect(
          await entityStore.queryByRelationship({
            as: "owner",
            type: "todo_list",
            targetId: "list_1",
          }),
        ).toEqual([]);
        expect(
          await entityStore.queryByRelationship({
            as: "list",
            type: "todo_user",
            targetId: "list_1",
          }),
        ).toEqual([]);
        expect(
          await entityStore.queryByRelationship({
            as: "list",
            type: "todo_list",
            targetId: "list_2",
          }),
        ).toEqual([]);
      });

      it("drops the source when the row is tombstoned", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedListEdge(actionLog, dirtyTracker, { id: "rel_1", sourceId: "todo_1" });
        expect(await listQuery(entityStore)).toEqual(["todo_1"]);

        await actionLog.append(buildRelationshipDeleteAction({ id: "rel_1" }, 2));
        await dirtyTracker.mark("rel_1", "relationship");

        expect(await listQuery(entityStore)).toEqual([]);
      });

      it("moves the source when a patch re-targets the row", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedListEdge(actionLog, dirtyTracker, { id: "rel_1", sourceId: "todo_1" });
        expect(await listQuery(entityStore)).toEqual(["todo_1"]);

        await actionLog.append(
          buildRelationshipRetargetAction({ id: "rel_1", targetId: "list_2" }, 2),
        );
        await dirtyTracker.mark("rel_1", "relationship");

        expect(await listQuery(entityStore)).toEqual([]);
        expect(
          await entityStore.queryByRelationship({
            as: "list",
            type: "todo_list",
            targetId: "list_2",
          }),
        ).toEqual(["todo_1"]);
      });

      it("keeps a source while any row with the same natural key is live", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedListEdge(actionLog, dirtyTracker, { id: "rel_b", sourceId: "todo_b" });
        await seedListEdge(actionLog, dirtyTracker, { id: "rel_b2", sourceId: "todo_b" });
        expect(await listQuery(entityStore)).toEqual(["todo_b"]);

        await actionLog.append(buildRelationshipDeleteAction({ id: "rel_b" }, 2));
        await dirtyTracker.mark("rel_b", "relationship");
        expect(await listQuery(entityStore)).toEqual(["todo_b"]);

        await actionLog.append(buildRelationshipDeleteAction({ id: "rel_b2" }, 3));
        await dirtyTracker.mark("rel_b2", "relationship");
        expect(await listQuery(entityStore)).toEqual([]);
      });

      it("moves the source when a patch changes the accessor field", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedListEdge(actionLog, dirtyTracker, { id: "rel_1", sourceId: "todo_1" });
        expect(await listQuery(entityStore)).toEqual(["todo_1"]);

        await actionLog.append(buildRelationshipPatchAction({ id: "rel_1", field: "owner" }, 2));
        await dirtyTracker.mark("rel_1", "relationship");

        expect(await listQuery(entityStore)).toEqual([]);
        expect(
          await entityStore.queryByRelationship({
            as: "owner",
            type: "todo_list",
            targetId: "list_1",
          }),
        ).toEqual(["todo_1"]);
      });

      it("moves the source when a patch changes the relationship type", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedListEdge(actionLog, dirtyTracker, { id: "rel_1", sourceId: "todo_1" });
        expect(await listQuery(entityStore)).toEqual(["todo_1"]);

        await actionLog.append(buildRelationshipPatchAction({ id: "rel_1", type: "todo_user" }, 2));
        await dirtyTracker.mark("rel_1", "relationship");

        expect(await listQuery(entityStore)).toEqual([]);
        expect(
          await entityStore.queryByRelationship({
            as: "list",
            type: "todo_user",
            targetId: "list_1",
          }),
        ).toEqual(["todo_1"]);
      });

      it("re-keys the source when a patch changes the source id", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedListEdge(actionLog, dirtyTracker, { id: "rel_1", sourceId: "todo_1" });

        await actionLog.append(
          buildRelationshipPatchAction({ id: "rel_1", sourceId: "todo_2" }, 2),
        );
        await dirtyTracker.mark("rel_1", "relationship");

        expect(await listQuery(entityStore)).toEqual(["todo_2"]);
      });

      it("drops the source from its new key when a mutated row is tombstoned", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedListEdge(actionLog, dirtyTracker, { id: "rel_1", sourceId: "todo_1" });
        await actionLog.append(
          buildRelationshipPatchAction(
            { id: "rel_1", sourceId: "todo_2", field: "owner", type: "todo_user" },
            2,
          ),
        );
        await dirtyTracker.mark("rel_1", "relationship");

        const newKey = { as: "owner", type: "todo_user", targetId: "list_1" };
        expect(await entityStore.queryByRelationship(newKey)).toEqual(["todo_2"]);

        await actionLog.append(buildRelationshipDeleteAction({ id: "rel_1" }, 3));
        await dirtyTracker.mark("rel_1", "relationship");

        expect(await entityStore.queryByRelationship(newKey)).toEqual([]);
        expect(await listQuery(entityStore)).toEqual([]);
      });

      it("indexes rows written through set()", async () => {
        const { entityStore } = await factory();
        await entityStore.set(
          makeRelationshipEntity({ id: "rel_2", sourceId: "todo_2", targetId: "list_1" }),
        );

        expect(await listQuery(entityStore)).toEqual(["todo_2"]);
      });

      it("drops the source when set() tombstones the row", async () => {
        const { entityStore } = await factory();
        await entityStore.set(
          makeRelationshipEntity({ id: "rel_2", sourceId: "todo_2", targetId: "list_1" }),
        );
        expect(await listQuery(entityStore)).toEqual(["todo_2"]);

        await entityStore.set(
          makeRelationshipEntity({
            id: "rel_2",
            sourceId: "todo_2",
            targetId: "list_1",
            deleted: makeHlc(2),
          }),
        );

        expect(await listQuery(entityStore)).toEqual([]);
      });

      it("moves the source when set() changes the accessor field", async () => {
        const { entityStore } = await factory();
        await entityStore.set(
          makeRelationshipEntity({ id: "rel_2", sourceId: "todo_2", targetId: "list_1" }),
        );
        expect(await listQuery(entityStore)).toEqual(["todo_2"]);

        await entityStore.set(
          makeRelationshipEntity({
            id: "rel_2",
            sourceId: "todo_2",
            targetId: "list_1",
            field: "owner",
          }),
        );

        expect(await listQuery(entityStore)).toEqual([]);
        expect(
          await entityStore.queryByRelationship({
            as: "owner",
            type: "todo_list",
            targetId: "list_1",
          }),
        ).toEqual(["todo_2"]);
      });

      it("moves the source when set() changes the relationship type", async () => {
        const { entityStore } = await factory();
        await entityStore.set(
          makeRelationshipEntity({ id: "rel_2", sourceId: "todo_2", targetId: "list_1" }),
        );
        expect(await listQuery(entityStore)).toEqual(["todo_2"]);

        await entityStore.set(
          makeRelationshipEntity({
            id: "rel_2",
            sourceId: "todo_2",
            targetId: "list_1",
            type: "todo_user",
          }),
        );

        expect(await listQuery(entityStore)).toEqual([]);
        expect(
          await entityStore.queryByRelationship({
            as: "list",
            type: "todo_user",
            targetId: "list_1",
          }),
        ).toEqual(["todo_2"]);
      });

      it("re-keys the source when set() changes the source id", async () => {
        const { entityStore } = await factory();
        await entityStore.set(
          makeRelationshipEntity({ id: "rel_2", sourceId: "todo_2", targetId: "list_1" }),
        );

        await entityStore.set(
          makeRelationshipEntity({ id: "rel_2", sourceId: "todo_3", targetId: "list_1" }),
        );

        expect(await listQuery(entityStore)).toEqual(["todo_3"]);
      });

      it("drops the source from its new key when a mutated set() row is tombstoned", async () => {
        const { entityStore } = await factory();
        const mutated = {
          id: "rel_2",
          sourceId: "todo_2",
          targetId: "list_1",
          field: "owner",
          type: "todo_user",
        };
        await entityStore.set(
          makeRelationshipEntity({ id: "rel_2", sourceId: "todo_2", targetId: "list_1" }),
        );
        await entityStore.set(makeRelationshipEntity(mutated));

        const newKey = { as: "owner", type: "todo_user", targetId: "list_1" };
        expect(await entityStore.queryByRelationship(newKey)).toEqual(["todo_2"]);

        await entityStore.set(makeRelationshipEntity({ ...mutated, deleted: makeHlc(2) }));

        expect(await entityStore.queryByRelationship(newKey)).toEqual([]);
      });

      it("does not index non-relationship entities that carry the same field names", async () => {
        const { entityStore } = await factory();
        await entityStore.set({
          ...makeEntity({ id: "todo_9", type: "todo" }),
          data: {
            fields: {
              source_id: { value: "todo_9", update_id: "u_9" },
              target_id: { value: "list_1", update_id: "u_9" },
              type: { value: "todo_list", update_id: "u_9" },
              field: { value: "list", update_id: "u_9" },
            },
          },
        });

        expect(await listQuery(entityStore)).toEqual([]);
      });

      it("clears the index on reset", async () => {
        const { entityStore } = await factory();
        await entityStore.set(
          makeRelationshipEntity({ id: "rel_2", sourceId: "todo_2", targetId: "list_1" }),
        );
        expect(await listQuery(entityStore)).toEqual(["todo_2"]);

        await entityStore.reset();

        expect(await listQuery(entityStore)).toEqual([]);
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
