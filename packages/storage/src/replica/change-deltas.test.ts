import { describe, expect, it } from "vitest";
import {
  componentName,
  ebbComponent,
  isFieldMap,
  makeHlc,
  type Action,
  type ComponentName,
  type FieldValue,
  type Update,
} from "@ebbjs/core";

import { createReplica } from "./replica";
import type { Replica } from "./types";

/**
 * Fixtures for the journal's index delta: the edges, component existence and
 * membership groups a change moved, which the post-change row cannot show.
 */

const leaf = (value: unknown, updateId: string, ms: number): FieldValue => ({
  value,
  update_id: updateId,
  hlc: makeHlc(ms),
});

interface WriteSpec {
  readonly actionId: string;
  readonly updateId: string;
  readonly entityId: string;
  readonly model: string;
  readonly gsn?: number;
  readonly ms?: number;
  readonly fields: Record<string, FieldValue>;
  /** The component a keyed (map) field is written under; `ebb/link` for edges. */
  readonly keyedComponent?: ComponentName;
}

/** One component Update per fixture field; a keyed component always merges. */
const componentUpdates = (spec: WriteSpec, method: "merge" | "replace"): Update[] =>
  Object.entries(spec.fields).map(([field, value]) => {
    const keyed = isFieldMap(value);
    return {
      id: `${spec.updateId}_${field}`,
      subject_id: spec.entityId,
      component: keyed
        ? (spec.keyedComponent ?? componentName(spec.model, field))
        : componentName(spec.model, field),
      method: keyed ? "merge" : method,
      data: value,
    };
  });

/** A row put: the row's create, then one `replace` (or keyed `merge`) per field. */
const put = (spec: WriteSpec): Action => {
  const hlc = makeHlc(spec.ms ?? 1);
  return {
    id: spec.actionId,
    actor_id: "user_1",
    hlc,
    gsn: spec.gsn ?? 1,
    updates: [
      {
        id: `${spec.updateId}_create`,
        subject_id: spec.entityId,
        model: spec.model,
        method: "create",
        hlc,
        data: null,
      },
      ...componentUpdates(spec, "replace"),
    ],
  };
};

const patch = (spec: WriteSpec): Action => ({
  id: spec.actionId,
  actor_id: "user_1",
  hlc: makeHlc(spec.ms ?? 1),
  gsn: spec.gsn ?? 1,
  updates: componentUpdates(spec, "merge"),
});

const remove = (spec: Omit<WriteSpec, "fields">): Action => ({
  id: spec.actionId,
  actor_id: "user_1",
  hlc: makeHlc(spec.ms ?? 1),
  gsn: spec.gsn ?? 1,
  updates: [
    {
      id: spec.updateId,
      subject_id: spec.entityId,
      method: "delete",
      data: null,
    },
  ],
});

/** One `drop` per named field: the component detaches from the row. */
const drop = (
  spec: Omit<WriteSpec, "fields"> & { readonly fields: readonly string[] },
): Action => ({
  id: spec.actionId,
  actor_id: "user_1",
  hlc: makeHlc(spec.ms ?? 1),
  gsn: spec.gsn ?? 1,
  updates: spec.fields.map((field) => ({
    id: `${spec.updateId}_${field}`,
    subject_id: spec.entityId,
    component: componentName(spec.model, field),
    method: "drop" as const,
    data: null,
  })),
});

/** One edge of a link write: the accessor, its type label, and the target. */
interface EdgeSpec {
  readonly as: string;
  readonly type: string;
  readonly targetId: string;
}

/** The `ebb/link` value holding one leaf per edge, present or tombstoned. */
const linkValue = (
  edges: readonly (EdgeSpec & { readonly present: boolean })[],
  updateId: string,
  ms: number,
): FieldValue => {
  const byAs: Record<string, Record<string, Record<string, FieldValue>>> = {};
  for (const edge of edges) {
    const byType = (byAs[edge.as] ??= {});
    const byTarget = (byType[edge.type] ??= {});
    byTarget[edge.targetId] = leaf(edge.present ? true : null, updateId, ms);
  }
  return {
    map: Object.fromEntries(
      Object.entries(byAs).map(([as, byType]) => [
        as,
        {
          map: Object.fromEntries(
            Object.entries(byType).map(([type, byTarget]) => [type, { map: byTarget }]),
          ),
        },
      ]),
    ),
  };
};

/** A source row put carrying the given edges as its own `ebb/link` component. */
const edges = (
  actionId: string,
  sourceId: string,
  links: readonly (EdgeSpec & { readonly present: boolean })[],
  gsn: number,
  ms: number,
): Action =>
  put({
    actionId,
    updateId: `u_${sourceId}`,
    entityId: sourceId,
    model: "page",
    gsn,
    ms,
    fields: { link: linkValue(links, `u_${sourceId}`, ms) },
    keyedComponent: ebbComponent("link"),
  });

/** A link write that moves one edge: adds `target_b`, tombstones `target_a`. */
const relink = (
  actionId: string,
  sourceId: string,
  links: readonly (EdgeSpec & { readonly present: boolean })[],
  gsn: number,
  ms: number,
): Action =>
  patch({
    actionId,
    updateId: `u_${sourceId}_${gsn}`,
    entityId: sourceId,
    model: "page",
    gsn,
    ms,
    fields: { link: linkValue(links, `u_${sourceId}_${gsn}`, ms) },
    keyedComponent: ebbComponent("link"),
  });

/** A materialized `ebb/membership` row putting `entityId` in `groupId`. */
const membership = (
  actionId: string,
  rowId: string,
  groupId: string,
  entityId: string,
  gsn: number,
  ms: number,
): Action =>
  put({
    actionId,
    updateId: `u_${rowId}`,
    entityId: rowId,
    model: "ebb",
    gsn,
    ms,
    fields: {
      membership: leaf({ entity_id: entityId, group_id: groupId }, `u_${rowId}`, ms),
    },
  });

const ingest = (replica: Replica, write: Action, position: number): number =>
  replica.ingest(write, write.updates, position);

describe("replica: change delta (#1004)", () => {
  it("names a link write's added and removed targets under each (as, type)", () => {
    const replica = createReplica();
    ingest(
      replica,
      edges(
        "a_1",
        "page_1",
        [
          { as: "author", type: "wrote", targetId: "target_a", present: true },
          { as: "tag", type: "labels", targetId: "tag_1", present: true },
        ],
        1,
        10,
      ),
      1,
    );

    // One write tombstones an edge and adds another, so the journal carries both
    // sides: the row after the write can only name the target it kept.
    ingest(
      replica,
      relink(
        "a_2",
        "page_1",
        [
          { as: "author", type: "wrote", targetId: "target_a", present: false },
          { as: "author", type: "wrote", targetId: "target_b", present: true },
          { as: "tag", type: "labels", targetId: "tag_1", present: true },
          { as: "tag", type: "labels", targetId: "tag_2", present: true },
        ],
        2,
        20,
      ),
      2,
    );

    expect(replica.changesSince(1)).toStrictEqual([
      {
        revision: 2,
        id: "page_1",
        kind: "content",
        deleted: false,
        components: ["ebb/link"],
        delta: {
          edges: [
            { as: "author", type: "wrote", added: ["target_b"], removed: ["target_a"] },
            { as: "tag", type: "labels", added: ["tag_2"], removed: [] },
          ],
        },
      },
    ]);
  });

  it("omits the delta for a value write to an existing component", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_title",
        entityId: "todo_1",
        model: "todo",
        ms: 10,
        fields: { title: leaf("First", "u_title", 10) },
      }),
      1,
    );
    ingest(
      replica,
      patch({
        actionId: "a_2",
        updateId: "u_title_2",
        entityId: "todo_1",
        model: "todo",
        gsn: 2,
        ms: 20,
        fields: { title: leaf("Second", "u_title_2", 20) },
      }),
      2,
    );

    // The component kept its place and changed its value: nothing arrived, so no
    // existence change and no delta at all.
    expect(replica.changesSince(1)).toStrictEqual([
      {
        revision: 2,
        id: "todo_1",
        kind: "content",
        deleted: false,
        components: ["todo/title"],
      },
    ]);
  });

  it("reports a component arriving and a component dropped as existence", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_title",
        entityId: "todo_1",
        model: "todo",
        ms: 10,
        fields: { title: leaf("T", "u_title", 10) },
      }),
      1,
    );
    ingest(
      replica,
      patch({
        actionId: "a_2",
        updateId: "u_status",
        entityId: "todo_1",
        model: "todo",
        gsn: 2,
        ms: 20,
        fields: { status: leaf("open", "u_status", 20) },
      }),
      2,
    );
    ingest(
      replica,
      drop({
        actionId: "a_3",
        updateId: "u_status_2",
        entityId: "todo_1",
        model: "todo",
        gsn: 3,
        ms: 30,
        fields: ["status"],
      }),
      3,
    );

    expect(replica.changesSince(1)).toStrictEqual([
      {
        revision: 2,
        id: "todo_1",
        kind: "content",
        deleted: false,
        components: ["todo/status"],
        delta: { existence: { added: ["todo/status"], removed: [] } },
      },
      {
        revision: 3,
        id: "todo_1",
        kind: "content",
        deleted: false,
        components: ["todo/status"],
        delta: { existence: { added: [], removed: ["todo/status"] } },
      },
    ]);
  });

  it("names both groups when a membership row moves", () => {
    const replica = createReplica();
    ingest(replica, membership("a_1", "m_1", "g1", "e_1", 1, 10), 1);
    ingest(
      replica,
      patch({
        actionId: "a_2",
        updateId: "u_m_1_2",
        entityId: "m_1",
        model: "ebb",
        gsn: 2,
        ms: 20,
        fields: {
          membership: leaf({ entity_id: "e_1", group_id: "g2" }, "u_m_1_2", 20),
        },
      }),
      2,
    );

    expect(replica.memberships({ groupId: "g2" })).toEqual(["e_1"]);
    expect(replica.changesSince(1)).toStrictEqual([
      {
        revision: 2,
        id: "m_1",
        kind: "content",
        deleted: false,
        components: ["ebb/membership"],
        delta: { groups: { before: ["g1"], after: ["g2"] } },
      },
    ]);
  });

  it("names the group an evicted row left", () => {
    const replica = createReplica();
    ingest(replica, membership("a_1", "m_1", "g1", "e_1", 1, 10), 1);

    replica.evict(["m_1"]);

    expect(replica.changesSince(1)).toStrictEqual([
      {
        revision: 2,
        id: "m_1",
        kind: "membership",
        deleted: false,
        membership: "left",
        models: ["ebb"],
        delta: {
          existence: { added: [], removed: ["ebb/membership"] },
          groups: { before: ["g1"], after: [] },
        },
      },
    ]);
  });

  it("removes every edge of a deleted row", () => {
    const replica = createReplica();
    ingest(
      replica,
      edges(
        "a_1",
        "page_1",
        [
          { as: "author", type: "wrote", targetId: "target_a", present: true },
          { as: "author", type: "wrote", targetId: "target_b", present: true },
        ],
        1,
        10,
      ),
      1,
    );

    ingest(
      replica,
      remove({ actionId: "a_2", updateId: "u_2", entityId: "page_1", model: "page" }),
      2,
    );

    // A tombstoned row contributes no live edge, so the delete removes all of
    // its targets.
    expect(replica.changesSince(1)).toStrictEqual([
      {
        revision: 2,
        id: "page_1",
        kind: "membership",
        deleted: true,
        membership: "left",
        models: ["page"],
        delta: {
          edges: [{ as: "author", type: "wrote", added: [], removed: ["target_a", "target_b"] }],
        },
      },
    ]);
  });

  it("attaches the delta to an optimistic write and its discard", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_title",
        entityId: "todo_1",
        model: "todo",
        ms: 10,
        fields: { title: leaf("T", "u_title", 10) },
      }),
      1,
    );

    replica.optimistic(
      patch({
        actionId: "local_1",
        updateId: "u_status",
        entityId: "todo_1",
        model: "todo",
        gsn: 2,
        ms: 20,
        fields: { status: leaf("open", "u_status", 20) },
      }),
    );
    replica.discard("local_1");

    expect(replica.changesSince(1)).toStrictEqual([
      {
        revision: 2,
        id: "todo_1",
        kind: "content",
        deleted: false,
        components: ["todo/status"],
        delta: { existence: { added: ["todo/status"], removed: [] } },
      },
      {
        revision: 3,
        id: "todo_1",
        kind: "content",
        deleted: false,
        components: ["todo/status"],
        delta: { existence: { added: [], removed: ["todo/status"] } },
      },
    ]);
  });
});
