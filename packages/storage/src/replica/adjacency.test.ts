import { describe, expect, it } from "vitest";
import {
  componentName,
  ebbComponent,
  isFieldMap,
  makeHlc,
  type Action,
  type ComponentName,
  type Entity,
  type FieldValue,
  type Update,
} from "@ebbjs/core";

import { REPLICA_RECORD_FORMAT } from "../internal/replica-record";
import type { ReplicaRecord } from "../types/replica-store";
import { createReplica } from "./replica";
import type { Replica } from "./types";

/**
 * Fixtures for the replica's adjacency reads: source rows carrying `ebb/link`
 * edges and `ebb/membership` rows, pushed through the same `put` / `remove`
 * path the other replica suites use. A link is a keyed component of its source,
 * so an edge write merges keys on the row that owns the edge; a membership is
 * an atomic value on a row of its own.
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

/** One edge of a link fixture: the accessor, its type label, and the target. */
interface EdgeSpec {
  readonly as: string;
  readonly type: string;
  readonly targetId: string;
}

/** The `ebb/link` value holding one leaf per edge: presence, or its tombstone. */
const linkValue = (
  edges: readonly EdgeSpec[],
  updateId: string,
  ms: number,
  present = true,
): FieldValue => {
  const byAs: Record<string, Record<string, Record<string, FieldValue>>> = {};
  for (const edge of edges) {
    const byType = (byAs[edge.as] ??= {});
    const byTarget = (byType[edge.type] ??= {});
    byTarget[edge.targetId] = leaf(present ? true : null, updateId, ms);
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

/** A source row carrying the given edges: its own `ebb/link` component. */
const edges = (
  actionId: string,
  sourceId: string,
  edges_: readonly EdgeSpec[],
  gsn: number,
  ms: number,
  model = "page",
): Action =>
  put({
    actionId,
    updateId: `u_${sourceId}`,
    entityId: sourceId,
    model,
    gsn,
    ms,
    fields: { link: linkValue(edges_, `u_${sourceId}`, ms) },
    keyedComponent: ebbComponent("link"),
  });

/** A link write that tombstones the named keys of one existing source row. */
const tombstone = (
  sourceId: string,
  removed: readonly EdgeSpec[],
  gsn: number,
  ms: number,
): Action => {
  const updateId = `u_tomb_${sourceId}_${gsn}`;
  return {
    id: `a_tomb_${sourceId}_${gsn}`,
    actor_id: "user_1",
    hlc: makeHlc(ms),
    gsn,
    updates: [
      {
        id: updateId,
        subject_id: sourceId,
        component: ebbComponent("link"),
        method: "merge",
        data: linkValue(removed, updateId, ms, false),
      },
    ],
  };
};

/** A materialized `ebb/membership` row: member `entityId` in `groupId`. */
const member = (
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

const edge = (as: string, type: string, targetId: string): EdgeSpec => ({ as, type, targetId });

describe("replica adjacency: relationship reads", () => {
  it("reads distinct live sources reverse and the source's targets forward", () => {
    const replica = createReplica();
    ingest(replica, edges("a_1", "src_2", [edge("author", "wrote", "tgt_1")], 1, 1), 1);
    ingest(
      replica,
      edges(
        "a_2",
        "src_1",
        [edge("author", "wrote", "tgt_1"), edge("author", "wrote", "tgt_2")],
        2,
        2,
      ),
      2,
    );

    expect(replica.relationships({ as: "author", type: "wrote", targetId: "tgt_1" })).toEqual([
      "src_1",
      "src_2",
    ]);
    expect(replica.relationships({ as: "author", type: "wrote", sourceId: "src_1" })).toEqual([
      "tgt_1",
      "tgt_2",
    ]);
    expect(replica.relationships({ as: "author", type: "wrote", targetId: "tgt_missing" })).toEqual(
      [],
    );
    expect(replica.relationships({ as: "author", type: "wrote" })).toEqual([]);
  });

  it("prefers sourceId over targetId when both are set", () => {
    const replica = createReplica();
    ingest(replica, edges("a_1", "src_1", [edge("author", "wrote", "tgt_1")], 1, 1), 1);
    expect(
      replica.relationships({
        as: "author",
        type: "wrote",
        sourceId: "src_1",
        targetId: "tgt_other",
      }),
    ).toEqual(["tgt_1"]);
  });

  it("tombstones one edge's key and keeps the source's siblings", () => {
    const replica = createReplica();
    ingest(
      replica,
      edges(
        "a_1",
        "src_1",
        [edge("author", "wrote", "tgt_1"), edge("author", "wrote", "tgt_2")],
        1,
        1,
      ),
      1,
    );
    ingest(replica, tombstone("src_1", [edge("author", "wrote", "tgt_1")], 2, 2), 2);

    expect(replica.relationships({ as: "author", type: "wrote", targetId: "tgt_1" })).toEqual([]);
    expect(replica.relationships({ as: "author", type: "wrote", targetId: "tgt_2" })).toEqual([
      "src_1",
    ]);
    expect(replica.relationships({ as: "author", type: "wrote", sourceId: "src_1" })).toEqual([
      "tgt_2",
    ]);
  });
});

describe("replica adjacency: membership reads", () => {
  it("reads distinct live groups and members, ascending", () => {
    const replica = createReplica();
    ingest(replica, member("a_1", "m_1", "grp_2", "e_1", 1, 1), 1);
    ingest(replica, member("a_2", "m_2", "grp_1", "e_1", 2, 2), 2);
    ingest(replica, member("a_3", "m_3", "grp_1", "e_2", 3, 3), 3);

    expect(replica.memberships({ groupId: "grp_1" })).toEqual(["e_1", "e_2"]);
    expect(replica.memberships({ entityId: "e_1" })).toEqual(["grp_1", "grp_2"]);
    expect(replica.memberships({})).toEqual([]);
    expect(replica.membershipRows()).toEqual([
      { membershipId: "m_2", groupId: "grp_1", entityId: "e_1" },
      { membershipId: "m_3", groupId: "grp_1", entityId: "e_2" },
      { membershipId: "m_1", groupId: "grp_2", entityId: "e_1" },
    ]);
  });

  it("prefers groupId over entityId when both are set", () => {
    const replica = createReplica();
    ingest(replica, member("a_1", "m_1", "grp_1", "e_1", 1, 1), 1);
    expect(replica.memberships({ groupId: "grp_1", entityId: "e_other" })).toEqual(["e_1"]);
  });

  it("drops a deleted membership from both directions", () => {
    const replica = createReplica();
    ingest(replica, member("a_1", "m_1", "grp_1", "e_1", 1, 1), 1);
    expect(replica.memberships({ groupId: "grp_1" })).toEqual(["e_1"]);
    expect(replica.memberships({ entityId: "e_1" })).toEqual(["grp_1"]);

    ingest(
      replica,
      remove({
        actionId: "a_2",
        updateId: "u_del",
        entityId: "m_1",
        model: "ebb",
        gsn: 2,
        ms: 2,
      }),
      2,
    );
    expect(replica.memberships({ groupId: "grp_1" })).toEqual([]);
    expect(replica.memberships({ entityId: "e_1" })).toEqual([]);
    expect(replica.membershipLinks("e_1")).toEqual([]);
    expect(replica.membershipRows()).toEqual([]);
  });
});

describe("replica adjacency: row removal", () => {
  it("drops only the tombstoned source when two share a target", () => {
    const replica = createReplica();
    ingest(replica, edges("a_1", "src_1", [edge("author", "wrote", "tgt_1")], 1, 1), 1);
    ingest(replica, edges("a_2", "src_2", [edge("author", "wrote", "tgt_1")], 2, 2), 2);

    ingest(
      replica,
      remove({
        actionId: "a_3",
        updateId: "u_del",
        entityId: "src_1",
        model: "page",
        gsn: 3,
        ms: 3,
      }),
      3,
    );
    expect(replica.relationships({ as: "author", type: "wrote", targetId: "tgt_1" })).toEqual([
      "src_2",
    ]);
    expect(replica.relationships({ as: "author", type: "wrote", sourceId: "src_1" })).toEqual([]);
    expect(replica.relationships({ as: "author", type: "wrote", sourceId: "src_2" })).toEqual([
      "tgt_1",
    ]);
  });
});

describe("replica adjacency: optimistic overlay", () => {
  it("shows an optimistic edge and removes it on discard", () => {
    const replica = createReplica();
    const optimisticEdge = edges("a_local", "src_1", [edge("author", "wrote", "tgt_1")], 1, 1);

    replica.optimistic(optimisticEdge);
    expect(replica.relationships({ as: "author", type: "wrote", sourceId: "src_1" })).toEqual([
      "tgt_1",
    ]);
    expect(replica.relationships({ as: "author", type: "wrote", targetId: "tgt_1" })).toEqual([
      "src_1",
    ]);

    replica.discard("a_local");
    expect(replica.relationships({ as: "author", type: "wrote", sourceId: "src_1" })).toEqual([]);
    expect(replica.relationships({ as: "author", type: "wrote", targetId: "tgt_1" })).toEqual([]);
  });
});

const sourceRow = (id: string, edges_: readonly EdgeSpec[], model = "page"): Entity => ({
  id,
  model,
  data: { fields: { link: linkValue(edges_, `u_${id}`, 1) } },
  exists: true,
  created_hlc: makeHlc(1),
  updated_hlc: makeHlc(1),
  deleted_hlc: null,
  last_gsn: 1,
});

const membershipRow = (id: string, groupId: string, entityId: string): Entity => ({
  id,
  model: "ebb",
  data: {
    fields: { membership: leaf({ entity_id: entityId, group_id: groupId }, `u_${id}`, 1) },
  },
  exists: true,
  created_hlc: makeHlc(1),
  updated_hlc: makeHlc(1),
  deleted_hlc: null,
  last_gsn: 1,
});

const record = (entities: readonly Entity[]): ReplicaRecord => ({
  format: REPLICA_RECORD_FORMAT,
  componentVersions: {},
  position: 0,
  revision: 1,
  entities,
});

describe("replica adjacency: load rebuilds", () => {
  it("reads the same adjacency after a toRecord()/load() cycle", () => {
    const replica = createReplica();
    ingest(replica, edges("a_1", "src_1", [edge("author", "wrote", "tgt_1")], 1, 1), 1);
    ingest(replica, edges("a_2", "src_2", [edge("author", "wrote", "tgt_1")], 2, 2), 2);
    ingest(replica, member("a_3", "m_1", "grp_1", "e_1", 3, 3), 3);

    const hydrated = createReplica();
    hydrated.load(replica.toRecord());
    expect(hydrated.relationships({ as: "author", type: "wrote", targetId: "tgt_1" })).toEqual([
      "src_1",
      "src_2",
    ]);
    expect(hydrated.memberships({ groupId: "grp_1" })).toEqual(["e_1"]);
  });

  it("indexes a link a record carries on a row of a user model", () => {
    const replica = createReplica();
    replica.load(record([sourceRow("note_1", [edge("author", "wrote", "tgt_1")], "note")]));

    expect(replica.relationships({ as: "author", type: "wrote", targetId: "tgt_1" })).toEqual([
      "note_1",
    ]);
    expect(replica.relationships({ as: "author", type: "wrote", sourceId: "note_1" })).toEqual([
      "tgt_1",
    ]);
  });

  it("excludes tombstoned rows supplied in the record", () => {
    const replica = createReplica();
    replica.load(
      record([
        sourceRow("src_live", [edge("author", "wrote", "tgt_1")]),
        { ...sourceRow("src_dead", [edge("author", "wrote", "tgt_1")]), deleted_hlc: makeHlc(9) },
        membershipRow("m_live", "grp_1", "e_1"),
        { ...membershipRow("m_dead", "grp_1", "e_9"), deleted_hlc: makeHlc(9) },
      ]),
    );
    expect(replica.relationships({ as: "author", type: "wrote", targetId: "tgt_1" })).toEqual([
      "src_live",
    ]);
    expect(replica.memberships({ groupId: "grp_1" })).toEqual(["e_1"]);
  });
});
