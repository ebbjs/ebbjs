/**
 * The shipped patch rate (#942) through the real `client.<model>.query()` path.
 *
 * The benchmark's patch table drives a local source, so its `patches/change`
 * describes the results view's dispatcher, not the projection a real query runs. A
 * real unselected read expands `<model>/*` to every registered component, and
 * the patch declines a row it cannot prove is resident: a projected component
 * the row does not carry turns every projected write on that row into a re-run.
 * Residency is per component and follows what the row carries (#943), so an
 * optional component no row carries is the same cliff. This measures it on a
 * page-like model at a size where a re-run is expensive, and pins the number so
 * a change in the rate is visible.
 */

import { describe, expect, it } from "vitest";
import { makeHlc, type Action, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import { defineComponent, defineModel, defineSchema, e } from "@ebbjs/schema";

import { createClient } from "../client";
import { callApplyAction, flushTasks, rowComponents, waitFor } from "../test-utils";
import { traversalCounter } from "../traversal-counter";

// A page carries small metadata, a body, and an optional attachment that not
// every page carries; a projected component a row has no value for is not
// resident, and the patch declines that row.
const page = defineModel("page", {
  title: e.string(),
  updated_at: e.string(),
  body: defineComponent("page/body", e.string()),
  attachment: defineComponent("page/attachment", e.string(), { optional: true }),
});
const schema = defineSchema({ models: { page }, version: 1 });
type Client = ReturnType<typeof createClient<typeof schema>>;

const PAGES = 200;
const EDITS = 40;

const field = (value: unknown, updateId: string, gsn: number) => ({
  value,
  update_id: updateId,
  hlc: makeHlc(1_711_036_800_000 + gsn),
});

const put = (gsn: number, id: string, fields: Record<string, unknown>): Action => ({
  id: `a_${gsn}`,
  actor_id: "actor_1",
  hlc: makeHlc(1_711_036_800_000, gsn),
  gsn,
  updates: rowComponents("page", fields).map(
    ([component, value]): Update => ({
      id: `u_${gsn}_${component}`,
      subject_id: id,
      component,
      method: "replace" as const,
      data: field(value, `u_${gsn}`, gsn),
    }),
  ),
});

interface Rate {
  readonly patches: number;
  readonly runs: number;
}

/**
 * One title edit per page for the first `EDITS` pages: settle the previous
 * change, then count what the next one made the result read. A patch reads the
 * one changed row; a re-run scans the whole type.
 */
const measureRate = async (carriesAttachment: (index: number) => boolean): Promise<Rate> => {
  const client: Client = createClient({
    serverUrl: "http://x",
    actorId: "actor_1",
    storage: createMemoryAdapter(),
    schema,
  });
  for (let index = 0; index < PAGES; index += 1) {
    const attachment = carriesAttachment(index) ? { attachment: `attachment ${index}` } : {};
    await callApplyAction(
      client,
      put(index + 1, `page_${index}`, {
        title: `Page ${index}`,
        updated_at: `updated ${index}`,
        body: `body ${index}`,
        ...attachment,
      }),
      "grp_1",
    );
  }

  const store = client.page.query().result();
  const detach = store.subscribe(() => {});
  await waitFor(() => store.getSnapshot().status === "current");
  await flushTasks();

  let patches = 0;
  let runs = 0;
  for (let index = 0; index < EDITS; index += 1) {
    const id = `page_${index}`;
    const title = `Edited ${index}`;
    const gsn = PAGES + index + 1;
    await waitFor(() => store.getSnapshot().status === "current");
    await flushTasks();
    traversalCounter.reset();
    const next = put(gsn, id, { title });
    client.replica.ingest(next, next.updates, gsn);
    await waitFor(
      () =>
        store.getSnapshot().status === "current" &&
        (store.getSnapshot().data ?? []).some(
          (candidate) => candidate.id === id && candidate.title === title,
        ),
    );
    const rowsRead = traversalCounter.resultRowsRead;
    if (rowsRead === 1) patches += 1;
    else if (rowsRead >= PAGES) runs += 1;
    else throw new Error(`unexpected result read of ${rowsRead} rows for one edit`);
  }

  // The patched and re-run rows both serve the replica's value.
  for (let index = 0; index < EDITS; index += 1) {
    expect(store.getSnapshot().data?.find((row) => row.id === `page_${index}`)?.title).toBe(
      `Edited ${index}`,
    );
  }
  expect(store.getSnapshot().data).toHaveLength(PAGES);
  detach();
  return { patches, runs };
};

describe("shipped patch rate through client.<model>.query() (#942)", () => {
  it("patches every projected write when every projected component is resident", async () => {
    // Every row carries every registered component, so the priming run leaves
    // every projected component resident.
    const rate = await measureRate(() => true);
    // A fake source patching at 1.00 is only honest for this shape.
    expect(rate).toEqual({ patches: EDITS, runs: 0 });
  });

  it("falls back to a re-run on a row that carries no optional projected component", async () => {
    // One page in ten carries the optional attachment; the patch declines on
    // the other nine because an unselected read projects a component those
    // rows have no value for.
    const rate = await measureRate((index) => index % 10 === 0);
    expect(rate).toEqual({ patches: EDITS / 10, runs: EDITS - EDITS / 10 });
  });

  it("re-runs every projected write when an optional projected component is absent", async () => {
    // A schema whose optional component no row carries is the worst case:
    // every row is one the patch cannot prove is resident for what it projects.
    const rate = await measureRate(() => false);
    expect(rate).toEqual({ patches: 0, runs: EDITS });
  });
});
