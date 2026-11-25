/**
 * A cold projection runs the plan once (#962).
 *
 * The reactive path narrows the page with one plan. When a projected component
 * is not resident, that narrowed page is what acquisition needs, so the same
 * rows are acquired and projected instead of planning the page a second time.
 * The awaited path already runs one plan.
 */

import { describe, expect, it } from "vitest";
import { makeHlc, type Entity, type FieldValue } from "@ebbjs/core";
import { createReplica, REPLICA_RECORD_FORMAT } from "@ebbjs/storage/replica";
import type { ReplicaRecord } from "@ebbjs/storage/types";
import { defineModel, e, ModelRegistry, seedRegistry } from "@ebbjs/schema";

import { buildReplicaQueryBuilder, type QueryContext } from "../query-builder";
import { createQueryResults } from "../query-results";
import { createSubscriptionRegistry } from "../subscriptions";
import { traversalCounter } from "../traversal-counter";
import { waitFor } from "../test-utils";

const page = defineModel("page", {
  title: e.string(),
  icon: e.string(),
  updated_at: e.number(),
});

const registry = new ModelRegistry();
seedRegistry(registry, { page }, undefined);

const GROUP_ID = "grp_1";
const PAGES = 3;

const leaf = (value: unknown, updateId: string): FieldValue => ({
  value,
  update_id: updateId,
  hlc: makeHlc(1),
});

const pageRow = (index: number): Entity => ({
  id: `page_${index}`,
  model: "page",
  data: {
    fields: {
      title: leaf(`Title ${index}`, `u_page_${index}_title`),
      icon: leaf("📄", `u_page_${index}_icon`),
      updated_at: leaf(1_700_000_000_000 + index, `u_page_${index}_updated_at`),
    },
  },
  exists: true,
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 0,
});

const membershipRow = (index: number): Entity => ({
  id: `eg_${index}`,
  model: "ebb",
  data: {
    fields: {
      membership: leaf(
        { entity_id: `page_${index}`, group_id: GROUP_ID },
        `u_eg_${index}_membership`,
      ),
    },
  },
  exists: true,
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 0,
});

/** The fixture's pages with `page/icon` stripped: only the store can serve it. */
const coldPageRow = (index: number): Entity => {
  const row = pageRow(index);
  const { icon: _icon, ...fields } = row.data.fields;
  return { ...row, data: { fields } };
};

const record = (entities: readonly Entity[]): ReplicaRecord => ({
  format: REPLICA_RECORD_FORMAT,
  componentVersions: {},
  position: 0,
  revision: 1,
  entities,
});

/**
 * The shipped chain over a scratch replica, mounted the way `namespace.ts`
 * mounts a projection. The store holds the full rows, so a component the
 * record left out is acquisition's to install.
 */
const chainOver = (entities: readonly Entity[]) => {
  const rows = new Map<string, Entity>();
  for (let index = 0; index < PAGES; index += 1) {
    const full = pageRow(index);
    rows.set(full.id, full);
    rows.set(`eg_${index}`, membershipRow(index));
  }
  const replica = createReplica({
    readComponent: async (id) => rows.get(id) ?? null,
    residencyTtlMs: 0,
  });
  replica.load(record(entities));
  const context: QueryContext = {
    entityName: "page",
    registry,
    replica,
    results: createQueryResults(replica, createSubscriptionRegistry(replica)),
    hydrated: () => true,
    hydrate: async () => {},
  };
  return buildReplicaQueryBuilder("page", page.shape, context);
};

const coldChain = () =>
  chainOver([
    ...Array.from({ length: PAGES }, (_, index) => coldPageRow(index)),
    ...Array.from({ length: PAGES }, (_, index) => membershipRow(index)),
  ]);

const residentChain = () =>
  chainOver([
    ...Array.from({ length: PAGES }, (_, index) => pageRow(index)),
    ...Array.from({ length: PAGES }, (_, index) => membershipRow(index)),
  ]);

describe("plan runs per projection (#962)", () => {
  it("runs the narrowing plan once for a cold projection", async () => {
    const chain = coldChain();
    const store = chain.result();
    traversalCounter.reset();
    const detach = store.subscribe(() => {});
    await waitFor(() => store.getSnapshot().status === "current");

    expect(traversalCounter.planRuns).toBe(1);
    detach();
  });

  it("projects the rows the awaited chain projects", async () => {
    const chain = coldChain();
    const store = chain.result();
    const detach = store.subscribe(() => {});
    await waitFor(() => store.getSnapshot().status === "current");
    const projected = store.getSnapshot().data ?? [];
    const awaited = await chain;

    expect(projected).toEqual(awaited);
    expect(projected.map((row) => row.groupIds)).toEqual(
      Array.from({ length: PAGES }, () => [GROUP_ID]),
    );
    expect(projected.map((row) => row.id)).toEqual(
      Array.from({ length: PAGES }, (_, index) => `page_${index}`),
    );
    detach();
  });

  it("settles a resident projection synchronously and runs one plan", () => {
    const chain = residentChain();
    const store = chain.result();
    traversalCounter.reset();
    const detach = store.subscribe(() => {});

    expect(store.getSnapshot().status).toBe("current");
    expect(traversalCounter.planRuns).toBe(1);
    detach();
  });

  it("runs one plan on the awaited cold path", async () => {
    const chain = coldChain();
    traversalCounter.reset();
    const rows = await chain;

    expect(rows).toHaveLength(PAGES);
    expect(traversalCounter.planRuns).toBe(1);
  });
});
