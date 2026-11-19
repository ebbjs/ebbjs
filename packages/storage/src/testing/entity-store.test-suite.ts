import { describe, expect, it } from "vitest";
import {
  componentName,
  isFieldMap,
  makeHlc,
  type Action,
  type Entity,
  type FieldValue,
  type Update,
} from "@ebbjs/core";
import { isShardedMapField } from "../internal/map-field";
import type { ActionLog } from "../types/action-log";
import type { DirtyTracker } from "../types/dirty-tracker";
import type { EntityStore } from "../types/entity-store";
import {
  buildCreateAction,
  buildLinkAction,
  buildMembershipDeleteAction,
  buildMembershipPutAction,
  buildPatchAction,
  buildPutAction,
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
  model: "todo",
  data: { fields: { title: { value: "Direct", update_id: "u_direct", hlc: makeHlc(1) } } },
  exists: true,
  created_hlc: makeHlc(1),
  updated_hlc: makeHlc(1),
  deleted_hlc: null,
  last_gsn: 0,
  ...overrides,
});

/** One `todo` component Update per field a fixture writes. */
const todoComponentUpdates = (
  updateId: string,
  fields: Record<string, FieldValue>,
  method: "merge" | "replace",
): Update[] =>
  Object.entries(fields).map(([field, value]) => ({
    id: `${updateId}_${field}`,
    subject_id: "todo_1",
    component: componentName("todo", field),
    method,
    data: value,
  }));

/**
 * A write for `todo_1` carrying an arbitrary field map, one `merge` per
 * component. Map-field tests build their leaf/map values with the helpers
 * below so the nested shape stays readable.
 */
const buildFieldsPatch = (
  updateId: string,
  fields: Record<string, FieldValue>,
  hlc: string,
  gsn: number,
): Action => ({
  id: `a_${updateId}`,
  actor_id: "a_user1",
  hlc,
  gsn,
  updates: todoComponentUpdates(updateId, fields, "merge"),
});

/** A leaf field value at `hlc`, carrying `updateId` as its tiebreak id. */
const leaf = (value: unknown, updateId: string, hlc: string): FieldValue => ({
  value,
  update_id: updateId,
  hlc,
});

/** A map field value wrapping the given entries. */
const map = (entries: Record<string, FieldValue>): FieldValue => ({ map: entries });

/**
 * A whole-row write for `todo_1`: its create, then `replace` per leaf
 * component and `merge` per keyed one, the shape a create (or a backfill
 * snapshot) emits.
 */
const buildRowPutAction = (
  updateId: string,
  fields: Record<string, FieldValue>,
  hlc: string,
  gsn: number,
): Action => ({
  id: `a_${updateId}`,
  actor_id: "a_user1",
  hlc,
  gsn,
  updates: [
    {
      id: `${updateId}_create`,
      subject_id: "todo_1",
      model: "todo",
      method: "create",
      hlc,
      data: null,
    },
    ...Object.entries(fields).map(([field, value]) => ({
      id: `${updateId}_${field}`,
      subject_id: "todo_1",
      component: componentName("todo", field),
      method: isFieldMap(value) ? ("merge" as const) : ("replace" as const),
      data: value,
    })),
  ],
});

/**
 * The link nesting a fixture builds, exported through the same helper the
 * fixtures use so an entity's `ebb/link` value stays one shape in the suite.
 */
const linkComponentValue = (leaves: LinkLeaves): FieldValue => ({
  map: Object.fromEntries(
    Object.entries(leaves).map(([as, byType]) => [
      as,
      {
        map: Object.fromEntries(
          Object.entries(byType).map(([type, byTarget]) => [type, { map: byTarget }]),
        ),
      },
    ]),
  ),
});

type LinkLeaves = Record<string, Record<string, Record<string, FieldValue>>>;

/** A materialized row carrying one live `ebb/link` edge, for `set()` writes. */
const makeLinkEntity = (
  overrides: {
    id?: string;
    model?: string;
    as?: string;
    type?: string;
    targetId?: string;
    deleted?: string | null;
  } = {},
): Entity => {
  const id = overrides.id ?? "todo_2";
  const as = overrides.as ?? "list";
  const type = overrides.type ?? "todo_list";
  const targetId = overrides.targetId ?? "list_1";

  return {
    id,
    model: overrides.model ?? "todo",
    data: {
      fields: {
        link: linkComponentValue({
          [as]: { [type]: { [targetId]: leaf(true, `u_${id}`, makeHlc(1)) } },
        }),
      },
    },
    exists: true,
    created_hlc: makeHlc(1),
    updated_hlc: makeHlc(1),
    deleted_hlc: overrides.deleted ?? null,
    last_gsn: 0,
  };
};

/** A materialized `ebb/membership` row, for direct `set()` writes. */
const makeMembershipEntity = (
  overrides: {
    id?: string;
    entityId?: string;
    groupId?: string;
    deleted?: string | null;
  } = {},
): Entity => {
  const id = overrides.id ?? "eg_2";

  return {
    id,
    model: "ebb",
    data: {
      fields: {
        membership: {
          value: {
            entity_id: overrides.entityId ?? "todo_1",
            group_id: overrides.groupId ?? "group_1",
          },
          update_id: `u_${id}`,
          hlc: makeHlc(1),
        },
      },
    },
    exists: true,
    created_hlc: makeHlc(1),
    updated_hlc: makeHlc(1),
    deleted_hlc: overrides.deleted ?? null,
    last_gsn: 0,
  };
};

/** Append a link write for one source row and mark that row dirty. */
const seedLink = async (
  actionLog: ActionLog,
  dirtyTracker: DirtyTracker,
  row: {
    sourceId: string;
    model?: string;
    targetId?: string;
    as?: string;
    type?: string;
    present?: boolean;
    /** Orders writes to the same source: the action id and the leaf stamps. */
    gsn?: number;
  },
): Promise<void> => {
  const model = row.model ?? "todo";
  const edge = {
    as: row.as ?? "list",
    type: row.type ?? "todo_list",
    targetId: row.targetId ?? "list_1",
  };
  await actionLog.append(
    buildLinkAction(
      {
        sourceId: row.sourceId,
        model,
        present: row.present === false ? [] : [edge],
        removed: row.present === false ? [edge] : [],
      },
      row.gsn ?? 1,
    ),
  );
  await dirtyTracker.mark(row.sourceId, model);
};

/** Append an `ebb/membership` put and mark its row dirty. */
const seedMembership = async (
  actionLog: ActionLog,
  dirtyTracker: DirtyTracker,
  row: { id: string; entityId: string; groupId: string },
): Promise<void> => {
  await actionLog.append(
    buildMembershipPutAction({ id: row.id, entityId: row.entityId, groupId: row.groupId }),
  );
  await dirtyTracker.mark(row.id, "ebb");
};

/** A whole-row write for an arbitrary row: its create, then one component Update per field. */
const buildRowAction = (
  rowId: string,
  type: string,
  updateId: string,
  fields: Record<string, FieldValue>,
  hlc: string,
  gsn: number,
): Action => ({
  id: `a_${updateId}`,
  actor_id: "a_user1",
  hlc,
  gsn,
  updates: [
    {
      id: `${updateId}_create`,
      subject_id: rowId,
      model: type,
      method: "create",
      hlc,
      data: null,
    },
    ...Object.entries(fields).map(([field, value]) => ({
      id: `${updateId}_${field}`,
      subject_id: rowId,
      component: componentName(type, field),
      method: isFieldMap(value) ? ("merge" as const) : ("replace" as const),
      data: value,
    })),
  ],
});

const buildRowDeleteAction = (rowId: string, hlc: string, gsn: number): Action => ({
  id: `a_del_${rowId}`,
  actor_id: "a_user1",
  hlc,
  gsn,
  updates: [{ id: `u_del_${rowId}`, subject_id: rowId, method: "delete", data: null }],
});

const buildRowDropAction = (
  rowId: string,
  type: string,
  field: string,
  hlc: string,
  gsn: number,
): Action => ({
  id: `a_drop_${rowId}_${field}`,
  actor_id: "a_user1",
  hlc,
  gsn,
  updates: [
    {
      id: `u_drop_${rowId}_${field}`,
      subject_id: rowId,
      component: componentName(type, field),
      method: "drop",
      data: null,
    },
  ],
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
        expect(entity!.model).toBe("todo");
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

      it("creates a placeholder from a merge with no base row", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        // Per-Update delivery (#473) can hand a group a component write whose
        // row's create stayed in another group. The write lands in a
        // placeholder that waits for the base and is a backfill candidate.
        await actionLog.append(buildPatchAction());
        await dirtyTracker.mark("todo_1", "todo");

        const created = await entityStore.get("todo_1");
        expect(created!.model).toBe("todo");
        expect((created!.data.fields.title as { value: unknown }).value).toBe("Updated");
        expect(created!.exists).toBe(false);
        expect(created!.created_hlc).toBe(null);

        await actionLog.append(buildCreateAction());
        await dirtyTracker.mark("todo_1", "todo");
        const entity = await entityStore.get("todo_1");
        expect((entity!.data.fields.title as { value: unknown }).value).toBe("Updated");
        expect(entity!.exists).toBe(true);
        expect(entity!.created_hlc).toBe(buildCreateAction().hlc);
      });

      it("keeps a placeholder's model when an ebb/* overlay lands on it", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        // A link write can arrive before the row's create (#789). It adds a
        // component and never names a model: a placeholder that a user write
        // already typed stays that model, and one carrying only the overlay is
        // committed under `ebb`.
        await actionLog.append(
          buildFieldsPatch("u_1", { title: leaf("Ship", "u_1_title", makeHlc(1)) }, makeHlc(1), 1),
        );
        await actionLog.append(
          buildLinkAction(
            {
              sourceId: "todo_1",
              model: "todo",
              present: [{ as: "list", type: "todo_list", targetId: "list_1" }],
              create: false,
            },
            2,
          ),
        );
        await dirtyTracker.mark("todo_1", "todo");

        const row = await entityStore.get("todo_1");
        expect(row!.model).toBe("todo");
        expect(row!.exists).toBe(false);
        expect(
          await entityStore.queryByRelationship({
            as: "list",
            type: "todo_list",
            targetId: "list_1",
          }),
        ).toEqual(["todo_1"]);
      });

      it("leaves a placeholder's model unknown when only an overlay lands on it", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        // An `ebb/*` overlay never supplies a model: the
        // row keeps it unknown until the create arrives rather than claiming
        // `ebb` and showing up in that model's reads.
        await actionLog.append(
          buildLinkAction(
            {
              sourceId: "todo_1",
              model: "todo",
              present: [{ as: "list", type: "todo_list", targetId: "list_1" }],
              create: false,
            },
            1,
          ),
        );
        await dirtyTracker.mark("todo_1", "todo");

        const row = await entityStore.get("todo_1");
        expect(row!.exists).toBe(false);
        expect(row!.model).toBe("");
        expect(await entityStore.query("ebb")).toEqual([]);
        expect(
          await entityStore.queryByRelationship({
            as: "list",
            type: "todo_list",
            targetId: "list_1",
          }),
        ).toEqual(["todo_1"]);
      });

      it("materializes a create's row with no components", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(buildCreateAction());
        await dirtyTracker.mark("todo_1", "todo");

        const created = await entityStore.get("todo_1");

        expect(created).not.toBe(null);
        expect(created!.model).toBe("todo");
        expect(created!.data.fields).toEqual({});
        expect(created!.exists).toBe(true);
        expect(created!.created_hlc).toBe(buildCreateAction().hlc);
        expect(await entityStore.queryByComponent("todo/title")).toEqual([]);
      });

      it("keeps a live row after its last component is dropped", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(buildPutAction());
        await actionLog.append(buildRowDropAction("todo_1", "todo", "title", makeHlc(2), 2));
        await dirtyTracker.mark("todo_1", "todo");

        const row = await entityStore.get("todo_1");

        expect(row).not.toBe(null);
        expect(row!.exists).toBe(true);
        expect(row!.data.fields).toEqual({});
      });

      it("returns a live zero-component row from a fresh replay", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(buildPutAction());
        await actionLog.append(buildRowDropAction("todo_1", "todo", "title", makeHlc(2), 2));
        await entityStore.reset();
        await dirtyTracker.mark("todo_1", "todo");

        const row = await entityStore.get("todo_1");

        expect(row).not.toBe(null);
        expect(row!.exists).toBe(true);
        expect(row!.created_hlc).not.toBe(null);
        expect(row!.data.fields).toEqual({});
      });
    });

    describe("updated_hlc", () => {
      it("advances to the patch HLC when the patch is later", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        const put = buildPutAction();
        const patch = buildPatchAction();
        await actionLog.append(put);
        await actionLog.append(patch);
        await dirtyTracker.mark("todo_1", "todo");

        const entity = await entityStore.get("todo_1");

        expect(entity!.updated_hlc).toBe(patch.hlc);
      });

      it("keeps the later HLC when a patch arrives out of order", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        const put = buildPutAction(5);
        const olderPatch = buildPatchAction(2);
        await actionLog.append(put);
        await actionLog.append(olderPatch);
        await dirtyTracker.mark("todo_1", "todo");

        const entity = await entityStore.get("todo_1");

        expect(entity!.updated_hlc).toBe(put.hlc);
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

    describe("map fields", () => {
      it("keeps writes to different keys from concurrent patches", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        const hlcA = makeHlc(100);
        const hlcB = makeHlc(200);
        await actionLog.append(buildPutAction());
        await actionLog.append(
          buildFieldsPatch("u_a", { content: map({ a: leaf(1, "u_a", hlcA) }) }, hlcA, 2),
        );
        await actionLog.append(
          buildFieldsPatch("u_b", { content: map({ b: leaf(2, "u_b", hlcB) }) }, hlcB, 3),
        );
        await dirtyTracker.mark("todo_1", "todo");

        const entity = await entityStore.get("todo_1");

        expect(entity!.data.fields.content).toEqual({
          map: { a: leaf(1, "u_a", hlcA), b: leaf(2, "u_b", hlcB) },
        });
      });

      it("resolves the same key by HLC regardless of patch order", async () => {
        const older = makeHlc(100);
        const newer = makeHlc(200);
        const first = buildFieldsPatch(
          "u_old",
          { content: map({ a: leaf("old", "u_old", older) }) },
          older,
          2,
        );
        const second = buildFieldsPatch(
          "u_new",
          { content: map({ a: leaf("new", "u_new", newer) }) },
          newer,
          3,
        );

        for (const order of [
          [first, second],
          [second, first],
        ]) {
          const { actionLog, dirtyTracker, entityStore } = await factory();
          await actionLog.append(buildPutAction());
          for (const action of order) await actionLog.append(action);
          await dirtyTracker.mark("todo_1", "todo");

          const entity = await entityStore.get("todo_1");

          expect(entity!.data.fields.content).toEqual({
            map: { a: leaf("new", "u_new", newer) },
          });
        }
      });

      it("breaks equal-HLC keys toward the higher update_id", async () => {
        const hlc = makeHlc(100);
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(buildPutAction());
        await actionLog.append(
          buildFieldsPatch("u_aaa", { content: map({ a: leaf("a", "u_aaa", hlc) }) }, hlc, 2),
        );
        await actionLog.append(
          buildFieldsPatch("u_zzz", { content: map({ a: leaf("z", "u_zzz", hlc) }) }, hlc, 3),
        );
        await dirtyTracker.mark("todo_1", "todo");

        const entity = await entityStore.get("todo_1");

        expect(entity!.data.fields.content).toEqual({ map: { a: leaf("z", "u_zzz", hlc) } });
      });

      it("retains a tombstoned key in storage", async () => {
        const hlcA = makeHlc(100);
        const hlcB = makeHlc(200);
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(buildPutAction());
        await actionLog.append(
          buildFieldsPatch("u_a", { content: map({ a: leaf(1, "u_a", hlcA) }) }, hlcA, 2),
        );
        await actionLog.append(
          buildFieldsPatch("u_del", { content: map({ a: leaf(null, "u_del", hlcB) }) }, hlcB, 3),
        );
        await dirtyTracker.mark("todo_1", "todo");

        const entity = await entityStore.get("todo_1");
        const content = entity!.data.fields.content;
        if (!isFieldMap(content)) throw new Error("expected a map field");

        expect(content.map.a).toEqual(leaf(null, "u_del", hlcB));
      });

      it("merges nested maps key by key", async () => {
        const hlcA = makeHlc(100);
        const hlcB = makeHlc(200);
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(buildPutAction());
        await actionLog.append(
          buildFieldsPatch(
            "u_a",
            { content: map({ outer: map({ inner: leaf(1, "u_a", hlcA) }) }) },
            hlcA,
            2,
          ),
        );
        await actionLog.append(
          buildFieldsPatch(
            "u_b",
            { content: map({ outer: map({ other: leaf(2, "u_b", hlcB) }) }) },
            hlcB,
            3,
          ),
        );
        await dirtyTracker.mark("todo_1", "todo");

        const entity = await entityStore.get("todo_1");

        expect(entity!.data.fields.content).toEqual({
          map: {
            outer: map({ inner: leaf(1, "u_a", hlcA), other: leaf(2, "u_b", hlcB) }),
          },
        });
      });

      it("keeps a map above the shard flip point flat across a store round-trip", async () => {
        const hlc = makeHlc(100);
        const { actionLog, dirtyTracker, entityStore } = await factory();
        const entries = Object.fromEntries(
          Array.from({ length: 600 }, (_, index) => [
            `run_${index}`,
            leaf(index, `u_${index}`, hlc),
          ]),
        );
        await actionLog.append(buildRowPutAction("u_big", { content: map(entries) }, hlc, 1));
        await dirtyTracker.mark("todo_1", "todo");

        const entity = await entityStore.get("todo_1");
        const content = entity!.data.fields.content;
        if (!isFieldMap(content)) throw new Error("expected a map field");

        // The legacy adapters keep the plain wire shape; the sharded
        // container is the replica's resident representation only.
        expect(isShardedMapField(content)).toBe(false);
        expect(Object.keys(content.map)).toHaveLength(600);
        expect(content.map.run_0).toEqual(leaf(0, "u_0", hlc));
      });

      it("unions a whole-row map write key by key, never replacing a key space", async () => {
        const hlcA = makeHlc(100);
        const hlcB = makeHlc(200);
        const hlcC = makeHlc(300);
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(buildPutAction());
        await actionLog.append(
          buildFieldsPatch("u_a", { content: map({ a: leaf(1, "u_a", hlcA) }) }, hlcA, 2),
        );
        await actionLog.append(
          buildFieldsPatch("u_b", { content: map({ b: leaf(2, "u_b", hlcB) }) }, hlcB, 3),
        );
        await actionLog.append(
          buildRowPutAction("u_c", { content: map({ c: leaf(3, "u_c", hlcC) }) }, hlcC, 4),
        );
        await dirtyTracker.mark("todo_1", "todo");

        const entity = await entityStore.get("todo_1");

        expect(entity!.data.fields.content).toEqual({
          map: { a: leaf(1, "u_a", hlcA), b: leaf(2, "u_b", hlcB), c: leaf(3, "u_c", hlcC) },
        });
      });
    });

    describe("query", () => {
      it("returns all entities of model", async () => {
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
        await entityStore.set(makeEntity({ id: "todo_1", model: "todo" }));
        await entityStore.set(makeEntity({ id: "doc_1", model: "document" }));

        const todos = await entityStore.query("todo");
        expect(todos.map((e) => e.id)).toEqual(["todo_1"]);

        const docs = await entityStore.query("document");
        expect(docs.map((e) => e.id)).toEqual(["doc_1"]);
      });
    });

    describe("queryByComponent", () => {
      it("returns the live ids carrying a component, ascending", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        const hlc = makeHlc(100);
        await actionLog.append(
          buildRowAction("todo_b", "todo", "u_b", { title: leaf("b", "u_b", hlc) }, hlc, 1),
        );
        await actionLog.append(
          buildRowAction("todo_a", "todo", "u_a", { title: leaf("a", "u_a", hlc) }, hlc, 2),
        );
        await actionLog.append(
          buildRowAction("todo_c", "todo", "u_c", { title: leaf("c", "u_c", hlc) }, hlc, 3),
        );
        await actionLog.append(
          buildRowAction("todo_c", "todo", "u_c2", { status: leaf("open", "u_c2", hlc) }, hlc, 4),
        );
        await dirtyTracker.mark("todo_a", "todo");
        await dirtyTracker.mark("todo_b", "todo");
        await dirtyTracker.mark("todo_c", "todo");

        expect(await entityStore.queryByComponent("todo/title")).toEqual([
          "todo_a",
          "todo_b",
          "todo_c",
        ]);
        expect(await entityStore.queryByComponent("todo/status")).toEqual(["todo_c"]);
      });

      it("materializes the component's model before reading the index", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(buildPutAction());
        await dirtyTracker.mark("todo_1", "todo");
        expect(await dirtyTracker.isDirty("todo_1")).toBe(true);

        expect(await entityStore.queryByComponent("todo/title")).toEqual(["todo_1"]);
        expect(await dirtyTracker.isDirty("todo_1")).toBe(false);
      });

      it("materializes a user row carrying a platform component", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        // An `ebb/*` overlay leaves the row's committed model alone, so a
        // component read cannot materialize one model's dirty rows and find it.
        await actionLog.append(
          buildLinkAction({
            sourceId: "note_1",
            model: "note",
            present: [{ as: "list", type: "note_list", targetId: "list_1" }],
          }),
        );
        await dirtyTracker.mark("note_1", "note");
        expect(await dirtyTracker.isDirty("note_1")).toBe(true);

        expect(await entityStore.queryByComponent("ebb/link")).toEqual(["note_1"]);
        expect(await dirtyTracker.isDirty("note_1")).toBe(false);
      });

      it("does not index a platform component under the row's model", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(
          buildLinkAction({
            sourceId: "note_1",
            model: "note",
            present: [{ as: "list", type: "note_list", targetId: "list_1" }],
          }),
        );
        await dirtyTracker.mark("note_1", "note");

        expect(await entityStore.queryByComponent("ebb/link")).toEqual(["note_1"]);
        expect(await entityStore.queryByComponent("note/link")).toEqual([]);
      });

      it("returns empty for a component nothing carries", async () => {
        const { entityStore } = await factory();
        expect(await entityStore.queryByComponent("todo/missing")).toEqual([]);
      });

      it("returns empty for a model it has no rows of", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(buildPutAction());
        await dirtyTracker.mark("todo_1", "todo");
        await entityStore.queryByComponent("todo/title");

        expect(await entityStore.queryByComponent("note/title")).toEqual([]);
      });

      it("omits a tombstoned row's components", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(buildPutAction());
        await dirtyTracker.mark("todo_1", "todo");
        expect(await entityStore.queryByComponent("todo/title")).toEqual(["todo_1"]);

        await actionLog.append(buildRowDeleteAction("todo_1", makeHlc(200), 2));
        await dirtyTracker.mark("todo_1", "todo");

        expect(await entityStore.queryByComponent("todo/title")).toEqual([]);
      });

      it("omits a component a drop detached and keeps its siblings", async () => {
        const hlc = makeHlc(100);
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(
          buildRowAction(
            "todo_1",
            "todo",
            "u_1",
            { title: leaf("a", "u_1", hlc), draft: leaf("d", "u_1_draft", hlc) },
            hlc,
            1,
          ),
        );
        await dirtyTracker.mark("todo_1", "todo");
        expect(await entityStore.queryByComponent("todo/draft")).toEqual(["todo_1"]);

        await actionLog.append(buildRowDropAction("todo_1", "todo", "draft", makeHlc(200), 2));
        await dirtyTracker.mark("todo_1", "todo");

        expect(await entityStore.queryByComponent("todo/draft")).toEqual([]);
        expect(await entityStore.queryByComponent("todo/title")).toEqual(["todo_1"]);
      });

      it("indexes rows written through set()", async () => {
        const { entityStore } = await factory();
        await entityStore.set(makeEntity({ id: "todo_2" }));

        expect(await entityStore.queryByComponent("todo/title")).toEqual(["todo_2"]);
      });

      it("drops the components of a row set() tombstones", async () => {
        const { entityStore } = await factory();
        await entityStore.set(makeEntity({ id: "todo_2" }));
        expect(await entityStore.queryByComponent("todo/title")).toEqual(["todo_2"]);

        await entityStore.set(makeEntity({ id: "todo_2", deleted_hlc: makeHlc(2) }));

        expect(await entityStore.queryByComponent("todo/title")).toEqual([]);
      });

      it("clears the index on reset", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await actionLog.append(buildPutAction());
        await dirtyTracker.mark("todo_1", "todo");
        expect(await entityStore.queryByComponent("todo/title")).toEqual(["todo_1"]);

        await entityStore.reset();

        expect(await entityStore.queryByComponent("todo/title")).toEqual([]);
      });
    });

    describe("queryByRelationship", () => {
      const listQuery = (entityStore: EntityStore) =>
        entityStore.queryByRelationship({ as: "list", type: "todo_list", targetId: "list_1" });

      it("returns source ids for a (field, type, target_id) triple", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedLink(actionLog, dirtyTracker, { sourceId: "todo_1" });

        expect(await listQuery(entityStore)).toEqual(["todo_1"]);
      });

      it("materializes dirty source rows of any model on query", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        // A link is a key of its source row's component, so the row carrying
        // it is a `note`, not an `ebb` row: the reverse read cannot narrow to
        // one model without missing it.
        await seedLink(actionLog, dirtyTracker, { sourceId: "note_1", model: "note" });
        expect(await dirtyTracker.isDirty("note_1")).toBe(true);

        expect(await listQuery(entityStore)).toEqual(["note_1"]);
        expect(await dirtyTracker.isDirty("note_1")).toBe(false);
      });

      it("returns every distinct source targeting the same id in ascending order", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedLink(actionLog, dirtyTracker, { sourceId: "todo_b" });
        await seedLink(actionLog, dirtyTracker, { sourceId: "todo_a" });
        await seedLink(actionLog, dirtyTracker, { sourceId: "note_c", model: "note" });

        expect(await listQuery(entityStore)).toEqual(["note_c", "todo_a", "todo_b"]);
      });

      it("returns empty for an unknown triple", async () => {
        const { entityStore } = await factory();
        expect(await listQuery(entityStore)).toEqual([]);
      });

      it("does not match a different accessor, type, or target", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedLink(actionLog, dirtyTracker, { sourceId: "todo_1" });

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

      it("drops the source when the edge's key is tombstoned", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedLink(actionLog, dirtyTracker, { sourceId: "todo_1" });
        expect(await listQuery(entityStore)).toEqual(["todo_1"]);

        await seedLink(actionLog, dirtyTracker, { sourceId: "todo_1", present: false, gsn: 2 });

        expect(await listQuery(entityStore)).toEqual([]);
      });

      it("drops one edge's key and keeps its siblings", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedLink(actionLog, dirtyTracker, { sourceId: "todo_1", targetId: "list_1" });
        await seedLink(actionLog, dirtyTracker, { sourceId: "todo_1", targetId: "list_2" });

        await seedLink(actionLog, dirtyTracker, { sourceId: "todo_1", present: false, gsn: 2 });

        expect(await listQuery(entityStore)).toEqual([]);
        expect(
          await entityStore.queryByRelationship({
            as: "list",
            type: "todo_list",
            targetId: "list_2",
          }),
        ).toEqual(["todo_1"]);
      });

      it("drops the source when the row carrying the edge is tombstoned", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedLink(actionLog, dirtyTracker, { sourceId: "todo_1" });
        expect(await listQuery(entityStore)).toEqual(["todo_1"]);

        await actionLog.append(buildRowDeleteAction("todo_1", makeHlc(200), 2));
        await dirtyTracker.mark("todo_1", "todo");

        expect(await listQuery(entityStore)).toEqual([]);
      });

      it("moves the edge when a re-put moves the source row", async () => {
        // A source row is its own identity, so the same row id cannot move:
        // a second source naming the same target is what a move looks like.
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedLink(actionLog, dirtyTracker, { sourceId: "todo_1" });
        await seedLink(actionLog, dirtyTracker, { sourceId: "todo_2" });

        expect(await listQuery(entityStore)).toEqual(["todo_1", "todo_2"]);
      });

      it("indexes rows written through set()", async () => {
        const { entityStore } = await factory();
        await entityStore.set(makeLinkEntity({ id: "todo_2" }));

        expect(await listQuery(entityStore)).toEqual(["todo_2"]);
      });

      it("drops the source when set() tombstones the row", async () => {
        const { entityStore } = await factory();
        await entityStore.set(makeLinkEntity({ id: "todo_2" }));
        expect(await listQuery(entityStore)).toEqual(["todo_2"]);

        await entityStore.set(makeLinkEntity({ id: "todo_2", deleted: makeHlc(2) }));

        expect(await listQuery(entityStore)).toEqual([]);
      });

      it("does not index a user field that happens to be named link", async () => {
        const { entityStore } = await factory();
        // A leaf under `link` is a user value, not the keyed component: only
        // presence leaves at `(<as>, <type>, <target>)` are edges.
        await entityStore.set({
          ...makeEntity({ id: "todo_9", model: "todo" }),
          data: { fields: { link: leaf("https://example.test", "u_9", makeHlc(1)) } },
        });

        expect(await listQuery(entityStore)).toEqual([]);
      });

      it("clears the index on reset", async () => {
        const { entityStore } = await factory();
        await entityStore.set(makeLinkEntity({ id: "todo_2" }));
        expect(await listQuery(entityStore)).toEqual(["todo_2"]);

        await entityStore.reset();

        expect(await listQuery(entityStore)).toEqual([]);
      });
    });

    describe("queryByMembership", () => {
      it("returns member entity ids for a group id", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedMembership(actionLog, dirtyTracker, {
          id: "eg_1",
          entityId: "todo_1",
          groupId: "group_1",
        });

        expect(await entityStore.queryByMembership("group_1")).toEqual(["todo_1"]);
      });

      it("materializes dirty ebb/membership rows on query", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedMembership(actionLog, dirtyTracker, {
          id: "eg_1",
          entityId: "todo_1",
          groupId: "group_1",
        });
        expect(await dirtyTracker.isDirty("eg_1")).toBe(true);

        await entityStore.queryByMembership("group_1");
        expect(await dirtyTracker.isDirty("eg_1")).toBe(false);
      });

      it("returns every distinct member targeting the group in ascending order", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedMembership(actionLog, dirtyTracker, {
          id: "eg_b",
          entityId: "todo_b",
          groupId: "group_1",
        });
        await seedMembership(actionLog, dirtyTracker, {
          id: "eg_a",
          entityId: "todo_a",
          groupId: "group_1",
        });
        await seedMembership(actionLog, dirtyTracker, {
          id: "eg_b2",
          entityId: "todo_b",
          groupId: "group_1",
        });

        expect(await entityStore.queryByMembership("group_1")).toEqual(["todo_a", "todo_b"]);
      });

      it("returns empty for an unknown group", async () => {
        const { entityStore } = await factory();
        expect(await entityStore.queryByMembership("group_unknown")).toEqual([]);
      });

      it("does not match a different group", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedMembership(actionLog, dirtyTracker, {
          id: "eg_1",
          entityId: "todo_1",
          groupId: "group_1",
        });

        expect(await entityStore.queryByMembership("group_2")).toEqual([]);
      });

      it("drops the member when a delete action tombstones the row", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedMembership(actionLog, dirtyTracker, {
          id: "eg_1",
          entityId: "todo_1",
          groupId: "group_1",
        });
        expect(await entityStore.queryByMembership("group_1")).toEqual(["todo_1"]);

        await actionLog.append(buildMembershipDeleteAction({ id: "eg_1" }, 2));
        await dirtyTracker.mark("eg_1", "ebb");

        expect(await entityStore.queryByMembership("group_1")).toEqual([]);
      });

      it("drops the member when set() tombstones the row", async () => {
        const { entityStore } = await factory();
        await entityStore.set(makeMembershipEntity({ id: "eg_2", entityId: "todo_2" }));
        expect(await entityStore.queryByMembership("group_1")).toEqual(["todo_2"]);

        await entityStore.set(
          makeMembershipEntity({ id: "eg_2", entityId: "todo_2", deleted: makeHlc(2) }),
        );

        expect(await entityStore.queryByMembership("group_1")).toEqual([]);
      });

      it("re-keys the member when a re-put changes the row's ids", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedMembership(actionLog, dirtyTracker, {
          id: "eg_1",
          entityId: "todo_1",
          groupId: "group_1",
        });
        expect(await entityStore.queryByMembership("group_1")).toEqual(["todo_1"]);

        await actionLog.append(
          buildMembershipPutAction({ id: "eg_1", entityId: "todo_2", groupId: "group_2" }, 2),
        );
        await dirtyTracker.mark("eg_1", "ebb");

        expect(await entityStore.queryByMembership("group_1")).toEqual([]);
        expect(await entityStore.queryByMembership("group_2")).toEqual(["todo_2"]);
      });

      it("keeps a member while any duplicate row with the same ids is live", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedMembership(actionLog, dirtyTracker, {
          id: "eg_b",
          entityId: "todo_b",
          groupId: "group_1",
        });
        await seedMembership(actionLog, dirtyTracker, {
          id: "eg_b2",
          entityId: "todo_b",
          groupId: "group_1",
        });
        expect(await entityStore.queryByMembership("group_1")).toEqual(["todo_b"]);

        await actionLog.append(buildMembershipDeleteAction({ id: "eg_b" }, 2));
        await dirtyTracker.mark("eg_b", "ebb");
        expect(await entityStore.queryByMembership("group_1")).toEqual(["todo_b"]);

        await actionLog.append(buildMembershipDeleteAction({ id: "eg_b2" }, 3));
        await dirtyTracker.mark("eg_b2", "ebb");
        expect(await entityStore.queryByMembership("group_1")).toEqual([]);
      });

      it("indexes rows written through set()", async () => {
        const { entityStore } = await factory();
        await entityStore.set(
          makeMembershipEntity({ id: "eg_2", entityId: "todo_2", groupId: "group_1" }),
        );

        expect(await entityStore.queryByMembership("group_1")).toEqual(["todo_2"]);
      });

      it("moves the member when set() changes group_id", async () => {
        const { entityStore } = await factory();
        await entityStore.set(
          makeMembershipEntity({ id: "eg_2", entityId: "todo_2", groupId: "group_1" }),
        );

        await entityStore.set(
          makeMembershipEntity({ id: "eg_2", entityId: "todo_2", groupId: "group_2" }),
        );

        expect(await entityStore.queryByMembership("group_1")).toEqual([]);
        expect(await entityStore.queryByMembership("group_2")).toEqual(["todo_2"]);
      });

      it("does not index rows without the membership component that carry the same field names", async () => {
        const { entityStore } = await factory();
        await entityStore.set({
          ...makeEntity({ id: "todo_9", model: "todo" }),
          data: {
            fields: {
              entity_id: { value: "todo_9", update_id: "u_9" },
              group_id: { value: "group_1", update_id: "u_9" },
            },
          },
        });

        expect(await entityStore.queryByMembership("group_1")).toEqual([]);
      });

      it("clears the membership index on reset", async () => {
        const { entityStore } = await factory();
        await entityStore.set(
          makeMembershipEntity({ id: "eg_2", entityId: "todo_2", groupId: "group_1" }),
        );
        expect(await entityStore.queryByMembership("group_1")).toEqual(["todo_2"]);

        await entityStore.reset();

        expect(await entityStore.queryByMembership("group_1")).toEqual([]);
      });
    });

    describe("queryByMembershipEntity", () => {
      const entityQuery = (entityStore: EntityStore) =>
        entityStore.queryByMembershipEntity("todo_1");

      it("returns the membership row id and group id for a member entity", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedMembership(actionLog, dirtyTracker, {
          id: "eg_1",
          entityId: "todo_1",
          groupId: "group_1",
        });

        expect(await entityQuery(entityStore)).toEqual([
          { membershipId: "eg_1", groupId: "group_1" },
        ]);
      });

      it("materializes dirty ebb/membership rows on query", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedMembership(actionLog, dirtyTracker, {
          id: "eg_1",
          entityId: "todo_1",
          groupId: "group_1",
        });
        expect(await dirtyTracker.isDirty("eg_1")).toBe(true);

        await entityQuery(entityStore);
        expect(await dirtyTracker.isDirty("eg_1")).toBe(false);
      });

      it("returns every live membership, ascending by group", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedMembership(actionLog, dirtyTracker, {
          id: "eg_b",
          entityId: "todo_1",
          groupId: "group_b",
        });
        await seedMembership(actionLog, dirtyTracker, {
          id: "eg_a",
          entityId: "todo_1",
          groupId: "group_a",
        });

        expect(await entityQuery(entityStore)).toEqual([
          { membershipId: "eg_a", groupId: "group_a" },
          { membershipId: "eg_b", groupId: "group_b" },
        ]);
      });

      it("keeps a duplicate membership row while any row with the same ids is live", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedMembership(actionLog, dirtyTracker, {
          id: "eg_1",
          entityId: "todo_1",
          groupId: "group_1",
        });
        await seedMembership(actionLog, dirtyTracker, {
          id: "eg_2",
          entityId: "todo_1",
          groupId: "group_1",
        });
        expect((await entityQuery(entityStore)).map((m) => m.membershipId)).toEqual([
          "eg_1",
          "eg_2",
        ]);

        await actionLog.append(buildMembershipDeleteAction({ id: "eg_1" }, 2));
        await dirtyTracker.mark("eg_1", "ebb");
        expect((await entityQuery(entityStore)).map((m) => m.membershipId)).toEqual(["eg_2"]);

        await actionLog.append(buildMembershipDeleteAction({ id: "eg_2" }, 3));
        await dirtyTracker.mark("eg_2", "ebb");
        expect(await entityQuery(entityStore)).toEqual([]);
      });

      it("re-keys the membership when a patch changes entity_id", async () => {
        const { actionLog, dirtyTracker, entityStore } = await factory();
        await seedMembership(actionLog, dirtyTracker, {
          id: "eg_1",
          entityId: "todo_1",
          groupId: "group_1",
        });

        await actionLog.append(
          buildMembershipPutAction({ id: "eg_1", entityId: "todo_2", groupId: "group_1" }, 2),
        );
        await dirtyTracker.mark("eg_1", "ebb");

        expect(await entityQuery(entityStore)).toEqual([]);
        expect(await entityStore.queryByMembershipEntity("todo_2")).toEqual([
          { membershipId: "eg_1", groupId: "group_1" },
        ]);
      });

      it("keeps the member key out of the group key space when an entity equals a group", async () => {
        const { entityStore } = await factory();
        // `group_1` is both a group and a member entity id.
        await entityStore.set(
          makeMembershipEntity({ id: "eg_member", entityId: "group_1", groupId: "group_2" }),
        );
        await entityStore.set(
          makeMembershipEntity({ id: "eg_group", entityId: "todo_1", groupId: "group_1" }),
        );

        expect(await entityStore.queryByMembership("group_1")).toEqual(["todo_1"]);
        expect(await entityStore.queryByMembershipEntity("group_1")).toEqual([
          { membershipId: "eg_member", groupId: "group_2" },
        ]);
      });

      it("clears the member index on reset", async () => {
        const { entityStore } = await factory();
        await entityStore.set(
          makeMembershipEntity({ id: "eg_2", entityId: "todo_1", groupId: "group_1" }),
        );
        expect(await entityQuery(entityStore)).toEqual([
          { membershipId: "eg_2", groupId: "group_1" },
        ]);

        await entityStore.reset();

        expect(await entityQuery(entityStore)).toEqual([]);
      });
    });

    describe("per-Update delivery (#473)", () => {
      /**
       * One logical Action that moves a membership from `eg_old` to
       * `eg_new`, split into two delivered copies by each Update's own
       * group scope. Both copies keep the Action's id and GSN.
       */
      const moveAction = (): Action => {
        const put = buildMembershipPutAction(
          { id: "eg_new", entityId: "todo_1", groupId: "group_new" },
          7,
        );
        const del = buildMembershipDeleteAction({ id: "eg_old" }, 7);
        return { ...put, updates: [...put.updates, ...del.updates] };
      };

      it("delivers the new group the put and the old group the delete, neither crashing", async () => {
        const action = moveAction();
        const newGroupCopy: Action = {
          ...action,
          updates: action.updates.filter((update) => update.subject_id === "eg_new"),
        };
        const oldGroupCopy: Action = {
          ...action,
          updates: action.updates.filter((update) => update.subject_id === "eg_old"),
        };

        // The new group's subscriber receives only the put.
        const newGroup = await factory();
        await newGroup.actionLog.append(newGroupCopy);
        await newGroup.dirtyTracker.mark("eg_new", "ebb");
        const materialized = await newGroup.entityStore.get("eg_new");
        expect(materialized).not.toBeNull();
        // The row the split delivered is the one the new group is scoped to.
        expect(await newGroup.entityStore.queryByMembership("group_new")).toEqual(["todo_1"]);

        // The old group's subscriber receives only the delete. It never
        // materialized `eg_old`, so the delete must be a no-op rather
        // than a stream-breaking throw.
        const oldGroup = await factory();
        await oldGroup.actionLog.append(oldGroupCopy);
        await oldGroup.dirtyTracker.mark("eg_old", "ebb");
        await expect(oldGroup.entityStore.get("eg_old")).resolves.toBeNull();

        // Re-delivery of a copy is idempotent: the same put leaves the
        // row in place and the same delete leaves it absent.
        await newGroup.actionLog.append(newGroupCopy);
        await newGroup.dirtyTracker.mark("eg_new", "ebb");
        expect(await newGroup.entityStore.get("eg_new")).toEqual(materialized);
        await oldGroup.actionLog.append(oldGroupCopy);
        await oldGroup.dirtyTracker.mark("eg_old", "ebb");
        await expect(oldGroup.entityStore.get("eg_old")).resolves.toBeNull();
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
