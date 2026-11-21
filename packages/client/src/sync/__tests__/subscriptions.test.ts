/**
 * Unit tests for the subscription registry (#937).
 *
 * One registry holds every live query and row subscription: its read set, its
 * own revision cursor, the leases its dependencies need, and whether it is
 * still live. Claims are refcounted by `(row, component)`, so two
 * subscriptions reading one value share it, and a claim is released — starting
 * the residency grace period — when the subscription ends.
 */

import { describe, expect, it } from "vitest";
import {
  componentName,
  makeHlc,
  type Action,
  type Entity,
  type FieldValue,
  type Update,
} from "@ebbjs/core";
import { defineComponent, defineModel, defineSchema, e } from "@ebbjs/schema";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import { createReplica, type Replica, type Revision } from "@ebbjs/storage/replica";

import { createClient } from "../client";
import { createSubscriptionRegistry } from "../subscriptions";
import { callApplyAction, flushTasks, rowComponents, waitFor } from "../test-utils";

/** The heavy component: every other component of the row stays held. */
const LAZY = "document/text";

const leaf = (value: string): FieldValue => ({
  value,
  update_id: "u_1",
  hlc: makeHlc(1),
});

const documentRow = (id: string): Entity => ({
  id,
  model: "document",
  data: { fields: { title: leaf(`${id} title`), text: leaf(`${id} text`) } },
  exists: true,
  created_hlc: makeHlc(1),
  updated_hlc: makeHlc(1),
  deleted_hlc: null,
  last_gsn: 1,
});

const harness = (options: { residencyTtlMs?: number } = {}) => {
  const rows: Record<string, Entity> = { doc_1: documentRow("doc_1") };
  const replica = createReplica({
    // `title` is held; `text` is materialized only while a claim holds it.
    materialization: { holds: (component) => component !== LAZY },
    readComponent: async (id) => rows[id] ?? null,
    residencyTtlMs: options.residencyTtlMs,
  });
  seed(replica);
  return { replica, subscriptions: createSubscriptionRegistry(replica), rows };
};

/** Create `doc_1` with both components; the lazy one is known, not retained. */
const seed = (replica: Replica): Revision => {
  const fields = documentRow("doc_1").data.fields;
  return replica.ingest(
    { id: "a_seed", actor_id: "actor_1", hlc: makeHlc(1), gsn: 1, updates: [] },
    [
      {
        id: "u_seed_create",
        subject_id: "doc_1",
        model: "document",
        method: "create",
        hlc: makeHlc(1),
        data: null,
      },
      ...Object.entries(fields).map(([field, data]) => ({
        id: `u_seed_${field}`,
        subject_id: "doc_1",
        component: componentName("document", field),
        method: "replace" as const,
        data,
      })),
    ],
    1,
  );
};

/** Rewrite the held title, journaling one content change on `document/title`. */
const writeTitle = (replica: Replica, title: string, gsn: number): Revision =>
  replica.ingest(
    { id: `a_${gsn}`, actor_id: "actor_1", hlc: makeHlc(gsn), gsn, updates: [] },
    [
      {
        id: `u_${gsn}`,
        subject_id: "doc_1",
        component: "document/title",
        method: "replace",
        data: { value: title, update_id: `u_${gsn}`, hlc: makeHlc(gsn) },
      },
    ],
    gsn,
  );

describe("subscription registry: entries", () => {
  it("holds a query subscription and a row subscription in one registry", async () => {
    const { replica, subscriptions } = harness();
    // A row read installs the body under a one-shot claim, so the row
    // subscription finds it resident.
    await replica.read("doc_1", [LAZY]);

    const query = subscriptions.open({
      kind: "query",
      key: "rows:document",
      reads: ["document/*"],
    });
    const row = subscriptions.open({ kind: "row", row: "doc_1" });
    await flushTasks();

    expect(subscriptions.entries().map((entry) => entry.kind)).toEqual(["query", "row"]);
    expect(subscriptions.entries().map((entry) => entry.key)).toEqual(["rows:document", "doc_1"]);
    // A query declares the model it scans; a row reads the components it holds.
    expect(query.reads.models.has("document")).toBe(true);
    expect(row.reads.components.has(LAZY)).toBe(true);
    expect(query.state).toBe("live");
    expect(row.state).toBe("live");
    expect(query.cursor).toBe(replica.revision);
    expect(row.cursor).toBe(replica.revision);
    expect(subscriptions.stats()).toMatchObject({ live: 2, byKind: { query: 1, row: 1 } });
  });

  it("tracks a revision cursor per entry", () => {
    const { replica, subscriptions } = harness();
    const relevant = subscriptions.open({
      kind: "query",
      key: "titles",
      reads: ["document/title"],
    });
    const other = subscriptions.open({ kind: "query", key: "notes", reads: ["note/*"] });
    // The relevant entry's run is still in flight, so it has not caught up.
    relevant.onChange(() => {});

    const before = replica.revision;
    writeTitle(replica, "Renamed", 2);

    // An untouched entry is dispatched past the batch without any work; the one
    // whose result is outstanding stays behind until its run settles.
    expect(other.cursor).toBe(replica.revision);
    expect(relevant.cursor).toBe(before);
  });

  it("releases an entry's leases on unsubscribe and starts the inactive TTL", async () => {
    const { replica, subscriptions } = harness({ residencyTtlMs: 20 });
    await replica.read("doc_1", [LAZY]);
    const row = subscriptions.open({ kind: "row", row: "doc_1" });
    await flushTasks();
    expect(replica.stats().leases).toMatchObject({
      leased: 1,
      inactive: 0,
      byComponent: { [LAZY]: { leased: 1 } },
    });

    row.release();

    expect(row.state).toBe("terminal");
    expect(subscriptions.stats().live).toBe(0);
    expect(replica.stats().leases).toMatchObject({
      leased: 0,
      inactive: 1,
      timers: 1,
      byComponent: { [LAZY]: { leased: 0, inactive: 1 } },
    });
    // The value stays warm for one grace period, then leaves.
    expect(replica.isComponentResident("doc_1", LAZY)).toBe(true);
    await waitFor(() => !replica.isComponentResident("doc_1", LAZY));
    expect(replica.stats().leases.resident).toBe(0);
  });

  it("shares one value and one lease between two subscriptions on one component", async () => {
    const { replica, subscriptions } = harness();
    await replica.read("doc_1", [LAZY]);
    const query = subscriptions.open({
      kind: "query",
      key: "rows:document",
      reads: ["document/*"],
    });
    const row = subscriptions.open({ kind: "row", row: "doc_1" });
    await flushTasks();

    // Two subscriptions, one residency entry for the shared value.
    expect(replica.stats().leases.leased).toBe(1);
    expect(replica.stats().leases.byComponent[LAZY]).toMatchObject({ leased: 1, inactive: 0 });

    query.release();
    expect(replica.stats().leases.byComponent[LAZY]).toMatchObject({ leased: 1, inactive: 0 });

    row.release();
    expect(replica.stats().leases.byComponent[LAZY]).toMatchObject({ leased: 0, inactive: 1 });
  });

  it("releases a claim that resolves after the entry has ended", async () => {
    const { replica, subscriptions } = harness({ residencyTtlMs: 10 });
    const query = subscriptions.open({
      kind: "query",
      key: "rows:document",
      reads: ["document/*"],
    });
    query.depend([{ id: "doc_1", components: [LAZY] }]);
    query.release();
    await flushTasks();

    expect(query.state).toBe("terminal");
    expect(subscriptions.stats().live).toBe(0);
    expect(replica.stats().leases.leased).toBe(0);
    await waitFor(() => replica.stats().leases.resident === 0);
  });
});

describe("subscription registry at the client seam", () => {
  const note = defineModel("note", {
    title: e.string(),
    body: defineComponent("note/body", e.string(), { loading: "lazy" }),
  });
  const todo = defineModel("todo", { title: e.string() });
  const schema = defineSchema({ models: { note, todo }, version: 1 });

  const mkClient = (options = {}) =>
    createClient({
      serverUrl: "http://x",
      actorId: "actor_1",
      storage: createMemoryAdapter(),
      schema,
      ...options,
    });

  const put = (
    gsn: number,
    id: string,
    model: string,
    fields: Record<string, unknown>,
  ): Action => ({
    id: `a_${gsn}`,
    actor_id: "actor_1",
    hlc: makeHlc(gsn),
    gsn,
    updates: rowComponents(model, fields).map(
      ([component, value]): Update => ({
        id: `u_${gsn}_${component}`,
        subject_id: id,
        component,
        method: "replace",
        data: { value, update_id: `u_${gsn}`, hlc: makeHlc(gsn) },
      }),
    ),
  });

  it("holds a query subscription and a row subscription in one registry", async () => {
    const client = mkClient();
    await callApplyAction(client, put(1, "todo_1", "todo", { title: "Ship" }), "grp_1");
    await callApplyAction(
      client,
      put(2, "note_1", "note", { title: "Doc", body: "300 KB" }),
      "grp_1",
    );

    const offQuery = client.todo.query().subscribe(() => {});
    const row = await client.note.get("note_1");
    const offRow = row!.subscribe(() => {});
    await flushTasks();

    expect(
      client.subscriptions
        .entries()
        .map((entry) => entry.kind)
        .sort(),
    ).toEqual(["query", "row"]);
    expect(client.subscriptions.entries().every((entry) => entry.state === "live")).toBe(true);

    offQuery();
    offRow();
    expect(client.subscriptions.stats().live).toBe(0);
  });

  it("leases a row subscription's lazy component until it unsubscribes", async () => {
    const client = mkClient({ residencyTtlMs: 0 });
    await callApplyAction(
      client,
      put(1, "note_1", "note", { title: "Doc", body: "300 KB" }),
      "grp_1",
    );

    const row = await client.note.get("note_1");
    expect(row?.body).toBe("300 KB");
    // The read claimed the body for its own duration and released it.
    expect(client.replicaStats.leases).toMatchObject({ leased: 0, inactive: 1 });

    const off = row!.subscribe(() => {});
    await flushTasks();

    // The live row subscription owns the body, so nothing can take it away.
    expect(client.replicaStats.leases).toMatchObject({
      leased: 1,
      inactive: 0,
      byComponent: { "note/body": { leased: 1, inactive: 0 } },
    });

    off();
    expect(client.replicaStats.leases).toMatchObject({ leased: 0, inactive: 1 });
  });
});
