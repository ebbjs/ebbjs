/**
 * Unit tests for the subscription registry (#937).
 *
 * One registry holds every live query and row subscription: its read set, its
 * own subscription revision, the leases its dependencies need, and whether it is
 * still live. Claims are refcounted by `(row, component)`, so two
 * subscriptions reading one value share it, and a claim is released — starting
 * the residency grace period — when the subscription ends.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import {
  createReplica,
  DEFAULT_RESIDENCY_TTL_MS,
  REPLICA_RECORD_FORMAT,
  type Replica,
  type Revision,
} from "@ebbjs/storage/replica";

import { createClient } from "../client";
import { UnknownIndexError } from "../dependency-index";
import { createSubscriptionRegistry, type SubscriptionRegistryOptions } from "../subscriptions";
import { callApplyAction, flushTasks, platformUpdate, rowComponents, waitFor } from "../test-utils";

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

const harness = (
  options: {
    residencyTtlMs?: number;
    watchdog?: SubscriptionRegistryOptions["watchdog"];
  } = {},
) => {
  const rows: Record<string, Entity> = { doc_1: documentRow("doc_1") };
  const replica = createReplica({
    readComponent: async (id) => rows[id] ?? null,
    residencyTtlMs: options.residencyTtlMs,
  });
  seed(replica);
  const subscriptions = createSubscriptionRegistry(replica, {
    residencyTtlMs: options.residencyTtlMs,
    watchdog: options.watchdog,
  });
  return { replica, subscriptions, rows };
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

/** Write one component of one row, journaling exactly that component. */
const write = (
  replica: Replica,
  id: string,
  model: string,
  field: string,
  value: string,
  gsn: number,
): Revision =>
  replica.ingest(
    { id: `a_${gsn}`, actor_id: "actor_1", hlc: makeHlc(gsn), gsn, updates: [] },
    [
      {
        id: `u_${gsn}`,
        subject_id: id,
        component: componentName(model, field),
        method: "replace",
        data: { value, update_id: `u_${gsn}`, hlc: makeHlc(gsn) },
      },
    ],
    gsn,
  );

/** Rewrite the held title, journaling one content change on `document/title`. */
const writeTitle = (replica: Replica, title: string, gsn: number): Revision =>
  write(replica, "doc_1", "document", "title", title, gsn);

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
    expect(query.revision).toBe(replica.revision);
    expect(row.revision).toBe(replica.revision);
    expect(subscriptions.stats()).toMatchObject({ live: 2, byKind: { query: 1, row: 1 } });
  });

  it("tracks a subscription revision per entry", () => {
    const { replica, subscriptions } = harness();
    const lagging = subscriptions.open({
      kind: "query",
      key: "titles",
      reads: ["document/title"],
    });
    const other = subscriptions.open({ kind: "query", key: "notes", reads: ["note/*"] });
    const before = replica.revision;
    // A run in flight: the consumer declares that its result still reflects
    // the revision it started from.
    lagging.onChange((_changes, _revision) => lagging.seek(before));

    writeTitle(replica, "Renamed", 2);

    // The batch never visits `other` — nothing it reads changed — so it reports
    // the dispatcher's revision, which is already past the batch; the one whose
    // result has not settled stays behind.
    expect(other.revision).toBe(replica.revision);
    expect(lagging.revision).toBe(before);
  });

  it("advances only the entries that were caught up", () => {
    const { replica, subscriptions } = harness();
    const lagging = subscriptions.open({
      kind: "query",
      key: "titles",
      reads: ["document/title"],
    });
    const caughtUp = subscriptions.open({ kind: "query", key: "notes", reads: ["note/*"] });
    const start = replica.revision;
    // The entry starts a run on the relevant batch and declares that its result
    // still reflects `start` until that run settles.
    lagging.onChange((_changes, _revision) => lagging.seek(start));
    write(replica, "doc_1", "document", "title", "Renamed", 2);
    expect(lagging.revision).toBe(start);

    // A peer write touches the other entry only. The pending entry must not be
    // advanced past the change its run has not picked up yet.
    write(replica, "note_1", "note", "title", "Unrelated", 3);

    expect(caughtUp.revision).toBe(replica.revision);
    expect(lagging.revision).toBe(start);
  });

  it("keeps a declared lag through a batch that touches the entry again", () => {
    const { replica, subscriptions } = harness();
    const lagging = subscriptions.open({
      kind: "query",
      key: "titles",
      reads: ["document/title"],
    });
    const start = replica.revision;
    lagging.onChange(() => lagging.seek(start));
    writeTitle(replica, "Renamed", 2);

    // A second relevant batch arrives while the run is still in flight: the
    // entry is handed it, but a batch cannot claim the run has caught up.
    writeTitle(replica, "Renamed again", 3);
    expect(lagging.revision).toBe(start);

    lagging.seek(replica.revision);
    expect(lagging.revision).toBe(replica.revision);
  });

  it("recovers a revision stranded by dispatch bookkeeping that throws", () => {
    const { replica, subscriptions } = harness();
    const entry = subscriptions.open({ kind: "row", row: "doc_1" });
    const seen: Revision[] = [];
    entry.onChange((_changes, revision) => seen.push(revision));
    const before = replica.revision;
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    const refresh = vi.spyOn(replica, "residentComponents").mockImplementation(() => {
      throw new Error("resident boom");
    });

    writeTitle(replica, "Renamed", 2);

    // The entry could not be evaluated: it is not handed the batch, and neither
    // its subscription revision nor the revision it was dispatched through moves.
    expect(seen).toEqual([]);
    expect(entry.revision).toBe(before);
    expect(replica.revision).toBeGreaterThan(before);
    expect(reported).toHaveBeenCalled();

    // A load replaces the journal, so every entry is dispatched again. Because
    // the failed batch never counted as dispatched, the entry still counts as
    // caught up with what it was handed and its revision moves with the gap.
    refresh.mockRestore();
    const gap = before + 4;
    replica.load({
      format: REPLICA_RECORD_FORMAT,
      position: 0,
      revision: gap,
      entities: [],
      componentVersions: {},
    });
    expect(seen).toEqual([gap]);
    expect(entry.revision).toBe(gap);

    // And it stays current through a later batch that touches it instead of
    // reporting `stale` from behind for the rest of its life.
    writeTitle(replica, "Renamed again", 6);
    expect(seen).toEqual([gap, replica.revision]);
    expect(entry.revision).toBe(replica.revision);
    reported.mockRestore();
  });

  it("hands out introspection entries that own no share", () => {
    const { subscriptions } = harness();
    const first = subscriptions.open({ kind: "query", key: "q", reads: ["document/*"] });
    const second = subscriptions.open({ kind: "query", key: "q", reads: ["document/*"] });
    expect(subscriptions.entries()[0].refs).toBe(2);

    const snapshot = subscriptions.entries()[0];
    // An introspection entry is a snapshot of the entry, not a handle: it
    // exposes no mutators, and the runtime object carries none either.
    expect("release" in snapshot).toBe(false);
    // @ts-expect-error — a snapshot does not own a share to release.
    void snapshot.release;

    expect(subscriptions.entries()[0].refs).toBe(2);
    expect(subscriptions.entries()[0].state).toBe("live");
    first.release();
    second.release();
    expect(subscriptions.stats().live).toBe(0);
  });

  it("isolates a throwing listener so its peers still see the batch", () => {
    const { replica, subscriptions } = harness();
    const throwing = subscriptions.open({
      kind: "query",
      key: "throwing",
      reads: ["document/title"],
    });
    const peer = subscriptions.open({ kind: "row", row: "doc_1" });
    const seen: Revision[] = [];
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    throwing.onChange(() => {
      throw new Error("listener boom");
    });
    // A second listener on the same entry throws before the recorder, so one
    // consumer cannot skip its neighbour either.
    peer.onChange(() => {
      throw new Error("listener boom");
    });
    peer.onChange((_changes, revision) => seen.push(revision));
    const before = replica.revision;

    writeTitle(replica, "Renamed", 2);

    expect(seen).toEqual([replica.revision]);
    // A throw cannot leave an entry behind for a later batch to jump past:
    // the batch is dispatched through every live entry first.
    expect(throwing.revision).toBe(replica.revision);
    expect(peer.revision).toBe(replica.revision);
    expect(before).toBeLessThan(replica.revision);
    expect(reported).toHaveBeenCalled();
    reported.mockRestore();
  });

  it("keeps a shared entry alive when one handle is released twice", async () => {
    const { replica, subscriptions } = harness();
    await replica.read("doc_1", [LAZY]);
    const first = subscriptions.open({ kind: "row", row: "doc_1" });
    const second = subscriptions.open({ kind: "row", row: "doc_1" });
    const seen: Revision[] = [];
    second.onChange((_changes, revision) => seen.push(revision));
    await flushTasks();
    expect(subscriptions.entries()[0].refs).toBe(2);

    first.release();
    first.release();

    const entry = subscriptions.entries()[0];
    expect(entry.state).toBe("live");
    expect(entry.refs).toBe(1);
    // The peer's claims survive: releasing one handle twice is not a release
    // of the other's.
    expect(replica.stats().leases.leased).toBe(2);
    writeTitle(replica, "Renamed", 2);
    expect(seen).toEqual([replica.revision]);

    second.release();
    expect(subscriptions.stats().live).toBe(0);
    expect(replica.stats().leases.leased).toBe(0);
  });

  it("releases an entry's leases on unsubscribe and starts the inactive TTL", async () => {
    const { replica, subscriptions } = harness({ residencyTtlMs: 20 });
    await replica.read("doc_1", [LAZY]);
    const row = subscriptions.open({ kind: "row", row: "doc_1" });
    await flushTasks();
    expect(replica.stats().leases).toMatchObject({
      leased: 2,
      inactive: 0,
      byComponent: { [LAZY]: { leased: 1 } },
    });

    row.release();

    expect(row.state).toBe("terminal");
    expect(subscriptions.stats().live).toBe(0);
    expect(replica.stats().leases).toMatchObject({
      leased: 0,
      inactive: 2,
      timers: 2,
      byComponent: { [LAZY]: { leased: 0, inactive: 1 } },
    });
    // The row is the log's own, so the released claim expires into nothing:
    // the value was never the claim's to release.
    await waitFor(() => replica.stats().leases.resident === 0);
    expect(replica.isComponentResident("doc_1", LAZY)).toBe(true);
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
    expect(replica.stats().leases.leased).toBe(2);
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
    // The inactive result's lifetime ends before its claim has to be kept.
    await waitFor(() => subscriptions.peek("query", "rows:document") === undefined);
    await flushTasks();

    expect(query.state).toBe("terminal");
    expect(subscriptions.stats().live).toBe(0);
    expect(replica.stats().leases.leased).toBe(0);
    await waitFor(() => replica.stats().leases.resident === 0);
  });
});

describe("subscription registry: inactive query results (#941)", () => {
  /**
   * A query result owns the claims it read: releasing its last subscriber makes
   * the result inactive, not gone. The result and its claims live one
   * residency TTL, then both end together, so the result is the only owner
   * answering "how long does an unwatched read stay warm".
   */
  it("keeps a released result and its claims for one residency TTL, then ends both", async () => {
    const { replica, subscriptions } = harness({ residencyTtlMs: 20 });
    await replica.read("doc_1", [LAZY]);
    const query = subscriptions.open({
      kind: "query",
      key: "rows:document",
      reads: ["document/*"],
    });
    query.depend([{ id: "doc_1", components: [LAZY] }]);
    await flushTasks();
    expect(replica.stats().leases).toMatchObject({ leased: 1, inactive: 0 });

    query.release();

    // The result still owns the claim, so a remount cannot lose the value.
    expect(subscriptions.stats()).toMatchObject({ live: 0, inactive: 1 });
    expect(replica.stats().leases).toMatchObject({ leased: 1, inactive: 0 });

    // A remount inside the TTL takes the entry back, with its claims intact.
    const remount = subscriptions.open({
      kind: "query",
      key: "rows:document",
      reads: ["document/*"],
    });
    expect(remount.state).toBe("live");
    expect(remount.refs).toBe(1);
    expect(subscriptions.entries()).toHaveLength(1);
    expect(replica.stats().leases).toMatchObject({ leased: 1, inactive: 0 });

    // The TTL ends the result; only then do its claims go inactive.
    remount.release();
    await waitFor(() => subscriptions.peek("query", "rows:document") === undefined);
    expect(subscriptions.stats()).toMatchObject({ live: 0, inactive: 0 });
    expect(replica.stats().leases).toMatchObject({ leased: 0, inactive: 1 });
  });

  it("defaults the inactive lifetime to the one residency TTL", () => {
    vi.useFakeTimers();
    try {
      const { subscriptions } = harness();
      subscriptions.open({ kind: "query", key: "titles", reads: ["document/title"] }).release();
      expect(subscriptions.stats().inactive).toBe(1);

      vi.advanceTimersByTime(DEFAULT_RESIDENCY_TTL_MS - 1);
      expect(subscriptions.peek("query", "titles")).toBeDefined();

      vi.advanceTimersByTime(1);
      expect(subscriptions.peek("query", "titles")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses the consumer state an entry already carries", () => {
    const { subscriptions } = harness();
    const consumer = { runs: 0 };
    const first = subscriptions.open({ kind: "query", key: "titles", reads: [] }, consumer);
    const second = subscriptions.open({ kind: "query", key: "titles", reads: [] }, { runs: 99 });

    expect(first.consumer).toBe(consumer);
    expect(second.consumer).toBe(consumer);
    expect(subscriptions.peek("query", "titles")?.consumer).toBe(consumer);
  });

  it("cancels the inactive lifetime when a result is remounted", async () => {
    vi.useFakeTimers();
    try {
      const { subscriptions } = harness();
      const first = subscriptions.open({ kind: "query", key: "titles", reads: [] });
      first.release();

      vi.advanceTimersByTime(DEFAULT_RESIDENCY_TTL_MS - 1);
      const remount = subscriptions.open({ kind: "query", key: "titles", reads: [] });
      vi.advanceTimersByTime(DEFAULT_RESIDENCY_TTL_MS * 10);

      // The timer armed for the inactive period cannot end a live result.
      expect(remount.state).toBe("live");
      expect(subscriptions.peek("query", "titles")).toBeDefined();
      remount.release();
      vi.advanceTimersByTime(DEFAULT_RESIDENCY_TTL_MS);
      expect(subscriptions.peek("query", "titles")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * `residencyTtlMs: 0` is the one disable switch, and it covers the query
   * result exactly as it covers the values the result claims: no expiry, no
   * timer. The session ends it, not the clock, which is why a result disabled
   * this way keeps its claims until `close()`.
   */
  it("disables the inactive lifetime when residencyTtlMs is 0", async () => {
    vi.useFakeTimers();
    try {
      // Closing with a live entry is a legal teardown order — a client outliving
      // its mounted components — and this test is about the TTL, not about what
      // the watchdog reports for that order. That has its own test below.
      const { replica, subscriptions } = harness({ residencyTtlMs: 0, watchdog: false });
      await replica.read("doc_1", [LAZY]);
      const query = subscriptions.open({
        kind: "query",
        key: "rows:document",
        reads: ["document/*"],
      });
      query.depend([{ id: "doc_1", components: [LAZY] }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(replica.stats().leases).toMatchObject({ leased: 1, inactive: 0 });

      query.release();
      expect(subscriptions.stats()).toMatchObject({ live: 0, inactive: 1 });
      // The result still owns the claim while inactive, so the value cannot
      // leave the replica behind it.
      expect(replica.stats().leases).toMatchObject({ leased: 1, inactive: 0 });

      // No timer was armed, so no amount of time ends it.
      await vi.advanceTimersByTimeAsync(DEFAULT_RESIDENCY_TTL_MS * 10);
      expect(subscriptions.peek("query", "rows:document")).toBeDefined();
      expect(replica.stats().leases.leased).toBe(1);

      // Still claimable: a remount takes the same entry, and its claims, back.
      const remount = subscriptions.open({
        kind: "query",
        key: "rows:document",
        reads: ["document/*"],
      });
      expect(remount.state).toBe("live");
      expect(subscriptions.entries()).toHaveLength(1);

      // `close()` is what ends it, releasing the claims it owned.
      subscriptions.close();
      expect(remount.state).toBe("terminal");
      expect(subscriptions.peek("query", "rows:document")).toBeUndefined();
      expect(replica.stats().leases.leased).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("subscription registry: indexed dispatch (#938)", () => {
  /** An empty record, so `load` replaces the journal with a gap. */
  const emptyRecord = (revision: number) => ({
    format: REPLICA_RECORD_FORMAT,
    position: 0,
    revision,
    entities: [],
    componentVersions: {},
  });

  it("notifies exactly the entries the batch touches", () => {
    const { replica, subscriptions } = harness();
    const title = subscriptions.open({ kind: "query", key: "titles", reads: ["document/title"] });
    const model = subscriptions.open({ kind: "query", key: "documents", reads: ["document/*"] });
    const row = subscriptions.open({ kind: "row", row: "doc_1" });
    const otherRow = subscriptions.open({ kind: "row", row: "doc_9" });
    const seen: string[] = [];
    title.onChange(() => seen.push("title"));
    model.onChange(() => seen.push("model"));
    row.onChange(() => seen.push("row"));
    otherRow.onChange(() => seen.push("otherRow"));
    void flushTasks();

    writeTitle(replica, "Renamed", 2);

    // The title read, the whole-model read, and the row watch; not the row
    // subscription on an id the batch never names.
    expect(seen.sort()).toEqual(["model", "row", "title"]);
    expect(otherRow.revision).toBe(replica.revision);
  });

  it("reads the journal once for a batch, not once per entry", () => {
    const { replica, subscriptions } = harness();
    for (const key of ["a", "b", "c"]) {
      subscriptions.open({ kind: "query", key, reads: ["document/*"] }).onChange(() => {});
    }
    const changesSince = vi.spyOn(replica, "changesSince");
    changesSince.mockClear();

    writeTitle(replica, "Renamed", 2);

    expect(changesSince).toHaveBeenCalledTimes(1);
    changesSince.mockRestore();
  });

  /** File `entityId` under one group, the write a membership row stands for. */
  const writeMembership = (
    replica: Replica,
    id: string,
    entityId: string,
    groupId: string,
    gsn: number,
  ): Revision =>
    replica.ingest(
      { id: `a_${gsn}`, actor_id: "actor_1", hlc: makeHlc(gsn), gsn, updates: [] },
      platformUpdate(id, "membership", "put", { entity_id: entityId, group_id: groupId }),
      gsn,
    );

  it("touches a row subscription when its membership row changes", () => {
    const { replica, subscriptions } = harness();
    writeMembership(replica, "eg_1", "doc_1", "grp_1", 2);
    const row = subscriptions.open({ kind: "row", row: "doc_1" });
    const otherRow = subscriptions.open({ kind: "row", row: "doc_2" });
    const seen: string[] = [];
    row.onChange(() => seen.push("doc_1"));
    otherRow.onChange(() => seen.push("doc_2"));

    writeMembership(replica, "eg_2", "doc_2", "grp_1", 3);
    expect(seen).toEqual(["doc_2"]);

    // A member row is not the member's own row: the membership index is what
    // keeps the member's subscription awake when its group set moves.
    writeMembership(replica, "eg_1", "doc_1", "grp_2", 4);
    expect(seen).toEqual(["doc_2", "doc_1"]);
  });

  /** Write one row's create and no component: a membership change. */
  const createRow = (replica: Replica, id: string, model: string, gsn: number): Revision =>
    replica.ingest(
      { id: `a_${gsn}`, actor_id: "actor_1", hlc: makeHlc(gsn), gsn, updates: [] },
      [
        {
          id: `u_${gsn}`,
          subject_id: id,
          model,
          method: "create",
          hlc: makeHlc(gsn),
          data: null,
        },
      ],
      gsn,
    );

  it("matches a content change by component and a membership change by model", () => {
    const { replica, subscriptions } = harness();
    const title = subscriptions.open({ kind: "query", key: "titles", reads: ["document/title"] });
    const model = subscriptions.open({ kind: "query", key: "documents", reads: ["document/*"] });
    const other = subscriptions.open({ kind: "query", key: "pages", reads: ["page/title"] });
    const seen: string[] = [];
    title.onChange(() => seen.push("title"));
    model.onChange(() => seen.push("model"));
    other.onChange(() => seen.push("other"));
    void flushTasks();

    // A component write is a content change: only the exact read and the
    // whole-model read of that model are touched.
    writeTitle(replica, "Renamed", 2);
    expect(seen.sort()).toEqual(["model", "title"]);

    // A row entering the model's set names no component, so the model is what
    // matches it: the exact read of another model stays untouched.
    seen.length = 0;
    createRow(replica, "doc_2", "document", 3);
    expect(seen.sort()).toEqual(["model", "title"]);

    seen.length = 0;
    createRow(replica, "page_1", "page", 4);
    expect(seen).toEqual(["other"]);
  });

  it("hands a row subscription both kinds of change", async () => {
    const { replica, subscriptions } = harness();
    await replica.read("doc_1", [LAZY]);
    const row = subscriptions.open({ kind: "row", row: "doc_1" });
    await flushTasks();
    const kinds: string[] = [];
    row.onChange((changes) => {
      for (const change of changes) kinds.push(change.kind);
    });

    writeTitle(replica, "Renamed", 2);
    expect(kinds).toEqual(["content"]);

    replica.evict(["doc_1"]);
    expect(kinds).toEqual(["content", "membership"]);
  });

  it("reports a value a subscription held leaving the replica, not the journal entry", async () => {
    const { replica, subscriptions } = harness();
    await replica.read("doc_1", [LAZY]);
    const row = subscriptions.open({ kind: "row", row: "doc_1" });
    await flushTasks();
    const seen: { changes: number; unloaded: readonly string[] }[] = [];
    row.onChange((changes, _revision, unloaded) =>
      seen.push({ changes: changes.length, unloaded }),
    );

    // The eviction is a membership change; what the subscription lost is its
    // claims, which is what `unloaded` has to be driven by (#940).
    replica.evict(["doc_1"]);

    expect(seen).toEqual([{ changes: 1, unloaded: ["document/title", LAZY] }]);
  });

  it("re-runs every subscription after a journal gap", () => {
    const { replica, subscriptions } = harness();
    const title = subscriptions.open({ kind: "query", key: "titles", reads: ["document/title"] });
    const row = subscriptions.open({ kind: "row", row: "doc_1" });
    const seen: string[] = [];
    title.onChange(() => seen.push("title"));
    row.onChange(() => seen.push("row"));

    // A load replaces the journal wholesale: the batch is empty and the
    // revision advanced, so nothing can be narrowed.
    replica.load(emptyRecord(replica.revision + 3));

    expect(seen.sort()).toEqual(["row", "title"]);
  });
});

/**
 * Derived-index keys a consumer supplies through `depend` (#1007).
 *
 * A result learns some of its keys from the rows it holds rather than from its
 * query — the membership row each projected row is filed by — so the consumer
 * hands them over with its claims. The registry merges them with the entry's
 * declared keys, dedupes by `(index, key)`, and re-indexes that one entry, so
 * dispatch follows a key set that moved without a rebuild or a re-run.
 */
describe("subscription registry: consumer-supplied index keys (#1007)", () => {
  type Registry = ReturnType<typeof createSubscriptionRegistry>;

  /** File `entityId` under one group: the membership row a projected row carries. */
  const file = (
    replica: Replica,
    membershipId: string,
    entityId: string,
    groupId: string,
    gsn: number,
  ): Revision =>
    replica.ingest(
      { id: `a_${gsn}`, actor_id: "actor_1", hlc: makeHlc(gsn), gsn, updates: [] },
      platformUpdate(membershipId, "membership", "put", {
        entity_id: entityId,
        group_id: groupId,
      }),
      gsn,
    );

  /** A query entry that declares no read of its own, only the keys it is handed. */
  const indexed = (registry: Registry, key: string, members: readonly string[]) => {
    const entry = registry.open({ kind: "query", key, reads: [] });
    entry.depend(
      [],
      members.map((member) => ({ index: "membership", key: member })),
    );
    return entry;
  };

  it("touches the entry whose membership key a change names, not a peer", () => {
    const { replica, subscriptions } = harness();
    const held = indexed(subscriptions, "held", ["doc_1"]);
    const peer = indexed(subscriptions, "peer", ["doc_2"]);
    const seen: string[] = [];
    held.onChange(() => seen.push("held"));
    peer.onChange(() => seen.push("peer"));

    // The membership row files doc_1, which exactly one of the two entries
    // holds. The counters say it was found by lookup: a scan of every entry —
    // what the batch would otherwise cost — is the `scanWork` number, and one
    // of the two entries is touched.
    file(replica, "eg_1", "doc_1", "grp_1", 2);
    expect(seen).toEqual(["held"]);
    expect(subscriptions.stats().dispatch).toEqual({ touched: 1, lookups: 3, scanWork: 2 });

    // A membership row filing another entity names no key either entry holds,
    // so the batch costs its lookups and touches nothing.
    seen.length = 0;
    file(replica, "eg_9", "doc_9", "grp_1", 3);
    expect(seen).toEqual([]);
    expect(subscriptions.stats().dispatch).toEqual({ touched: 0, lookups: 3, scanWork: 2 });
  });

  it("adds a key, keeps it through a claims-only call, and drops it", () => {
    const { replica, subscriptions } = harness();
    const held = subscriptions.open({ kind: "query", key: "held", reads: [] });
    const peer = subscriptions.open({ kind: "query", key: "peer", reads: [] });
    const seen: string[] = [];
    held.onChange(() => seen.push("held"));
    peer.onChange(() => seen.push("peer"));
    const claims = [{ id: "doc_1", components: ["document/title"] }];

    // Nothing names doc_1 yet, so the change is nobody's concern: no lookup
    // finds a holder, and the set of entries the batch would have scanned is
    // the one dispatch avoided. Nothing declared the index yet, so its lookup
    // is not even paid.
    file(replica, "eg_1", "doc_1", "grp_1", 2);
    expect(seen).toEqual([]);
    expect(subscriptions.stats().dispatch).toEqual({ touched: 0, lookups: 2, scanWork: 2 });

    // Adding the key re-indexes this one entry, and the next batch finds it.
    held.depend(claims, [{ index: "membership", key: "doc_1" }]);
    file(replica, "eg_2", "doc_1", "grp_2", 3);
    expect(seen).toEqual(["held"]);
    expect(subscriptions.stats().dispatch).toEqual({ touched: 1, lookups: 3, scanWork: 2 });

    // A call that hands only claims states no opinion about keys, so the key
    // stays in force — the patch path calls `depend(dependencies)`.
    held.depend(claims);
    file(replica, "eg_3", "doc_1", "grp_3", 4);
    expect(seen).toEqual(["held", "held"]);

    // `[]` is how a consumer withdraws them, and the next batch is nobody's.
    held.depend(claims, []);
    file(replica, "eg_4", "doc_1", "grp_4", 5);
    expect(seen).toEqual(["held", "held"]);
    expect(subscriptions.stats().dispatch).toEqual({ touched: 0, lookups: 2, scanWork: 2 });
  });

  it("re-indexes a key-only change without re-leasing", async () => {
    const { replica, subscriptions } = harness({ residencyTtlMs: 0 });
    await replica.read("doc_1", [LAZY]);
    const held = subscriptions.open({ kind: "query", key: "held", reads: ["document/title"] });
    held.depend([{ id: "doc_1", components: [LAZY] }]);
    await flushTasks();
    const leases = replica.stats().leases;
    const result = { rows: ["doc_1"] };
    held.publish(result);
    const reflected = held.reflected;
    const seen: string[] = [];
    held.onChange(() => seen.push("held"));
    const acquire = vi.spyOn(replica, "acquire");

    held.depend(held.dependencies, [{ index: "membership", key: "doc_1" }]);
    await flushTasks();

    // Claims did not move, so nothing was acquired, no claim was released, and
    // the entry's lease bookkeeping is what it was: a key-only call is a
    // re-index, never a re-lease.
    expect(acquire).not.toHaveBeenCalled();
    expect(replica.stats().leases).toEqual(leases);
    expect(held.dependencies).toEqual([{ id: "doc_1", components: [LAZY] }]);
    acquire.mockRestore();

    // A change that names no key the entry holds stays out of it entirely: the
    // result and the revision it reflects are untouched.
    file(replica, "eg_9", "doc_9", "grp_1", 2);
    expect(seen).toEqual([]);
    expect(held.result).toBe(result);
    expect(held.reflected).toBe(reflected);

    // The key the entry added does reach it, and reaches only its dispatch: the
    // listener runs, while the result and the claims it was published with stay
    // exactly as they were.
    file(replica, "eg_1", "doc_1", "grp_1", 3);
    expect(seen).toEqual(["held"]);
    expect(held.result).toBe(result);
    expect(held.dependencies).toEqual([{ id: "doc_1", components: [LAZY] }]);
    expect(replica.stats().leases).toEqual(leases);
  });

  it("keeps an in-flight acquire when only the key set moves", async () => {
    let unblock: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const rows: Record<string, Entity> = { doc_1: documentRow("doc_1") };
    const replica = createReplica({
      readComponent: async (id) => {
        await blocked;
        return rows[id] ?? null;
      },
    });
    seed(replica);
    const subscriptions = createSubscriptionRegistry(replica);
    const held = subscriptions.open({ kind: "query", key: "held", reads: [] });
    const seen: string[] = [];
    held.onChange(() => seen.push("held"));
    held.depend([{ id: "doc_1", components: [LAZY] }]);

    // The claim is still resolving when the key set moves. A key-only call must
    // not move the generation the acquire started with, or the claim it is
    // about to take would be dropped on arrival.
    held.depend(held.dependencies, [{ index: "membership", key: "doc_1" }]);
    unblock();
    await flushTasks();

    expect(replica.stats().leases).toMatchObject({ leased: 1 });
    expect(held.dependencies).toEqual([{ id: "doc_1", components: [LAZY] }]);

    // The key did move: the membership row filing doc_1 reaches the entry
    // through the index while it keeps the claim the acquire took.
    file(replica, "eg_1", "doc_1", "grp_1", 2);
    expect(seen).toEqual(["held"]);
    expect(replica.stats().leases).toMatchObject({ leased: 1 });
    held.release();
  });

  it("re-indexes an inactive result whose run supplies keys after its last release", async () => {
    const { replica, subscriptions } = harness({ residencyTtlMs: 0 });
    const held = subscriptions.open({ kind: "query", key: "held", reads: [] });
    const seen: string[] = [];
    held.onChange(() => seen.push("held"));
    held.publish({ data: [] });
    held.release();
    expect(held.state).toBe("inactive");

    // The run still in flight when the last subscriber left settles and
    // declares the keys it derived from its result. An inactive result keeps
    // its claims and is still dispatched, so its keys have to reach the index
    // too, or a remount inside the TTL would serve a result it believes current.
    held.depend([], [{ index: "membership", key: "doc_1" }]);
    file(replica, "eg_1", "doc_1", "grp_1", 2);

    expect(seen).toEqual(["held"]);
    expect(subscriptions.peek("query", "held")?.state).toBe("inactive");
  });

  it("touches an entry once for a key it supplied twice or also declared", () => {
    const { replica, subscriptions } = harness();
    // One key supplied by the consumer and declared by the spec, one key
    // supplied twice: `(index, key)` is the identity, so each entry holds the
    // key once whatever shape it arrived in.
    const declared = subscriptions.open({
      kind: "query",
      key: "declared",
      reads: [],
      indices: [{ index: "membership", key: "doc_1" }],
    });
    declared.depend([], [{ index: "membership", key: "doc_1" }]);
    const twice = indexed(subscriptions, "twice", ["doc_1", "doc_1"]);
    const seen: string[] = [];
    declared.onChange(() => seen.push("declared"));
    twice.onChange(() => seen.push("twice"));

    file(replica, "eg_1", "doc_1", "grp_1", 2);

    // One change, one touch per entry: the duplicate is merged away, so the
    // batch finds two entries rather than four lookups' worth of them.
    expect(seen.sort()).toEqual(["declared", "twice"]);
    expect(subscriptions.stats().dispatch.touched).toBe(2);
  });

  it("leaves a row subscription on its own row and its membership row", async () => {
    const { replica, subscriptions } = harness({ residencyTtlMs: 0 });
    await replica.read("doc_1", [LAZY]);
    const row = subscriptions.open({ kind: "row", row: "doc_1" });
    await flushTasks();
    const seen: string[] = [];
    row.onChange(() => seen.push("row"));

    // The row's own content, then the membership row that files it.
    writeTitle(replica, "Renamed", 2);
    expect(seen).toEqual(["row"]);
    file(replica, "eg_1", "doc_1", "grp_1", 3);
    expect(seen).toEqual(["row", "row"]);

    // A claims-only `depend` still re-leases the row's components.
    const acquire = vi.spyOn(replica, "acquire");
    row.depend([{ id: "doc_1", components: ["document/title"] }]);
    await flushTasks();
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(replica.stats().leases).toMatchObject({ leased: 1, inactive: 1 });
    acquire.mockRestore();

    // And the row's own membership key is still what dispatch matches on.
    file(replica, "eg_2", "doc_1", "grp_2", 4);
    expect(seen).toEqual(["row", "row", "row"]);
  });
});

describe("subscription registry: an index no resolver serves (#1006)", () => {
  /**
   * The typo an author makes: `existence` is the name the human remembers, and
   * no registered namespace prefixes it. (`relation:typo/typo` would be a typo
   * too, but the `relation:*` namespace serves every name under it, so it is
   * not one the registry can refuse.)
   */
  const TYPO = [{ index: "existence:todo/due", key: "todo/due" }];

  it("refuses the declaration in development", () => {
    const { subscriptions } = harness();
    const entry = subscriptions.open({ kind: "query", key: "typo", reads: [] });

    // The registry builds its resolvers from a fixed set, so it can tell a
    // typo'd index from one it merely cannot narrow. The author hears about it
    // where they wrote it — naming the subscription and the index — not as a
    // batch that always touches them.
    let refusal: unknown;
    try {
      entry.depend([], TYPO);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(UnknownIndexError);
    // SAFETY: asserted to be one on the line above.
    const error = refusal as UnknownIndexError;
    expect(error.index).toBe("existence:todo/due");
    expect(error.subject).toBe("typo");
    // The names it does serve, so the author sees the intended one beside the
    // typo rather than having to go read the registry.
    expect(error.known).toContain("membership");
    expect(error.known).toContain("exists:*");
    entry.release();
    subscriptions.close();
  });

  it("keeps what the entry held when a later declaration is refused", () => {
    const { replica, subscriptions } = harness();
    const entry = subscriptions.open({ kind: "query", key: "typo", reads: [] });
    const seen: string[] = [];
    entry.onChange(() => seen.push("typo"));

    // The declaration the entry did make is the one it keeps: a refused
    // re-declaration is not a half-applied move, so the claims and keys the
    // entry held before it are still what dispatch reaches it through.
    entry.depend([{ id: "doc_1", components: ["document/title"] }]);
    expect(() => entry.depend([{ id: "doc_1", components: ["document/body"] }], TYPO)).toThrow(
      UnknownIndexError,
    );

    expect(entry.dependencies).toEqual([{ id: "doc_1", components: ["document/title"] }]);
    writeTitle(replica, "Renamed", 2);
    expect(seen).toEqual(["typo"]);

    entry.release();
    subscriptions.close();
  });

  it("leaves no subscription behind when opening is refused", () => {
    const { subscriptions } = harness();

    // A refused declaration fails the open, so the registry holds nothing for
    // that key: the author fixes the name and subscribes again rather than
    // inheriting a half-built entry no dispatch can reach. The refusal names the
    // key they opened, which is the query they have to go and fix.
    let refusal: unknown;
    try {
      subscriptions.open({ kind: "query", key: "typo", reads: [], indices: TYPO });
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(UnknownIndexError);
    // SAFETY: asserted to be one on the line above.
    expect((refusal as UnknownIndexError).subject).toBe("typo");
    expect((refusal as UnknownIndexError).message).toContain('declared by "typo"');
    expect(subscriptions.stats().live).toBe(0);
    expect(subscriptions.entries()).toEqual([]);

    const entry = subscriptions.open({ kind: "query", key: "typo", reads: [] });
    expect(entry.state).toBe("live");
    entry.release();
    subscriptions.close();
  });

  it("keeps the fallback in a production build", () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { replica, subscriptions } = harness();
      const entry = subscriptions.open({ kind: "query", key: "typo", reads: [] });
      const seen: string[] = [];
      entry.onChange(() => seen.push("typo"));

      // A shipped app may not crash on a declaration it cannot narrow, so the
      // index falls back to the breadth #961 gave: every declarer is touched,
      // which is an extra touch and never a miss.
      entry.depend([], TYPO);
      writeTitle(replica, "Renamed", 2);

      expect(seen).toEqual(["typo"]);
      entry.release();
      subscriptions.close();
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});

describe("subscription registry at the client seam", () => {
  const note = defineModel("note", {
    title: e.string(),
    body: defineComponent("note/body", e.string()),
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

  it("keeps a peer row subscription alive when one unsubscribe runs twice", async () => {
    const client = mkClient();
    await callApplyAction(
      client,
      put(1, "note_1", "note", { title: "Doc", body: "300 KB" }),
      "grp_1",
    );
    const row = await client.note.get("note_1");
    let peerFires = 0;
    const off = row!.subscribe(() => {});
    const offPeer = row!.subscribeAccessors(() => {
      peerFires += 1;
    });
    expect(client.subscriptions.entries()[0].refs).toBe(2);

    // A detach from React can run twice; the peer's share must survive it.
    off();
    off();

    expect(client.subscriptions.stats().live).toBe(1);
    await callApplyAction(
      client,
      put(2, "note_1", "note", { title: "Renamed", body: "300 KB" }),
      "grp_1",
    );
    expect(peerFires).toBe(1);

    offPeer();
    expect(client.subscriptions.stats().live).toBe(0);
  });

  it("leases the components a row subscription's read selected until it unsubscribes", async () => {
    const client = mkClient({ residencyTtlMs: 0 });
    await callApplyAction(
      client,
      put(1, "note_1", "note", { title: "Doc", body: "300 KB" }),
      "grp_1",
    );

    const row = await client.note.get("note_1");
    expect(row?.body).toBe("300 KB");
    // The row is fully resident, so the read installed nothing and claimed
    // nothing: there was no value for a lease to keep.
    expect(client.replicaStats.leases).toMatchObject({ leased: 0, inactive: 0 });

    const off = row!.subscribe(() => {});
    await flushTasks();

    // The live row subscription owns the body, so nothing can take it away.
    expect(client.replicaStats.leases).toMatchObject({
      leased: 2,
      inactive: 0,
      byComponent: { "note/body": { leased: 1, inactive: 0 } },
    });

    off();
    expect(client.replicaStats.leases).toMatchObject({ leased: 0, inactive: 2 });
  });

  it("uses one residency TTL for a query result and the claims it owns", async () => {
    const client = mkClient({ residencyTtlMs: 20 });
    await callApplyAction(client, put(1, "todo_1", "todo", { title: "Ship" }), "grp_1");

    const store = client.todo.query().result();
    const off = store.subscribe(() => {});
    await waitFor(() => store.getSnapshot().status === "current");
    off();
    // The released result is not gone: it is inactive and owns its claim.
    expect(client.subscriptions.stats()).toMatchObject({ live: 0, inactive: 1 });

    // A remount inside the TTL takes the same result back without a run.
    const remount = client.todo.query().result();
    expect(remount.getSnapshot()).toMatchObject({ status: "current", loading: false });
    const offRemount = remount.subscribe(() => {});
    await flushTasks();
    expect(client.subscriptions.stats()).toMatchObject({ live: 1, inactive: 0 });

    // A relevant change marks the inactive result stale instead of running it.
    offRemount();
    await callApplyAction(client, put(2, "todo_1", "todo", { title: "Renamed" }), "grp_1");
    expect(remount.getSnapshot().status).toBe("stale");
    const remountAgain = client.todo.query().result();
    const offAgain = remountAgain.subscribe(() => {});
    await waitFor(() => remountAgain.getSnapshot().status === "current");
    expect(remountAgain.getSnapshot().data?.[0]).toMatchObject({ title: "Renamed" });
    offAgain();

    // After the one TTL the result has ended, so a remount starts unloaded.
    await waitFor(() => client.subscriptions.stats().inactive === 0);
    expect(client.todo.query().result().getSnapshot()).toMatchObject({
      data: undefined,
      status: "unloaded",
    });
  });
});

/**
 * The dev-only lease watchdog (#944). A subscription that never lets go is the
 * one leak a refcounted, uncapped residency model cannot heal by itself, so the
 * registry reports two shapes of it instead: a live entry whose claim set has
 * not moved for the watchdog horizon, and a `close()` that leaves live readers
 * behind.
 */
describe("subscription registry: the lease watchdog (#944)", () => {
  const HORIZON_MS = 5 * 60_000;

  /** A live row entry over the seeded document, on a registry with a spy sink. */
  const watched = async (options: { enabled?: boolean } = {}) => {
    const warn = vi.fn();
    const { replica } = harness();
    await replica.read("doc_1", [LAZY]);
    const subscriptions = createSubscriptionRegistry(replica, {
      watchdog: { enabled: options.enabled ?? true, warn },
    });
    const live = subscriptions.open({ kind: "row", row: "doc_1" });
    return { replica, subscriptions, live, warn };
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("warns once about a live subscription older than the horizon with a fixed claim set", async () => {
    vi.useFakeTimers();
    const { warn } = await watched();

    vi.advanceTimersByTime(HORIZON_MS - 1);
    expect(warn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    // The report names the reader and how long it has been quiet, so a
    // developer can find the component that owns it.
    expect(message).toContain("lease watchdog");
    expect(message).toContain("doc_1");
    expect(message).toContain(String(HORIZON_MS / 1000));
  });

  it("does not repeat a warning while the claim set is unchanged", async () => {
    vi.useFakeTimers();
    const { warn } = await watched();

    vi.advanceTimersByTime(HORIZON_MS * 3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for a subscription whose claim set churns", async () => {
    vi.useFakeTimers();
    const { live, warn } = await watched();

    // A reader that keeps re-reading is working, not stuck: each change
    // restarts the quiet period.
    for (let step = 0; step < 4; step += 1) {
      vi.advanceTimersByTime(HORIZON_MS - 1);
      live.depend([{ id: "doc_1", components: step % 2 === 0 ? [LAZY] : ["document/title"] }]);
    }

    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a quiet period that starts again after a claim-set change", async () => {
    vi.useFakeTimers();
    const { live, warn } = await watched();

    vi.advanceTimersByTime(HORIZON_MS + 1);
    expect(warn).toHaveBeenCalledTimes(1);

    // The change starts a new quiet period, and the next scan past the horizon
    // reports the new one; the set it already reported is not reported twice.
    live.depend([{ id: "doc_1", components: [LAZY] }]);
    vi.advanceTimersByTime(HORIZON_MS + 61_000);
    expect(warn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(HORIZON_MS);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does not restart the quiet period for a key-set change alone", async () => {
    vi.useFakeTimers();
    const { replica, live, warn } = await watched();

    vi.advanceTimersByTime(HORIZON_MS - 1);
    // Keys moved, claims did not: the entry is still working on the same claim
    // set, so the quiet period it was already in is the one that is reported.
    live.depend(live.dependencies, [{ index: "membership", key: "doc_9" }]);
    vi.advanceTimersByTime(2);
    expect(warn).toHaveBeenCalledTimes(1);

    // The key really did move. A row entry matches only its own row otherwise,
    // so a supplied key that never reached dispatch would touch nothing here.
    const seen: string[] = [];
    live.onChange(() => seen.push("doc_9"));
    replica.ingest(
      { id: "a_2", actor_id: "actor_1", hlc: makeHlc(2), gsn: 2, updates: [] },
      platformUpdate("eg_9", "membership", "put", { entity_id: "doc_9", group_id: "grp_1" }),
      2,
    );
    expect(seen).toEqual(["doc_9"]);
  });

  it("does not warn about a released subscription or an inactive result", async () => {
    vi.useFakeTimers();
    const { subscriptions, live, warn } = await watched();

    live.release();
    const query = subscriptions.open({
      kind: "query",
      key: "rows:document",
      reads: ["document/*"],
    });
    query.release();

    vi.advanceTimersByTime(HORIZON_MS * 2);
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * `false` is the off switch, not an empty config. An empty one falls through
   * to the dev gate, which is on in a test run, so `false` has to mean
   * `{ enabled: false }` rather than "leave the default to answer".
   */
  it("turns the watchdog off for `false` instead of leaving it on", async () => {
    vi.useFakeTimers();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { replica } = harness();
      await replica.read("doc_1", [LAZY]);

      // The default is the dev gate, and in a test that is on: one interval.
      const byDefault = createSubscriptionRegistry(replica);
      const live = byDefault.open({ kind: "row", row: "doc_1" });
      expect(vi.getTimerCount()).toBe(1);
      live.release();
      byDefault.close();

      for (const off of [false, { enabled: false }] as const) {
        const subscriptions = createSubscriptionRegistry(replica, { watchdog: off });
        subscriptions.open({ kind: "row", row: "doc_1" });
        expect(vi.getTimerCount()).toBe(0);

        // Nothing past the horizon, and no `close()` report either.
        vi.advanceTimersByTime(HORIZON_MS * 2);
        expect(consoleWarn).not.toHaveBeenCalled();
        subscriptions.close();
        expect(consoleWarn).not.toHaveBeenCalled();
      }
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("warns once when it closes with live subscriptions still holding claims", async () => {
    const warn = vi.fn();
    const { replica } = harness();
    await replica.read("doc_1", [LAZY]);
    const subscriptions = createSubscriptionRegistry(replica, {
      watchdog: { enabled: true, warn },
    });
    subscriptions.open({ kind: "row", row: "doc_1" });
    subscriptions.open({ kind: "query", key: "rows:document", reads: ["document/*"] });

    subscriptions.close();
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain("close()");
    expect(message).toContain("2 live subscription");
    expect(message).toContain("claim");

    // A second teardown is inert, and so is the watchdog after it.
    subscriptions.close();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  /**
   * A sink is host code, so it can throw. The report is measured before
   * teardown and delivered after it: a throwing sink surfaces its own failure
   * without leaving a closed registry that still holds its claims.
   */
  it("tears down before reporting, so a throwing sink cannot strand the entries", async () => {
    vi.useFakeTimers();
    const warn = vi.fn(() => {
      throw new Error("sink failed");
    });
    const { replica } = harness();
    await replica.read("doc_1", [LAZY]);
    const subscriptions = createSubscriptionRegistry(replica, {
      watchdog: { enabled: true, warn },
    });
    const live = subscriptions.open({ kind: "row", row: "doc_1" });
    subscriptions.open({ kind: "query", key: "rows:document", reads: ["document/*"] });
    expect(replica.stats().leases.leased).toBeGreaterThan(0);

    expect(() => subscriptions.close()).toThrow("sink failed");

    // Closed *and* torn down: no entry left behind, and no claim still held.
    expect(live.state).toBe("terminal");
    expect(subscriptions.entries()).toEqual([]);
    expect(subscriptions.stats()).toMatchObject({ live: 0, inactive: 0, dependencies: 0 });
    // What survives is the released values' own residency grace period, not a
    // subscription's claim.
    await vi.advanceTimersByTimeAsync(DEFAULT_RESIDENCY_TTL_MS);
    expect(replica.stats().leases).toMatchObject({ leased: 0, inactive: 0 });

    // Closed, so a second teardown neither reports nor throws again.
    expect(() => subscriptions.close()).not.toThrow();
  });

  it("is inert in a production build", async () => {
    vi.useFakeTimers();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { replica } = harness();
      await replica.read("doc_1", [LAZY]);
      const warn = vi.fn();
      const subscriptions = createSubscriptionRegistry(replica, { watchdog: { warn } });
      subscriptions.open({ kind: "row", row: "doc_1" });
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(HORIZON_MS * 2);
      expect(warn).not.toHaveBeenCalled();

      subscriptions.close();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  /**
   * The `NODE_ENV` test above only covers the Node path, which already worked.
   * A shipped browser bundle has no `process` global at all — the define
   * replaces the flag wholesale — so the gate has to answer off when it cannot
   * read it. The previous `typeof process === "undefined" || ...` form read that
   * absence as "development" and so enabled the watchdog in production.
   */
  it("is inert where there is no `process` to read, as in a browser bundle", async () => {
    vi.useFakeTimers();
    const { replica } = harness();
    await replica.read("doc_1", [LAZY]);
    const warn = vi.fn();

    // What a consumer's production build leaves behind: the flag folded out,
    // no `process` in the bundle's scope.
    vi.stubGlobal("process", undefined);
    try {
      const subscriptions = createSubscriptionRegistry(replica, { watchdog: { warn } });
      subscriptions.open({ kind: "row", row: "doc_1" });
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(HORIZON_MS * 2);
      subscriptions.close();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  /**
   * A host can also have a `process` that is not whole: some bundlers and test
   * harnesses define a bare `process = {}`. The gate runs inside
   * `createSubscriptionRegistry`, so a diagnostics flag that throws would crash
   * the client at construction. No `env` reads as no flag, and no flag reads as
   * development, so the watchdog stays armed exactly as it does in a test run.
   *
   * The expression is evaluated from its own source because a test run cannot
   * exercise the module's copy: Vitest defines `process.env.NODE_ENV` to
   * itself, and esbuild's define pass rewrites that member inside the optional
   * chain — the very read the chain exists to avoid. Outside an identity define
   * — a production build, Vite's dev server, plain ESM — the chain stays, which
   * the bundler check below measures.
   */
  it("reads a bare `process` shim with no `env` as a development host", () => {
    const gate = new Function("process", `return ${gateSource()};`) as (proc: unknown) => boolean;

    expect(() => gate({})).not.toThrow();
    expect(gate({})).toBe(true);
    expect(gate(undefined)).toBe(false);
    expect(gate({ env: {} })).toBe(true);
    expect(gate({ env: { NODE_ENV: "production" } })).toBe(false);
  });

  /**
   * The same partial shim, through the registry: a `process` whose `env` exists
   * but carries no flag must not throw at construction, and must leave the
   * watchdog armed. A test run's define rewrites only the optional chain, so
   * this shape does reach the gate as written.
   */
  it("stays armed for a `process` whose `env` has no flag", async () => {
    vi.useFakeTimers();
    const { replica } = harness();
    await replica.read("doc_1", [LAZY]);
    const warn = vi.fn();

    vi.stubGlobal("process", { env: {} });
    try {
      const subscriptions = createSubscriptionRegistry(replica, { watchdog: { warn } });
      const live = subscriptions.open({ kind: "row", row: "doc_1" });
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(HORIZON_MS + 1);
      expect(warn).toHaveBeenCalledTimes(1);

      live.release();
      subscriptions.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  /**
   * Foldability is a property of the source form, so it is pinned at the source.
   * A bundler substitutes `process.env.NODE_ENV` only as that exact member
   * expression and never folds `typeof process`, so the absent-`process` case
   * has to come first and answer `false`: the whole expression then folds to
   * `false` (esbuild emits `!1`). Written as an `||` alternative it keeps
   * `typeof process > "u"` in the bundle, which resolves to `true` there.
   *
   * The optional chain on `env` does not survive the fold either: the defined
   * member expression is still matched inside it, so the bundled gate is the
   * same `() => !1` while a bare `process` shim reads without throwing.
   *
   * Proved with esbuild over the built client for `platform: "browser"` and
   * `define: { "process.env.NODE_ENV": '"production"' }`, evaluated in a `vm`
   * with no `process`: this form emits no timer and no message, the previous
   * one warned past the horizon.
   */
  /** The gate's body exactly as the source writes it, for the shape and shim tests. */
  const gateSource = (): string => {
    const source = readFileSync(new URL("../subscriptions.ts", import.meta.url), "utf8");
    return (/const devWatchdog = \(\): boolean =>([^;]*);/.exec(source)?.[1] ?? "").trim();
  };

  it("writes the gate in the shape a production bundle folds away", () => {
    expect(gateSource().replace(/\s+/g, " ")).toBe(
      'typeof process === "undefined" ? false : process.env?.NODE_ENV !== "production"',
    );
  });
});
