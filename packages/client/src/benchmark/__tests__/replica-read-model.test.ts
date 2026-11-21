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
import { carriesComponent, isFieldMap, linkEdges } from "@ebbjs/core";
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
  replicaAdjacency,
  replicaRowReader,
} from "../harness";
import {
  configWith,
  createResidentRows,
  createWorkspace,
  BODY_TYPE,
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
    readComponent: store.read,
    // Disabled so a read stays warm across the assertions below.
    residencyTtlMs: 0,
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
    // A link is a key of its source row, so the edges a page carries are read
    // off the page itself.
    for (const edge of linkEdges(entity)) {
      if (edge.as === "parent") {
        parent.set(entity.id, edge.targetId);
        append(children, edge.targetId, entity.id);
      } else if (edge.as === "references") {
        append(references, entity.id, edge.targetId);
        append(backlinks, edge.targetId, entity.id);
      }
    }
    if (carriesComponent(entity, "membership")) {
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
  it("builds the resident rows the workspace record holds", () => {
    const { workspace } = setup(N);
    const resident = createResidentRows(workspace.config);
    const recordResident = workspace.record.entities;

    expect(resident.length).toBe(workspace.counts.residentRows);
    expect(resident.length).toBe(recordResident.length);
    expect(idsOf(resident)).toEqual(idsOf(recordResident));
    expect(new Set(resident.map((entity) => entity.id)).size).toBe(resident.length);
    expect(resident.filter((entity) => entity.model === BODY_TYPE)).toEqual([]);
  });

  it("loads only the metadata rows", () => {
    const { replica, workspace } = setup(N);
    const stats = replica.stats();

    // The membership and group rows are the platform rows; a page's edges are
    // keys of the page row, so they add none.
    expect(stats.byModel).toEqual({
      page: N,
      ebb: N + 1,
    });
    expect(stats.entities).toBe(workspace.counts.residentRows);

    // One reverse entry per live edge plus one per membership row; only a
    // membership keeps a forward entry, because a source's own edges are a
    // component read of its row. The `group` row indexes nothing.
    const indexShape = summariseIndexKeys(workspace.record.entities);
    const edges = N - 1 + N * REFS_PER_PAGE;
    const indexable = edges + N;
    expect(indexShape.reverseRows).toBe(indexable);
    expect(indexShape.forwardRows).toBe(N);
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

      const groups = await membershipGroups(reader, adjacency, id, "ebb", groupShape);
      expect(idsOf(groups)).toEqual(distinct(tally.groups.get(id)));
    }
  });

  // #946/#957: bodies reach the replica folded whole in production, so this
  // fixture's metadata-plus-store split measures the benchmark's shape rather
  // than shipped residency. Do not read it as the memory a client keeps.
  it("keeps bodies off the loaded set: one store read cold, none while warm", async () => {
    const { workspace, store, replica } = setup(N);
    const stats = replica.stats();
    expect(stats.byModel.page_content).toBeUndefined();

    const body = workspace.bodyIds[0];
    expect(replica.get(body)).toBeUndefined();

    store.reset();
    const loaded = await replica.read(body, [`${BODY_TYPE}/content`]);
    expect(loaded?.id).toBe(body);
    expect(store.snapshot()).toEqual({ calls: 1, rows: 1 });
    const content = loaded?.data.fields["content"];
    expect(content !== undefined && isFieldMap(content) ? Object.keys(content.map).length : 0).toBe(
      3,
    );

    // The read released its claim before returning, so the body is resident on
    // the grace period alone, and a warm re-read reads nothing.
    store.reset();
    await replica.read(body, [`${BODY_TYPE}/content`]);
    expect(store.snapshot().calls).toBe(0);
    expect(replica.stats().leases).toMatchObject({
      leased: 0,
      inactive: 1,
      resident: 1,
      byComponent: { "page_content/content": { leased: 0, inactive: 1 } },
    });
  });

  // #943: a synced body is resident whole, and #957 is where reclaiming it is
  // decided. The fixture's store-backed split measures the read path, not the
  // memory a real client keeps.
  it("keeps a folded body resident with no lease to release it", () => {
    const { workspace } = setup(N);
    const body = workspace.rows.get(workspace.bodyIds[0] ?? "");
    if (body === undefined) throw new Error("fixture produced no body row");
    const folded = createReplica({});
    folded.load({ ...workspace.record, entities: [...workspace.record.entities, body] });

    expect(folded.stats().byModel[BODY_TYPE]).toBe(1);
    expect(folded.stats().leases).toMatchObject({ leased: 0, inactive: 0, resident: 0 });
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
    expect(replica.relationships({ as: "parent", type: "page", sourceId: missing })).toEqual([]);
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
