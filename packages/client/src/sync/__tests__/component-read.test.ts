/**
 * Component-scoped single-row reads and the `unloaded` subscription event
 * (#779).
 *
 * `client.<entity>.get(id, { components })` materializes only the components
 * the caller names, so reading one lazy log never drags in its siblings and a
 * provider can read an eager `engine` before paying for the log. A row
 * subscription reports each tracked component leaving the replica, whatever
 * released it, instead of silently dying.
 */

import { describe, expect, it } from "vitest";
import {
  makeHlc,
  type Action,
  type ComponentName,
  type FieldValue,
  type Update,
} from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

import { defineComponent, defineModel, defineRelationship, defineSchema, e } from "@ebbjs/schema";
import { createClient } from "../client";
import type { EntityEvent } from "../namespace";
import { callApplyAction, linkAction, waitFor } from "../test-utils";

const doc = defineModel("doc", {
  title: e.string(),
  engine: e.string(),
  content: defineComponent("doc/content", e.log(e.string()), { loading: "lazy" }),
  versions: defineComponent("doc/versions", e.log(e.string()), { loading: "lazy" }),
});

/** Every component is lazy, so the row is resident only while pinned. */
const blob = defineModel(
  "blob",
  { content: defineComponent("blob/content", e.string(), { loading: "lazy" }) },
  { materialization: "on-demand" },
);

const page = defineModel("page", { title: e.string() });

const schema = defineSchema({
  models: { doc, blob, page },
  relationships: {
    body: defineRelationship({ source: page, target: blob, as: "body" }),
  },
  version: 1,
});

interface HarnessOptions {
  readonly cacheCapacity?: number;
  readonly cacheTtlMs?: number;
}

const harness = (opts: HarnessOptions = {}) => {
  const storage = createMemoryAdapter();
  const client = createClient({
    serverUrl: "http://x",
    actorId: "actor_1",
    storage,
    schema,
    fetchImpl: (async () => new Response("{}")) as typeof fetch,
    ...opts,
  });
  return { client, storage };
};

type TestClient = ReturnType<typeof harness>["client"];

/** One event the test inspects for `type` / `component` (the row has an id). */
type DocEvent = EntityEvent<{ readonly id: string }>;

const leaf = (value: unknown, updateId: string): FieldValue => ({
  value,
  update_id: updateId,
  hlc: makeHlc(1),
});

const mapOf = (entries: Record<string, FieldValue>): FieldValue => ({ map: entries });

const seedAction = (gsn: number, updates: readonly Update[]): Action => ({
  id: `a_${gsn}`,
  actor_id: "actor_1",
  hlc: makeHlc(1_711_036_800_000 + gsn),
  gsn,
  updates: [...updates],
});

const created = (id: string, model: string, hlc: string): Update => ({
  id: `u_${id}_create`,
  subject_id: id,
  model,
  method: "create",
  hlc,
  data: null,
});

const replaced = (
  subjectId: string,
  component: ComponentName,
  data: FieldValue,
  key: string,
): Update => ({
  id: `u_${subjectId}_${key}`,
  subject_id: subjectId,
  component,
  method: "replace",
  data,
});

const merged = (
  subjectId: string,
  component: ComponentName,
  data: FieldValue,
  key: string,
): Update => ({
  id: `u_${subjectId}_${key}`,
  subject_id: subjectId,
  component,
  method: "merge",
  data,
});

const DOC = "doc_1";
const ENGINE = "yjs.update.v1";

/** Create one document with held metadata and two lazy logs. */
const seedDoc = async (client: TestClient, gsn: number, id = DOC): Promise<void> => {
  const hlc = makeHlc(1_711_036_800_000 + gsn);
  await callApplyAction(
    client,
    seedAction(gsn, [
      created(id, "doc", hlc),
      replaced(id, "doc/title", leaf("One", `u_${id}_title`), "title"),
      replaced(id, "doc/engine", leaf(ENGINE, `u_${id}_engine`), "engine"),
      merged(id, "doc/content", mapOf({ run_1: leaf("hello", `u_${id}_content`) }), "content"),
      merged(id, "doc/versions", mapOf({ v1: leaf("first", `u_${id}_versions`) }), "versions"),
    ]),
  );
};

/** Create a fully on-demand row carrying one lazy component. */
const seedBlob = async (client: TestClient, gsn: number, id: string): Promise<void> => {
  const hlc = makeHlc(1_711_036_800_000 + gsn);
  await callApplyAction(
    client,
    seedAction(gsn, [
      created(id, "blob", hlc),
      replaced(id, "blob/content", leaf("body", `u_${id}_content`), "content"),
    ]),
  );
};

describe("client.<entity>.get(id, { components })", () => {
  it("materializes only the requested lazy component", async () => {
    const { client } = harness();
    await seedDoc(client, 1);

    const row = await client.doc.get(DOC, { components: ["doc/content"] });

    expect(row?.content).toEqual({ run_1: "hello" });
    expect(client.replica.isComponentResident(DOC, "doc/content")).toBe(true);
    expect(client.replica.isComponentResident(DOC, "doc/versions")).toBe(false);
    expect(client.replica.isOpen(DOC, "doc/content")).toBe(true);
    expect(client.replica.isOpen(DOC, "doc/versions")).toBe(false);
    expect(client.replicaStats.pinnedComponents).toEqual({ "doc/content": 1 });
  });

  it("accepts a field key as well as a full component name", async () => {
    const { client } = harness();
    await seedDoc(client, 1);

    const row = await client.doc.get(DOC, { components: ["content"] });

    expect(row?.content).toEqual({ run_1: "hello" });
    expect(client.replica.isOpen(DOC, "doc/versions")).toBe(false);
  });

  it("shares one pin across repeated reads of the same component", async () => {
    const { client } = harness();
    await seedDoc(client, 1);

    await client.doc.get(DOC, { components: ["doc/content"] });
    await client.doc.get(DOC, { components: ["doc/content"] });

    expect(client.replicaStats.pinnedComponents).toEqual({ "doc/content": 1 });
  });

  it("throws for a component the entity does not declare", async () => {
    const { client } = harness();
    await seedDoc(client, 1);

    await expect(client.doc.get(DOC, { components: ["missing"] })).rejects.toThrow(
      /client\.doc\.get\(\): the model "doc" does not declare a component "missing"/,
    );
  });

  it("reads an eager component without materializing the lazy log", async () => {
    const { client } = harness();
    await seedDoc(client, 1);

    const row = await client.doc.get(DOC, { components: ["doc/engine"] });

    expect(row?.engine).toBe(ENGINE);
    expect(client.replica.isComponentResident(DOC, "doc/content")).toBe(false);
    expect(client.replica.isOpen(DOC, "doc/content")).toBe(false);
    expect(client.replicaStats.pinned).toBe(0);

    const loaded = await client.doc.get(DOC, { components: ["doc/content"] });
    expect(loaded?.content).toEqual({ run_1: "hello" });
    expect(client.replica.isComponentResident(DOC, "doc/content")).toBe(true);
  });

  it("opens every component the stored row carries when no selection is given", async () => {
    const { client } = harness();
    await seedDoc(client, 1);

    const row = await client.doc.get(DOC);

    expect(row?.content).toEqual({ run_1: "hello" });
    expect(row?.versions).toEqual({ v1: "first" });
    expect(client.replicaStats.pinnedComponents).toEqual({
      "doc/content": 1,
      "doc/versions": 1,
    });
    expect(client.replicaStats.nonResident).toBe(0);
  });
});

describe("row.subscribe unloaded events", () => {
  it("reports exactly one unloaded event for an explicitly closed component", async () => {
    const { client } = harness({ cacheTtlMs: 0 });
    await seedDoc(client, 1);
    const row = await client.doc.get(DOC, { components: ["doc/content"] });
    const seen: DocEvent[] = [];
    row!.subscribe((event) => seen.push(event));

    client.replica.close(DOC, "doc/content");

    expect(seen).toEqual([{ type: "unloaded", component: "doc/content" }]);
    // The row's held metadata keeps the row itself resident.
    expect(client.replica.get(DOC)).toBeDefined();
  });

  it("reports unloaded when the pin TTL releases the component", async () => {
    const { client } = harness({ cacheTtlMs: 10 });
    await seedDoc(client, 1);
    const row = await client.doc.get(DOC, { components: ["doc/content"] });
    const seen: DocEvent[] = [];
    row!.subscribe((event) => seen.push(event));

    client.replica.close(DOC, "doc/content");
    await waitFor(() => seen.length > 0);

    expect(seen).toEqual([{ type: "unloaded", component: "doc/content" }]);
  });

  it("reports unloaded for the component capacity eviction releases", async () => {
    const { client } = harness({ cacheCapacity: 1, cacheTtlMs: 0 });
    await seedDoc(client, 1, "doc_1");
    await seedDoc(client, 2, "doc_2");
    const first = await client.doc.get("doc_1", { components: ["doc/content"] });
    const seen: DocEvent[] = [];
    first!.subscribe((event) => seen.push(event));

    await client.doc.get("doc_2", { components: ["doc/content"] });

    expect(seen).toEqual([{ type: "unloaded", component: "doc/content" }]);
    // Only the component was evicted; the held metadata stays.
    expect(client.replica.get("doc_1")).toBeDefined();
  });

  it("reports a whole-row unload when the replica drops the row", async () => {
    const { client } = harness({ cacheCapacity: 1, cacheTtlMs: 0 });
    await seedBlob(client, 1, "blob_1");
    await seedBlob(client, 2, "blob_2");
    const first = await client.blob.get("blob_1", { components: ["blob/content"] });
    const seen: DocEvent[] = [];
    first!.subscribe((event) => seen.push(event));

    await client.blob.get("blob_2", { components: ["blob/content"] });

    expect(seen).toEqual([{ type: "unloaded" }]);
    expect(client.replica.get("blob_1")).toBeUndefined();
  });

  it("re-opens and replays the log after an unload", async () => {
    const { client } = harness({ cacheTtlMs: 0 });
    await seedDoc(client, 1);
    const row = await client.doc.get(DOC, { components: ["doc/content"] });
    const seen: DocEvent[] = [];
    row!.subscribe((event) => seen.push(event));
    client.replica.close(DOC, "doc/content");
    expect(seen).toEqual([{ type: "unloaded", component: "doc/content" }]);

    // A remote append lands in the durable store while the component is not
    // resident; the replica keeps only its existence.
    await callApplyAction(
      client,
      seedAction(2, [
        merged(DOC, "doc/content", mapOf({ run_2: leaf("world", "u_content_2") }), "append"),
      ]),
    );
    expect(client.replica.isComponentResident(DOC, "doc/content")).toBe(false);

    const reopened = await client.doc.get(DOC, { components: ["doc/content"] });

    expect(reopened?.content).toEqual({ run_1: "hello", run_2: "world" });
  });

  it("delivers a remote append to an open lazy log", async () => {
    const { client } = harness();
    await seedDoc(client, 1);
    const row = await client.doc.get(DOC, { components: ["doc/content"] });
    const seen: string[] = [];
    row!.subscribe((event) => {
      if (event.type === "snapshot") seen.push(...Object.values(event.row.content ?? {}));
    });

    await callApplyAction(
      client,
      seedAction(2, [
        merged(DOC, "doc/content", mapOf({ run_2: leaf("world", "u_content_2") }), "append"),
      ]),
    );

    expect(seen).toEqual(["hello", "world"]);
  });
});

describe("forward-one accessor to a lazy target", () => {
  it("materializes the target's lazy component through replica.open", async () => {
    const { client } = harness({ cacheTtlMs: 0 });
    const hlc = makeHlc(1_711_036_800_000);
    await callApplyAction(
      client,
      seedAction(1, [
        created("page_1", "page", hlc),
        replaced("page_1", "page/title", leaf("One", "u_page_title"), "title"),
        created("blob_1", "blob", hlc),
        replaced("blob_1", "blob/content", leaf("body", "u_blob_content"), "content"),
      ]),
    );
    await callApplyAction(
      client,
      linkAction({
        id: "a_2_link",
        hlc,
        gsn: 2,
        sourceId: "page_1",
        edges: [{ as: "body", type: "page", targetId: "blob_1" }],
      }),
    );

    const pageRow = await client.page.get("page_1");
    expect(client.replica.isComponentResident("blob_1", "blob/content")).toBe(false);

    const target = await pageRow!.body;

    expect(target?.id).toBe("blob_1");
    expect(client.replica.isComponentResident("blob_1", "blob/content")).toBe(true);
    expect(target?.data.fields.content).toBeDefined();

    // Closing evicts the row; the next accessor read opens it again rather
    // than returning a stale store row.
    client.replica.close("blob_1", "blob/content");
    expect(client.replica.isComponentResident("blob_1", "blob/content")).toBe(false);

    const refreshed = await client.page.get("page_1");
    const reopened = await refreshed!.body;
    expect(reopened?.data.fields.content).toBeDefined();
    expect(client.replica.isComponentResident("blob_1", "blob/content")).toBe(true);
  });
});
