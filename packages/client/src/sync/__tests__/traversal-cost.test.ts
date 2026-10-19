/**
 * The traversal counter is the acceptance proof that reads route
 * through the adjacency index: a traversal's examined rows are bounded
 * by the degree of the row it starts from, not by the number of
 * unrelated relationship / membership rows in the store.
 *
 * Each case runs the same degree-two traversal against two stores that
 * differ only in how many unrelated rows they hold.
 */

import { describe, it, expect } from "vitest";
import type { Entity } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

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

/**
 * Seed a store whose `t1` has degree two — one parent edge and one
 * membership — plus `unrelatedCount` relationship and membership rows
 * that touch other entities entirely.
 */
const mkStore = async (unrelatedCount: number) => {
  const adapter = createMemoryAdapter();
  const set = (e: Entity) => adapter.entities.set(e);

  await set(mkEntity("t1", "todo", { title: "Ship" }));
  await set(mkEntity("l1", "list", { name: "Work" }));
  await set(mkRel("rel-1", "t1", "l1", "parentList", "todo"));
  await set(mkEntity("g1", "group", { name: "G" }));
  await set(mkEntity("eg-1", "entityGroup", { entity_id: "t1", group_id: "g1" }));

  for (let i = 0; i < unrelatedCount; i += 1) {
    await set(mkEntity(`other-${i}`, "todo", { title: `other ${i}` }));
    await set(
      mkRel(`unrelated-rel-${i}`, `other-${i}`, `unrelated-list-${i}`, "parentList", "todo"),
    );
    await set(mkEntity(`unrelated-list-${i}`, "list", { name: `List ${i}` }));
    await set(
      mkEntity(`unrelated-eg-${i}`, "entityGroup", {
        entity_id: `other-${i}`,
        group_id: `unrelated-group-${i}`,
      }),
    );
  }

  const reader: AdjacencyReader = {
    forwardLinks: (query) => adapter.entities.queryByRelationshipSource(query),
    reverseSourceIds: (query) => adapter.entities.queryByRelationship(query),
    membershipsOf: (entityId) => adapter.entities.queryByMembershipEntity(entityId),
  };
  const readLocalEntity = (id: string): Promise<Entity | null> => adapter.entities.get(id);
  return { reader, readLocalEntity };
};

const shape = { type: "object", properties: { name: { type: "string" } } } as never;

/** Rows examined by each accessor for the degree-two `t1` row. */
const measure = async (unrelatedCount: number) => {
  const { reader, readLocalEntity } = await mkStore(unrelatedCount);

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

describe("traversal cost is bounded by degree", () => {
  it("does not grow with the number of unrelated rows", async () => {
    const small = await measure(0);
    const large = await measure(200);

    expect(large).toEqual(small);
  });

  it("examines only the source, the links, and each target", async () => {
    const { parent, references, children, groups } = await measure(200);

    // forwardOne: source + 1 link + target.
    expect(parent).toBe(3);
    // forwardMany: source + 1 link + target.
    expect(references).toBe(3);
    // reverse: 1 source id + that source.
    expect(children).toBe(2);
    // membershipGroups: 1 membership + its group.
    expect(groups).toBe(2);
  });
});
