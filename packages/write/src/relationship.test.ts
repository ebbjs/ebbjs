/**
 * The relationship wire builders: one `ebb/link` merge per edge, addressed by
 * the edge's key on its source row.
 *
 * A link is a keyed component of its source, so nothing here makes a row: the
 * only Updates are `merge`s on the source, each carrying either one presence
 * leaf or one tombstone leaf. That is the property #830 lost when a removal
 * was expressed as a fresh link row.
 */

import { isComponentUpdate, isFieldMap, type FieldValue, type Update } from "@ebbjs/core";
import { defineModel, defineRelationship, defineSchema, e } from "@ebbjs/schema";
import { describe, expect, it } from "vitest";

import { buildRelationshipWrite, operationCallFor } from "./index";

const buildRegistry = () => {
  const project = defineModel("project", { name: e.string() });
  const label = defineModel("label", { name: e.string() });
  const issue = defineModel("issue", { title: e.string() });
  const belongsTo = defineRelationship({ source: issue, target: project, as: "project" });
  const labels = defineRelationship({
    source: issue,
    target: label,
    as: "labels",
    sourceCardinality: "many",
  });
  return defineSchema({
    models: { project, label, issue },
    relationships: { belongsTo, labels },
    version: 1,
  })._registry;
};

/** The leaves under `ebb/link` → `<as>` → `<type>` → target, for one write. */
const edgeLeaves = (update: Update, as: string, type: string): Record<string, FieldValue> => {
  if (!isComponentUpdate(update) || update.data === null) {
    throw new Error("expected a component update");
  }
  if (!isFieldMap(update.data)) throw new Error("expected a map value");
  const byAs = update.data.map[as];
  if (byAs === undefined || !isFieldMap(byAs)) throw new Error(`no "${as}" level`);
  const byType = byAs.map[type];
  if (byType === undefined || !isFieldMap(byType)) throw new Error(`no "${as}.${type}" level`);
  return byType.map;
};

describe("#830: removing an edge never creates one", () => {
  it("writes a removal as exactly one tombstone and no presence", () => {
    const registry = buildRegistry();

    const result = buildRelationshipWrite(registry, {
      source: { name: "issue" },
      target: { name: "label" },
      sourceId: "e_issue",
      as: "labels",
      targetIds: { add: [], remove: ["e_label"] },
      hlc: () => "hlc_1",
      newId: (() => {
        let next = 0;
        return () => `u_${++next}`;
      })(),
    });

    expect(result.relationshipUpdates).toHaveLength(1);
    const [update] = result.relationshipUpdates;
    expect(update).toMatchObject({
      subject_id: "e_issue",
      component: "ebb/link",
      method: "merge",
    });

    const leaves = edgeLeaves(update, "labels", "issue");
    expect(Object.keys(leaves)).toEqual(["e_label"]);
    expect(leaves["e_label"]).toMatchObject({ value: null });
    expect(isFieldMap(leaves["e_label"]!)).toBe(false);
  });
});

describe("one edge per Update", () => {
  it("writes a presence leaf for one target", () => {
    const registry = buildRegistry();

    const result = buildRelationshipWrite(registry, {
      source: { name: "issue" },
      target: { name: "label" },
      sourceId: "e_issue",
      as: "labels",
      targetIds: { add: ["e_label"], remove: [] },
      hlc: () => "hlc_1",
      newId: () => "u_1",
    });

    expect(result.relationshipUpdates).toHaveLength(1);
    const leaves = edgeLeaves(result.relationshipUpdates[0], "labels", "issue");
    expect(leaves["e_label"]).toMatchObject({ value: true });
  });

  it("writes one Update per target for a create pointer set", () => {
    const registry = buildRegistry();

    const result = buildRelationshipWrite(registry, {
      source: { name: "issue" },
      target: { name: "label" },
      sourceId: "e_issue",
      as: "labels",
      targetIds: { add: ["e_label1", "e_label2"], remove: [] },
      hlc: () => "hlc_1",
      newId: (() => {
        let next = 0;
        return () => `u_${++next}`;
      })(),
    });

    expect(result.relationshipUpdates).toHaveLength(2);
    expect(
      result.relationshipUpdates.map((update) =>
        Object.keys(edgeLeaves(update, "labels", "issue")),
      ),
    ).toEqual([["e_label1"], ["e_label2"]]);
  });
});

/** Run one verb through the shared verb table with the given live targets. */
const planned = (
  registry: ReturnType<typeof buildRegistry>,
  verb: Parameters<typeof operationCallFor>[1],
  targets: readonly string[] | undefined,
): readonly Update[] => {
  const entry = operationCallFor(registry, verb, {
    groupsOf: () => [],
    targetsOf: () => targets,
  });
  if (entry === undefined) return [];
  return entry.operation(
    {
      registry,
      actorId: "a_actor",
      ids: {
        updateId: (() => {
          let next = 0;
          return () => `u_${++next}`;
        })(),
        hlc: () => "hlc_1",
        newId: (prefix: string) => `${prefix}_1`,
      },
    },
    entry.input,
  ).updates;
};

describe("the verb layer", () => {
  it("moves a one-cardinality edge in one Update: tombstone the old key, presence the new", () => {
    const registry = buildRegistry();

    const updates = planned(
      registry,
      { verb: "relate", entity: "issue", id: "e_issue", as: "project", target: "e_new" },
      ["e_old"],
    );

    expect(updates).toHaveLength(1);
    const leaves = edgeLeaves(updates[0], "project", "issue");
    expect(leaves["e_old"]).toMatchObject({ value: null });
    expect(leaves["e_new"]).toMatchObject({ value: true });
  });

  it("removes a named target with one tombstone and no read", () => {
    const registry = buildRegistry();

    // `undefined` is the unknown resolution: a named key needs no read.
    const updates = planned(
      registry,
      { verb: "unrelate", entity: "issue", id: "e_issue", as: "project", target: "e_old" },
      undefined,
    );

    expect(updates).toHaveLength(1);
    expect(Object.keys(edgeLeaves(updates[0], "project", "issue"))).toEqual(["e_old"]);
    expect(edgeLeaves(updates[0], "project", "issue")["e_old"]).toMatchObject({ value: null });
  });

  it("clears an accessor from the live set the resolution supplies", () => {
    const registry = buildRegistry();

    const updates = planned(
      registry,
      { verb: "unrelate", entity: "issue", id: "e_issue", as: "labels" },
      ["e_l1", "e_l2"],
    );

    expect(updates).toHaveLength(2);
    expect(updates.map((update) => Object.keys(edgeLeaves(update, "labels", "issue")))).toEqual([
      ["e_l1"],
      ["e_l2"],
    ]);
  });

  it("refuses to clear an accessor it cannot read, without naming a row id", () => {
    const registry = buildRegistry();

    expect(() =>
      planned(
        registry,
        { verb: "unrelate", entity: "issue", id: "e_issue", as: "labels" },
        undefined,
      ),
    ).toThrow(/cannot read the live "labels" edges/);
  });

  it("diffs a replace against the live set", () => {
    const registry = buildRegistry();

    const updates = planned(
      registry,
      {
        verb: "relate",
        entity: "issue",
        id: "e_issue",
        as: "labels",
        targets: ["e_l1", "e_l3"],
        replace: true,
      },
      ["e_l1", "e_l2"],
    );

    const written = updates.map((update) => edgeLeaves(update, "labels", "issue"));
    expect(written).toHaveLength(2);
    expect(written.map((leaves) => Object.keys(leaves)[0])).toEqual(["e_l3", "e_l2"]);
    expect(written[0]!["e_l3"]).toMatchObject({ value: true });
    expect(written[1]!["e_l2"]).toMatchObject({ value: null });
  });

  it("refuses a replace rather than leave the edges it cannot see", () => {
    const registry = buildRegistry();

    expect(() =>
      planned(
        registry,
        {
          verb: "relate",
          entity: "issue",
          id: "e_issue",
          as: "labels",
          targets: ["e_l1"],
          replace: true,
        },
        undefined,
      ),
    ).toThrow(/cannot read the live "labels" edges/);
  });

  it("adds a target set without tombstoning the live edges it does not name", () => {
    const registry = buildRegistry();

    const updates = planned(
      registry,
      { verb: "relate", entity: "issue", id: "e_issue", as: "labels", targets: ["e_l3"] },
      ["e_l1", "e_l2"],
    );

    const written = updates.map((update) => edgeLeaves(update, "labels", "issue"));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ e_l3: { value: true } });
  });

  it("adds one target without tombstoning its sibling", () => {
    const registry = buildRegistry();

    const updates = planned(
      registry,
      { verb: "relate", entity: "issue", id: "e_issue", as: "labels", target: "e_l2" },
      ["e_l1"],
    );

    const written = updates.map((update) => edgeLeaves(update, "labels", "issue"));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ e_l2: { value: true } });
  });
});
