import { describe, expect, it } from "vitest";
import { makeHlc, type Action, type Entity, type FieldValue, type Update } from "@ebbjs/core";

import { REPLICA_RECORD_FORMAT } from "../internal/replica-record";
import type { ReplicaRecord } from "../types/replica-store";
import { createReplica } from "./replica";
import type { Replica } from "./types";

/**
 * Fixtures for the replica's adjacency reads: materialized `relationship` and
 * `entityGroup` rows pushed through the same `put` / `patch` / `remove` path
 * the other replica suites use.
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
  readonly type: string;
  readonly gsn?: number;
  readonly ms?: number;
  readonly fields: Record<string, FieldValue>;
}

const build = (
  method: "put" | "patch" | "delete",
  spec: WriteSpec,
  data: Update["data"],
): Action => ({
  id: spec.actionId,
  actor_id: "user_1",
  hlc: makeHlc(spec.ms ?? 1),
  gsn: spec.gsn ?? 1,
  updates: [
    {
      id: spec.updateId,
      subject_id: spec.entityId,
      subject_type: spec.type,
      method,
      data,
    },
  ],
});

const put = (spec: WriteSpec): Action => build("put", spec, { fields: spec.fields });
const remove = (spec: Omit<WriteSpec, "fields">): Action =>
  build("delete", { ...spec, fields: {} }, null);

/** A materialized relationship row: `source_id` —as/type→ `target_id`. */
const edge = (
  actionId: string,
  rowId: string,
  field: string,
  type: string,
  sourceId: string,
  targetId: string,
  gsn: number,
  ms: number,
): Action =>
  put({
    actionId,
    updateId: `u_${rowId}`,
    entityId: rowId,
    type: "relationship",
    gsn,
    ms,
    fields: {
      field: leaf(field, `u_${rowId}`, ms),
      type: leaf(type, `u_${rowId}`, ms),
      source_id: leaf(sourceId, `u_${rowId}`, ms),
      target_id: leaf(targetId, `u_${rowId}`, ms),
    },
  });

/** A materialized entityGroup row: member `entityId` in `groupId`. */
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
    type: "entityGroup",
    gsn,
    ms,
    fields: {
      group_id: leaf(groupId, `u_${rowId}`, ms),
      entity_id: leaf(entityId, `u_${rowId}`, ms),
    },
  });

const ingest = (replica: Replica, write: Action, position: number): number =>
  replica.ingest(write, write.updates, position);

describe("replica adjacency: relationship reads", () => {
  it("reads distinct live sources reverse and targets forward, ascending", () => {
    const replica = createReplica();
    ingest(replica, edge("a_1", "r_1", "author", "wrote", "src_2", "tgt_1", 1, 1), 1);
    ingest(replica, edge("a_2", "r_2", "author", "wrote", "src_1", "tgt_1", 2, 2), 2);
    ingest(replica, edge("a_3", "r_3", "author", "wrote", "src_1", "tgt_2", 3, 3), 3);
    // A second row repeats src_1 → tgt_1; the read stays distinct.
    ingest(replica, edge("a_4", "r_4", "author", "wrote", "src_1", "tgt_1", 4, 4), 4);

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
    ingest(replica, edge("a_1", "r_1", "author", "wrote", "src_1", "tgt_1", 1, 1), 1);
    expect(
      replica.relationships({
        as: "author",
        type: "wrote",
        sourceId: "src_1",
        targetId: "tgt_other",
      }),
    ).toEqual(["tgt_1"]);
  });

  it("returns the same ascending sequence regardless of insertion order", () => {
    const first = createReplica();
    ingest(first, edge("a_1", "r_1", "author", "wrote", "src_1", "tgt_2", 1, 1), 1);
    ingest(first, edge("a_2", "r_2", "author", "wrote", "src_2", "tgt_1", 2, 2), 2);

    const second = createReplica();
    ingest(second, edge("a_2", "r_2", "author", "wrote", "src_2", "tgt_1", 2, 2), 1);
    ingest(second, edge("a_1", "r_1", "author", "wrote", "src_1", "tgt_2", 1, 1), 2);

    expect(first.relationships({ as: "author", type: "wrote", sourceId: "src_1" })).toEqual(
      second.relationships({ as: "author", type: "wrote", sourceId: "src_1" }),
    );
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
        type: "entityGroup",
        gsn: 2,
        ms: 2,
      }),
      2,
    );
    expect(replica.memberships({ groupId: "grp_1" })).toEqual([]);
    expect(replica.memberships({ entityId: "e_1" })).toEqual([]);
    expect(replica.membershipLinks("e_1")).toEqual([]);
  });
});

describe("replica adjacency: row removal", () => {
  it("does not erase a shared natural key when one row is removed", () => {
    const replica = createReplica();
    ingest(replica, edge("a_1", "r_1", "author", "wrote", "src_1", "tgt_1", 1, 1), 1);
    ingest(replica, edge("a_2", "r_2", "author", "wrote", "src_2", "tgt_1", 2, 2), 2);

    ingest(
      replica,
      remove({
        actionId: "a_3",
        updateId: "u_del",
        entityId: "r_1",
        type: "relationship",
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

  it("drops a tombstoned relationship from both directions", () => {
    const replica = createReplica();
    ingest(replica, edge("a_1", "r_1", "author", "wrote", "src_1", "tgt_1", 1, 1), 1);
    ingest(
      replica,
      remove({
        actionId: "a_2",
        updateId: "u_del",
        entityId: "r_1",
        type: "relationship",
        gsn: 2,
        ms: 2,
      }),
      2,
    );
    expect(replica.relationships({ as: "author", type: "wrote", sourceId: "src_1" })).toEqual([]);
    expect(replica.relationships({ as: "author", type: "wrote", targetId: "tgt_1" })).toEqual([]);
    expect(replica.relationshipLinks({ as: "author", type: "wrote", sourceId: "src_1" })).toEqual(
      [],
    );
  });
});

describe("replica adjacency: optimistic overlay", () => {
  it("shows an optimistic edge and removes it on discard", () => {
    const replica = createReplica();
    const optimisticEdge = edge("a_local", "r_local", "author", "wrote", "src_1", "tgt_1", 1, 1);

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

describe("replica adjacency: links", () => {
  it("carries live row ids ascending by value then row id", () => {
    const replica = createReplica();
    ingest(replica, edge("a_1", "r_b", "author", "wrote", "src_1", "tgt_2", 1, 1), 1);
    ingest(replica, edge("a_2", "r_a", "author", "wrote", "src_1", "tgt_1", 2, 2), 2);
    // Same target from a second row: ordered by row id after the target.
    ingest(replica, edge("a_3", "r_c", "author", "wrote", "src_1", "tgt_2", 3, 3), 3);

    expect(replica.relationshipLinks({ as: "author", type: "wrote", sourceId: "src_1" })).toEqual([
      { relationshipId: "r_a", targetId: "tgt_1" },
      { relationshipId: "r_b", targetId: "tgt_2" },
      { relationshipId: "r_c", targetId: "tgt_2" },
    ]);

    ingest(replica, member("a_4", "m_b", "grp_2", "e_1", 4, 4), 4);
    ingest(replica, member("a_5", "m_a", "grp_1", "e_1", 5, 5), 5);
    expect(replica.membershipLinks("e_1")).toEqual([
      { membershipId: "m_a", groupId: "grp_1" },
      { membershipId: "m_b", groupId: "grp_2" },
    ]);
    expect(replica.membershipLinks("e_missing")).toEqual([]);
  });
});

const relationshipRow = (
  id: string,
  field: string,
  type: string,
  sourceId: string,
  targetId: string,
): Entity => ({
  id,
  type: "relationship",
  data: {
    fields: {
      field: leaf(field, `u_${id}`, 1),
      type: leaf(type, `u_${id}`, 1),
      source_id: leaf(sourceId, `u_${id}`, 1),
      target_id: leaf(targetId, `u_${id}`, 1),
    },
  },
  created_hlc: makeHlc(1),
  updated_hlc: makeHlc(1),
  deleted_hlc: null,
  last_gsn: 1,
});

const membershipRow = (id: string, groupId: string, entityId: string): Entity => ({
  id,
  type: "entityGroup",
  data: {
    fields: { group_id: leaf(groupId, `u_${id}`, 1), entity_id: leaf(entityId, `u_${id}`, 1) },
  },
  created_hlc: makeHlc(1),
  updated_hlc: makeHlc(1),
  deleted_hlc: null,
  last_gsn: 1,
});

const record = (entities: readonly Entity[]): ReplicaRecord => ({
  format: REPLICA_RECORD_FORMAT,
  position: 0,
  revision: 1,
  entities,
});

describe("replica adjacency: load rebuilds", () => {
  it("reads the same adjacency after a toRecord()/load() cycle", () => {
    const replica = createReplica();
    ingest(replica, edge("a_1", "r_1", "author", "wrote", "src_1", "tgt_1", 1, 1), 1);
    ingest(replica, edge("a_2", "r_2", "author", "wrote", "src_2", "tgt_1", 2, 2), 2);
    ingest(replica, member("a_3", "m_1", "grp_1", "e_1", 3, 3), 3);

    const hydrated = createReplica();
    hydrated.load(replica.toRecord());
    expect(hydrated.relationships({ as: "author", type: "wrote", targetId: "tgt_1" })).toEqual([
      "src_1",
      "src_2",
    ]);
    expect(hydrated.memberships({ groupId: "grp_1" })).toEqual(["e_1"]);
  });

  it("excludes tombstoned rows supplied in the record", () => {
    const replica = createReplica();
    replica.load(
      record([
        relationshipRow("r_live", "author", "wrote", "src_1", "tgt_1"),
        {
          ...relationshipRow("r_dead", "author", "wrote", "src_9", "tgt_1"),
          deleted_hlc: makeHlc(9),
        },
        membershipRow("m_live", "grp_1", "e_1"),
        { ...membershipRow("m_dead", "grp_1", "e_9"), deleted_hlc: makeHlc(9) },
      ]),
    );
    expect(replica.relationships({ as: "author", type: "wrote", targetId: "tgt_1" })).toEqual([
      "src_1",
    ]);
    expect(replica.memberships({ groupId: "grp_1" })).toEqual(["e_1"]);
  });
});
