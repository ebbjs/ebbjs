/**
 * Structural invariants of the replica read-model benchmark (#503).
 *
 * The benchmark itself measures wall-clock and heap, which no test should
 * assert on. What it must never do is measure the wrong thing: a fixture whose
 * degrees are not what its report claims, a body that is silently resident, or
 * a traversal that reaches the store instead of the replica's index. Those are
 * shape properties, so they are asserted here at a few hundred rows.
 */

import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { isFieldMap } from "@ebbjs/core";
import type { Entity } from "@ebbjs/core";
import { createReplica } from "@ebbjs/storage/replica";

import {
  type AdjacencyReader,
  forwardMany,
  forwardOne,
  membershipGroups,
  reverse,
} from "../../sync/relationship";
import {
  createCounterSet,
  createCountingStore,
  createIndexCounter,
  heldMetadata,
  replicaAdjacency,
  replicaRowReader,
} from "../harness";
import {
  configWith,
  createHeldRows,
  createWorkspace,
  ON_DEMAND_TYPE,
  pageId,
  parentIndexOf,
  referenceTargetIndex,
  spreadIndices,
  stringField,
  summariseIndexKeys,
} from "../workspace";

const N = 300;
const BRANCH = 10;
const REFS_PER_PAGE = 2;

const pageShape = Type.Object({ title: Type.String() });
const groupShape = Type.Object({ name: Type.String() });

const setup = (n: number) => {
  const config = configWith({
    n,
    branch: BRANCH,
    refsPerPage: REFS_PER_PAGE,
    bodyBlocks: 3,
    bodyChars: 40,
  });
  const workspace = createWorkspace(config);
  const store = createCountingStore(workspace.rows);
  const replica = createReplica({
    materialization: heldMetadata,
    readEntity: store.read,
    pinnedCapacity: 1,
    pinnedTtlMs: 0,
  });
  replica.load(workspace.record);
  const index = createIndexCounter();
  const adjacency: AdjacencyReader = index.adjacency(replicaAdjacency(replica));
  return {
    workspace,
    store,
    replica,
    adjacency,
    reader: replicaRowReader(replica),
    counters: createCounterSet(store, index),
  };
};

const append = (map: Map<string, string[]>, key: string, value: string): void => {
  const values = map.get(key);
  if (values === undefined) map.set(key, [value]);
  else values.push(value);
};

const distinct = (values: readonly string[] | undefined): readonly string[] =>
  [...new Set(values ?? [])].sort();

/**
 * Expected adjacency read straight off the fixture rows — a naive recount that
 * shares no code with the replica's index derivation, so a generator change
 * that breaks the documented shape fails here.
 */
interface Tally {
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly parent: ReadonlyMap<string, string>;
  readonly references: ReadonlyMap<string, readonly string[]>;
  readonly backlinks: ReadonlyMap<string, readonly string[]>;
  readonly groups: ReadonlyMap<string, readonly string[]>;
}

const tallyWorkspace = (rows: readonly Entity[]): Tally => {
  const children = new Map<string, string[]>();
  const parent = new Map<string, string>();
  const references = new Map<string, string[]>();
  const backlinks = new Map<string, string[]>();
  const groups = new Map<string, string[]>();

  for (const entity of rows) {
    if (entity.type === "relationship") {
      const source = stringField(entity, "source_id");
      const target = stringField(entity, "target_id");
      const field = stringField(entity, "field");
      if (source === undefined || target === undefined) continue;
      if (field === "parent") {
        parent.set(source, target);
        append(children, target, source);
      } else if (field === "references") {
        append(references, source, target);
        append(backlinks, target, source);
      }
      continue;
    }
    if (entity.type === "entityGroup") {
      const member = stringField(entity, "entity_id");
      const group = stringField(entity, "group_id");
      if (member !== undefined && group !== undefined) append(groups, member, group);
    }
  }

  return { children, parent, references, backlinks, groups };
};

const idsOf = (rows: readonly { readonly id: string }[]): readonly string[] =>
  rows.map((row) => row.id).sort();

describe("replica read-model workspace", () => {
  it("builds the held rows the workspace record holds", () => {
    const { workspace } = setup(N);
    const held = createHeldRows(workspace.config);
    const recordHeld = workspace.record.entities.filter((entity) =>
      heldMetadata.holds(entity.type),
    );

    expect(held.length).toBe(workspace.counts.heldRows);
    expect(held.length).toBe(recordHeld.length);
    expect(idsOf(held)).toEqual(idsOf(recordHeld));
    expect(new Set(held.map((entity) => entity.id)).size).toBe(held.length);
    expect(held.filter((entity) => entity.type === ON_DEMAND_TYPE)).toEqual([]);
  });

  it("holds only the metadata rows", () => {
    const { replica, workspace } = setup(N);
    const stats = replica.stats();

    expect(stats.byType).toEqual({
      page: N,
      relationship: N - 1 + N * REFS_PER_PAGE,
      entityGroup: N,
      group: 1,
    });
    expect(stats.heldByType).toEqual(stats.byType);
    expect(stats.held).toBe(workspace.counts.heldRows);
    expect(stats.entities).toBe(workspace.counts.heldRows);

    // One derived index row per indexable row and direction: the parent edges,
    // the references edges, and the membership rows. The `group` row indexes
    // nothing.
    const indexShape = summariseIndexKeys(workspace.record.entities);
    const indexable = N - 1 + N * REFS_PER_PAGE + N;
    expect(indexShape.reverseRows).toBe(indexable);
    expect(indexShape.forwardRows).toBe(indexable);
    expect(indexShape.reverseKeys).toBeGreaterThan(0);
    expect(indexShape.reverseKeys).toBeLessThanOrEqual(indexable);
  });

  it("seeds the documented degrees", async () => {
    const { workspace, adjacency, reader } = setup(N);
    const tally = tallyWorkspace(workspace.record.entities);

    // Closed form, independent of the row recount: the root has BRANCH
    // children unless the tree is smaller than a branch.
    expect(tally.children.get(pageId(0))).toHaveLength(Math.min(BRANCH, N - 1));

    for (const index of spreadIndices(N, 12)) {
      const id = pageId(index);

      const children = await reverse(reader, adjacency, id, "page", pageShape, "parent", "page");
      expect(idsOf(children)).toEqual(distinct(tally.children.get(id)));

      const parent = await forwardOne(reader, adjacency, id, "page", "parent", "page");
      expect(parent?.id ?? null).toBe(tally.parent.get(id) ?? null);
      expect(parent?.id ?? null).toBe(index === 0 ? null : pageId(parentIndexOf(index, BRANCH)));

      const references = await forwardMany(
        reader,
        adjacency,
        id,
        "page",
        "page",
        pageShape,
        "references",
        "page",
      );
      expect(idsOf(references)).toEqual(distinct(tally.references.get(id)));
      expect(distinct(tally.references.get(id))).toEqual(
        [
          ...new Set(
            Array.from({ length: REFS_PER_PAGE }, (_, ref) => referenceTargetIndex(index, ref, N)),
          ),
        ]
          .sort((a, b) => a - b)
          .map(pageId),
      );

      const backlinks = await reverse(
        reader,
        adjacency,
        id,
        "page",
        pageShape,
        "references",
        "page",
      );
      expect(idsOf(backlinks)).toEqual(distinct(tally.backlinks.get(id)));

      const groups = await membershipGroups(reader, adjacency, id, "group", groupShape);
      expect(idsOf(groups)).toEqual(distinct(tally.groups.get(id)));
    }
  });

  it("keeps bodies windowed: not resident, one store read per open", async () => {
    const { workspace, store, replica } = setup(N);
    const stats = replica.stats();
    expect(stats.heldByType.page_content).toBeUndefined();
    expect(stats.byType.page_content).toBeUndefined();
    expect(workspace.counts.recordBodyRows).toBeGreaterThan(0);

    const body = workspace.bodyIds[0];
    expect(replica.get(body)).toBeUndefined();

    store.reset();
    const opened = await replica.open(body);
    expect(opened?.id).toBe(body);
    expect(store.snapshot()).toEqual({ calls: 1, rows: 1 });
    const content = opened?.data.fields["content"];
    expect(content !== undefined && isFieldMap(content) ? Object.keys(content.map).length : 0).toBe(
      3,
    );

    // A second open finds the pinned row: no second read.
    await replica.open(body);
    expect(store.snapshot().calls).toBe(1);

    // Closed with TTL 0 the row leaves, so the next open reads it again.
    replica.close(body);
    expect(replica.get(body)).toBeUndefined();
    await replica.open(body);
    expect(store.snapshot().calls).toBe(2);

    replica.close(body);
    expect(replica.stats().pinned).toBe(0);
    expect(replica.stats().byType.page_content).toBeUndefined();
  });

  it("reads traversals off the replica index, never the store", async () => {
    const { adjacency, reader, counters } = setup(N);

    const reads = [
      (id: string) => reverse(reader, adjacency, id, "page", pageShape, "parent", "page"),
      (id: string) => forwardOne(reader, adjacency, id, "page", "parent", "page"),
      (id: string) =>
        forwardMany(reader, adjacency, id, "page", "page", pageShape, "references", "page"),
      (id: string) => reverse(reader, adjacency, id, "page", pageShape, "references", "page"),
      (id: string) => membershipGroups(reader, adjacency, id, "group", groupShape),
    ];

    for (const index of spreadIndices(N, 8)) {
      for (const read of reads) {
        counters.reset();
        await read(pageId(index));
        expect(counters.snapshot().storeReads).toBe(0);
        expect(counters.snapshot().storeRows).toBe(0);
      }
    }

    // Rows examined are the row's degree plus its by-id loads, in closed form.
    counters.reset();
    await forwardOne(reader, adjacency, pageId(1), "page", "parent", "page");
    expect(counters.snapshot().rowsExamined).toBe(3);

    counters.reset();
    await membershipGroups(reader, adjacency, pageId(1), "group", groupShape);
    expect(counters.snapshot().rowsExamined).toBe(2);

    counters.reset();
    await forwardMany(
      reader,
      adjacency,
      pageId(1),
      "page",
      "page",
      pageShape,
      "references",
      "page",
    );
    expect(counters.snapshot().rowsExamined).toBe(1 + REFS_PER_PAGE * 2);

    counters.reset();
    const children = await reverse(
      reader,
      adjacency,
      pageId(0),
      "page",
      pageShape,
      "parent",
      "page",
    );
    expect(counters.snapshot().rowsExamined).toBe(2 * children.length);
    expect(counters.snapshot().indexRows).toBe(children.length);
  });

  it("examines the same rows regardless of workspace size", async () => {
    const measure = async (n: number) => {
      const { workspace, adjacency, reader, counters } = setup(n);
      const page = pageId(1);
      const sample = async (read: (id: string) => unknown): Promise<number> => {
        counters.reset();
        await read(page);
        return counters.snapshot().rowsExamined;
      };
      const result = {
        children: await sample((id) =>
          reverse(reader, adjacency, id, "page", pageShape, "parent", "page"),
        ),
        parent: await sample((id) => forwardOne(reader, adjacency, id, "page", "parent", "page")),
        references: await sample((id) =>
          forwardMany(reader, adjacency, id, "page", "page", pageShape, "references", "page"),
        ),
        groups: await sample((id) => membershipGroups(reader, adjacency, id, "group", groupShape)),
      };
      expect(workspace.counts.pages).toBe(n);
      return result;
    };

    expect(await measure(120)).toEqual(await measure(600));
  });

  it("reads an unknown id as nothing, without scanning", async () => {
    const { replica, adjacency, reader, counters } = setup(N);
    const missing = "page_missing";

    expect(replica.get(missing)).toBeUndefined();
    expect(replica.relationships({ as: "parent", type: "page", targetId: missing })).toEqual([]);
    expect(replica.relationshipLinks({ as: "parent", type: "page", sourceId: missing })).toEqual(
      [],
    );
    expect(replica.memberships({ entityId: missing })).toEqual([]);
    expect(replica.membershipLinks(missing)).toEqual([]);

    counters.reset();
    expect(await reverse(reader, adjacency, missing, "page", pageShape, "parent", "page")).toEqual(
      [],
    );
    expect(counters.snapshot()).toEqual({
      storeReads: 0,
      storeRows: 0,
      indexRows: 0,
      rowsExamined: 0,
    });

    // One by-id miss, not a type scan.
    counters.reset();
    expect(await forwardOne(reader, adjacency, missing, "page", "parent", "page")).toBeUndefined();
    expect(counters.snapshot()).toEqual({
      storeReads: 0,
      storeRows: 0,
      indexRows: 0,
      rowsExamined: 1,
    });
  });
});
