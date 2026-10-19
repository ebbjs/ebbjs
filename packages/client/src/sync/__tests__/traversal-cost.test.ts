/**
 * The traversal counter is the acceptance proof that reads route
 * through the adjacency index: a traversal's examined rows are bounded
 * by the degree of the row it starts from, not by the number of
 * unrelated relationship / membership rows in the store.
 *
 * Each case runs the same degree-two traversal against two stores that
 * differ only in how many unrelated rows they hold, and against both
 * adjacency backends — the storage adapter's async index and the
 * replica's synchronous one (#520). The replica must examine the same
 * rows as the adapter, so the backend swap cannot reintroduce a scan.
 */

import { describe, it, expect } from "vitest";
import { makeHlc, type Action, type Entity, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import { createReplica } from "@ebbjs/storage/replica";

import {
  type AdjacencyReader,
  forwardMany,
  forwardOne,
  membershipGroups,
  reverse,
} from "../relationship";
import { traversalCounter } from "../traversal-counter";

const mkEntity = (id: string, type: string, fields: Record<string, unknown>): Entity => ({
  id,
  type,
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, { value: v, update_id: "u" }]),
    ),
  },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 0,
});

const mkRel = (
  id: string,
  sourceId: string,
  targetId: string,
  field: string,
  type: string,
): Entity =>
  mkEntity(id, "relationship", { source_id: sourceId, target_id: targetId, field, type });

/** Fold one materialized row into the replica the way hydrate would. */
const ingestRow = (replica: ReturnType<typeof createReplica>, entity: Entity, position: number) => {
  const hlc = makeHlc(position);
  const action: Action = {
    id: `a_${entity.id}`,
    actor_id: "test",
    hlc,
    gsn: position,
    updates: [],
  };
  const update: Update = {
    id: `u_${entity.id}`,
    subject_id: entity.id,
    subject_type: entity.type,
    method: "put",
    data: { fields: entity.data?.fields ?? {} },
  };
  replica.ingest(action, [update], position);
};

type Backend = "storage" | "replica";

/**
 * Seed a store whose `t1` has degree two — one parent edge and one
 * membership — plus `unrelatedCount` relationship and membership rows
 * that touch other entities entirely. Both the memory adapter and the
 * replica hold the same rows.
 */
const mkStore = async (unrelatedCount: number, backend: Backend) => {
  const adapter = createMemoryAdapter();
  const rows: Entity[] = [
    mkEntity("t1", "todo", { title: "Ship" }),
    mkEntity("l1", "list", { name: "Work" }),
    mkRel("rel-1", "t1", "l1", "parentList", "todo"),
    mkEntity("g1", "group", { name: "G" }),
    mkEntity("eg-1", "entityGroup", { entity_id: "t1", group_id: "g1" }),
  ];
  for (let i = 0; i < unrelatedCount; i += 1) {
    rows.push(
      mkEntity(`other-${i}`, "todo", { title: `other ${i}` }),
      mkRel(`unrelated-rel-${i}`, `other-${i}`, `unrelated-list-${i}`, "parentList", "todo"),
      mkEntity(`unrelated-list-${i}`, "list", { name: `List ${i}` }),
      mkEntity(`unrelated-eg-${i}`, "entityGroup", {
        entity_id: `other-${i}`,
        group_id: `unrelated-group-${i}`,
      }),
    );
  }
  for (const row of rows) await adapter.entities.set(row);

  const replica = createReplica();
  rows.forEach((row, i) => ingestRow(replica, row, i + 1));

  const reader: AdjacencyReader =
    backend === "storage"
      ? {
          forwardLinks: (query) => adapter.entities.queryByRelationshipSource(query),
          reverseSourceIds: (query) => adapter.entities.queryByRelationship(query),
          membershipsOf: (entityId) => adapter.entities.queryByMembershipEntity(entityId),
        }
      : {
          forwardLinks: async (query) => replica.relationshipLinks(query),
          reverseSourceIds: async (query) =>
            replica.relationships({ as: query.as, type: query.type, targetId: query.targetId }),
          membershipsOf: async (entityId) => replica.membershipLinks(entityId),
        };
  const readLocalEntity = (id: string): Promise<Entity | null> => adapter.entities.get(id);
  return { reader, readLocalEntity };
};

const shape = { type: "object", properties: { name: { type: "string" } } } as never;

/** Rows examined by each accessor for the degree-two `t1` row. */
const measure = async (unrelatedCount: number, backend: Backend) => {
  const { reader, readLocalEntity } = await mkStore(unrelatedCount, backend);

  traversalCounter.reset();
  await forwardOne(readLocalEntity, reader, "t1", "todo", "parentList", "todo");
  const parent = traversalCounter.rowsExamined;

  traversalCounter.reset();
  await forwardMany(readLocalEntity, reader, "t1", "todo", "list", shape, "parentList", "todo");
  const references = traversalCounter.rowsExamined;

  traversalCounter.reset();
  await reverse(readLocalEntity, reader, "l1", "todo", shape, "parentList", "todo");
  const children = traversalCounter.rowsExamined;

  traversalCounter.reset();
  await membershipGroups(readLocalEntity, reader, "t1", "group", shape);
  const groups = traversalCounter.rowsExamined;

  return { parent, references, children, groups };
};

const backends: readonly Backend[] = ["storage", "replica"];

describe("traversal cost is bounded by degree", () => {
  it.each(backends)("does not grow with the number of unrelated rows (%s)", async (backend) => {
    const small = await measure(0, backend);
    const large = await measure(200, backend);

    expect(large).toEqual(small);
  });

  it.each(backends)(
    "examines only the source, the links, and each target (%s)",
    async (backend) => {
      const { parent, references, children, groups } = await measure(200, backend);

      // forwardOne: source + 1 link + target.
      expect(parent).toBe(3);
      // forwardMany: source + 1 link + target.
      expect(references).toBe(3);
      // reverse: 1 source id + that source.
      expect(children).toBe(2);
      // membershipGroups: 1 membership + its group.
      expect(groups).toBe(2);
    },
  );

  it("examines the same rows whether the backend is the adapter or the replica", async () => {
    for (const unrelatedCount of [0, 200]) {
      const storage = await measure(unrelatedCount, "storage");
      const replica = await measure(unrelatedCount, "replica");
      expect(replica).toEqual(storage);
    }
  });
});
