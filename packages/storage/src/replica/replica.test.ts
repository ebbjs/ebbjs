import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHlc, type Action, type Entity, type FieldValue, type Update } from "@ebbjs/core";

import { REPLICA_RECORD_FORMAT } from "../internal/replica-record";
import type { ReplicaRecord } from "../types/replica-store";
import { contentChanged } from "./content-changed";
import { createReplica, holdAll } from "./replica";
import type { Replica } from "./types";

const leaf = (value: unknown, updateId: string, ms: number): FieldValue => ({
  value,
  update_id: updateId,
  hlc: makeHlc(ms),
});

const map = (entries: Record<string, FieldValue>): FieldValue => ({ map: entries });

interface WriteSpec {
  readonly actionId: string;
  readonly updateId: string;
  readonly entityId?: string;
  readonly type?: string;
  readonly gsn?: number;
  readonly ms?: number;
  readonly fields: Record<string, FieldValue>;
}

const action = (
  method: "put" | "patch" | "delete",
  spec: WriteSpec,
  data: Update["data"],
): Action => ({
  id: spec.actionId,
  actor_id: "user_1",
  hlc: makeHlc(spec.ms ?? 1),
  gsn: spec.gsn ?? 1,
  updates: [
    {
      id: spec.updateId,
      subject_id: spec.entityId ?? "e_1",
      subject_type: spec.type ?? "todo",
      method,
      data,
    },
  ],
});

const put = (spec: WriteSpec): Action => action("put", spec, { fields: spec.fields });
const patch = (spec: WriteSpec): Action => action("patch", spec, { fields: spec.fields });
const remove = (spec: Omit<WriteSpec, "fields">): Action =>
  action("delete", { ...spec, fields: {} }, null);

/** A materialized relationship row: `sourceId` —author/wrote→ `targetId`. */
const relationship = (
  actionId: string,
  rowId: string,
  sourceId: string,
  targetId: string,
  gsn: number,
  ms: number,
): Action =>
  put({
    actionId,
    updateId: `u_${rowId}`,
    entityId: rowId,
    type: "relationship",
    gsn,
    ms,
    fields: {
      field: leaf("author", `u_${rowId}`, ms),
      type: leaf("wrote", `u_${rowId}`, ms),
      source_id: leaf(sourceId, `u_${rowId}`, ms),
      target_id: leaf(targetId, `u_${rowId}`, ms),
    },
  });

/** A materialized entityGroup row putting `entityId` in `groupId`. */
const membership = (
  actionId: string,
  rowId: string,
  groupId: string,
  entityId: string,
  gsn: number,
  ms: number,
): Action =>
  put({
    actionId,
    updateId: `u_${rowId}`,
    entityId: rowId,
    type: "entityGroup",
    gsn,
    ms,
    fields: {
      group_id: leaf(groupId, `u_${rowId}`, ms),
      entity_id: leaf(entityId, `u_${rowId}`, ms),
    },
  });

const ingest = (replica: Replica, write: Action, position: number): number =>
  replica.ingest(write, write.updates, position);

const entity = (overrides: Partial<Entity> = {}): Entity => ({
  id: "e_1",
  type: "todo",
  data: { fields: {} },
  created_hlc: makeHlc(1),
  updated_hlc: makeHlc(1),
  deleted_hlc: null,
  last_gsn: 1,
  ...overrides,
});

describe("contentChanged", () => {
  it("is false for the same reference and true for absence", () => {
    const row = entity();
    expect(contentChanged(row, row)).toBe(false);
    expect(contentChanged(undefined, undefined)).toBe(false);
    expect(contentChanged(null, undefined)).toBe(false);
    expect(contentChanged(row, undefined)).toBe(true);
  });

  it("ignores a last_gsn-only change", () => {
    const row = entity();
    expect(contentChanged(row, { ...row, last_gsn: 99 })).toBe(false);
  });

  it("detects type, updated_hlc, deleted_hlc and field changes", () => {
    const row = entity();
    expect(contentChanged(row, { ...row, type: "note" })).toBe(true);
    expect(contentChanged(row, { ...row, updated_hlc: makeHlc(9) })).toBe(true);
    expect(contentChanged(row, { ...row, deleted_hlc: makeHlc(9) })).toBe(true);
    expect(contentChanged(row, { ...row, data: { fields: { title: leaf("x", "u_x", 1) } } })).toBe(
      true,
    );
  });

  it("sees through a touched key while sharing untouched siblings", () => {
    const shared = leaf("a", "u_a", 1);
    const before = entity({
      data: { fields: { content: map({ a: shared, b: leaf("b", "u_b", 1) }) } },
    });
    const after = entity({
      data: { fields: { content: map({ a: shared, b: leaf("b2", "u_b2", 2) }) } },
    });
    expect(contentChanged(before, after)).toBe(true);
    expect(contentChanged(before, before)).toBe(false);
  });
});

describe("replica: durable fold", () => {
  it("materializes a put into the base and the type index", () => {
    const replica = createReplica();
    expect(
      ingest(
        replica,
        put({
          actionId: "a_1",
          updateId: "u_1",
          ms: 10,
          fields: { title: leaf("Hello", "u_1", 10) },
        }),
        1,
      ),
    ).toBe(1);
    const row = replica.get("e_1");
    expect(row?.type).toBe("todo");
    expect(row?.data.fields.title).toEqual(leaf("Hello", "u_1", 10));
    expect(row?.last_gsn).toBe(1);
    expect(replica.iterate("todo")).toEqual([row]);
    expect(replica.iterate("note")).toEqual([]);
  });

  it("applies a higher-HLC patch and bumps the revision", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        ms: 10,
        fields: { title: leaf("Hello", "u_1", 10) },
      }),
      1,
    );
    expect(
      ingest(
        replica,
        patch({
          actionId: "a_2",
          updateId: "u_2",
          gsn: 2,
          ms: 20,
          fields: { title: leaf("Updated", "u_2", 20) },
        }),
        2,
      ),
    ).toBe(2);
    expect(replica.get("e_1")?.data.fields.title).toEqual(leaf("Updated", "u_2", 20));
  });

  it("stores a lower-HLC patch without bumping the revision", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        ms: 20,
        fields: { title: leaf("Hello", "u_1", 20) },
      }),
      1,
    );
    const before = replica.revision;
    expect(
      ingest(
        replica,
        patch({
          actionId: "a_2",
          updateId: "u_2",
          gsn: 5,
          ms: 10,
          fields: { title: leaf("Older", "u_2", 10) },
        }),
        2,
      ),
    ).toBe(before);
    expect(replica.get("e_1")?.data.fields.title).toEqual(leaf("Hello", "u_1", 20));
    // The row is still stored, so it deep-equals the adapter's delivery.
    expect(replica.get("e_1")?.last_gsn).toBe(5);
  });

  it("retains a tombstone and returns it from get and iterate", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        ms: 20,
        fields: { title: leaf("Hello", "u_1", 20) },
      }),
      1,
    );
    expect(ingest(replica, remove({ actionId: "a_2", updateId: "u_2", gsn: 2, ms: 30 }), 2)).toBe(
      2,
    );
    expect(replica.get("e_1")?.deleted_hlc).toBe(makeHlc(30));
    expect(replica.iterate("todo")).toHaveLength(1);
  });

  it("ignores a patch on a tombstone", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        ms: 20,
        fields: { title: leaf("Hello", "u_1", 20) },
      }),
      1,
    );
    ingest(replica, remove({ actionId: "a_2", updateId: "u_2", gsn: 2, ms: 30 }), 2);
    expect(
      ingest(
        replica,
        patch({
          actionId: "a_3",
          updateId: "u_3",
          gsn: 3,
          ms: 40,
          fields: { title: leaf("Zombie", "u_3", 40) },
        }),
        3,
      ),
    ).toBe(2);
    expect(replica.get("e_1")?.data.fields.title).toEqual(leaf("Hello", "u_1", 20));
    expect(replica.get("e_1")?.deleted_hlc).toBe(makeHlc(30));
  });

  it("breaks an equal-HLC tie toward the greater update_id, win and lose", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_seed",
        updateId: "u_seed",
        ms: 50,
        fields: { title: leaf("Seed", "u_seed", 50) },
      }),
      1,
    );
    ingest(
      replica,
      patch({
        actionId: "a_lose",
        updateId: "u_lose",
        gsn: 2,
        ms: 50,
        fields: { title: leaf("Loser", "u_aaa", 50) },
      }),
      2,
    );
    expect(replica.get("e_1")?.data.fields.title).toEqual(leaf("Seed", "u_seed", 50));
    ingest(
      replica,
      patch({
        actionId: "a_win",
        updateId: "u_win",
        gsn: 3,
        ms: 50,
        fields: { title: leaf("Winner", "u_zzz", 50) },
      }),
      3,
    );
    expect(replica.get("e_1")?.data.fields.title).toEqual(leaf("Winner", "u_zzz", 50));
  });

  it("unions a map field, keeping sibling keys", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_a",
        ms: 10,
        fields: { content: map({ a: leaf(1, "u_a", 10) }) },
      }),
      1,
    );
    ingest(
      replica,
      patch({
        actionId: "a_2",
        updateId: "u_b",
        gsn: 2,
        ms: 20,
        fields: { content: map({ b: leaf(2, "u_b", 20) }) },
      }),
      2,
    );
    expect(replica.get("e_1")?.data.fields.content).toEqual(
      map({ a: leaf(1, "u_a", 10), b: leaf(2, "u_b", 20) }),
    );
  });

  it("journals observable changes and serves changesSince", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        ms: 20,
        fields: { title: leaf("Hello", "u_1", 20) },
      }),
      1,
    );
    ingest(
      replica,
      patch({
        actionId: "a_2",
        updateId: "u_2",
        gsn: 5,
        ms: 10,
        fields: { title: leaf("Older", "u_2", 10) },
      }),
      2,
    );
    ingest(
      replica,
      patch({
        actionId: "a_3",
        updateId: "u_3",
        gsn: 6,
        ms: 30,
        fields: { title: leaf("Newer", "u_3", 30) },
      }),
      3,
    );
    expect(replica.revision).toBe(2);
    expect(replica.changesSince(0)).toEqual([
      { revision: 1, id: "e_1", type: "todo", deleted: false },
      { revision: 2, id: "e_1", type: "todo", deleted: false },
    ]);
    expect(replica.changesSince(1)).toEqual([
      { revision: 2, id: "e_1", type: "todo", deleted: false },
    ]);
    expect(replica.changesSince(2)).toEqual([]);
  });

  it("moves an id between type indices when a put changes its type", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({ actionId: "a_1", updateId: "u_1", ms: 10, fields: { title: leaf("Todo", "u_1", 10) } }),
      1,
    );
    ingest(
      replica,
      put({
        actionId: "a_2",
        updateId: "u_2",
        gsn: 2,
        type: "note",
        ms: 20,
        fields: { title: leaf("Note", "u_2", 20) },
      }),
      2,
    );
    expect(replica.iterate("todo")).toEqual([]);
    expect(replica.iterate("note")).toHaveLength(1);
    expect(replica.get("e_1")?.type).toBe("note");
  });

  it("folds only the delta, so a re-delivered put cannot revert a newer patch", () => {
    const replica = createReplica();
    const base = put({
      actionId: "a_1",
      updateId: "u_1",
      ms: 10,
      fields: { title: leaf("Base", "u_1", 10) },
    });
    ingest(replica, base, 1);
    ingest(
      replica,
      patch({
        actionId: "a_2",
        updateId: "u_2",
        gsn: 2,
        ms: 20,
        fields: { title: leaf("Newer", "u_2", 20) },
      }),
      2,
    );
    expect(replica.ingest(base, [], 3)).toBe(2);
    expect(replica.get("e_1")?.data.fields.title).toEqual(leaf("Newer", "u_2", 20));
  });

  it("shares row objects across reads and returns a fresh array from iterate", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        ms: 10,
        fields: { title: leaf("Hello", "u_1", 10) },
      }),
      1,
    );
    const first = replica.get("e_1");
    expect(replica.get("e_1")).toBe(first);
    const rows = replica.iterate("todo") as Entity[];
    expect(rows[0]).toBe(first);
    expect(replica.iterate("todo")).not.toBe(rows);
    rows.push(entity({ id: "e_intruder" }));
    expect(replica.iterate("todo")).toHaveLength(1);
  });
});

describe("replica: optimistic overlay", () => {
  it("shows an optimistic put before the echo and converges without a bump", () => {
    const replica = createReplica();
    const write = put({
      actionId: "a_1",
      updateId: "u_1",
      gsn: 7,
      ms: 20,
      fields: { title: leaf("Local", "u_1", 20) },
    });
    expect(replica.optimistic(write)).toBe(1);
    expect(replica.get("e_1")?.data.fields.title).toEqual(leaf("Local", "u_1", 20));
    const converged = replica.revision;
    expect(ingest(replica, write, 1)).toBe(converged);
    expect(replica.get("e_1")?.data.fields.title).toEqual(leaf("Local", "u_1", 20));
  });

  it("keeps an optimistic patch with no base absent", () => {
    const replica = createReplica();
    expect(
      replica.optimistic(
        patch({
          actionId: "a_1",
          updateId: "u_1",
          ms: 20,
          fields: { title: leaf("Ghost", "u_1", 20) },
        }),
      ),
    ).toBe(0);
    expect(replica.get("e_1")).toBeUndefined();
    expect(replica.iterate("todo")).toEqual([]);
  });

  it("reverts the composed view when an optimistic action is discarded", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_put",
        updateId: "u_put",
        ms: 10,
        fields: { title: leaf("Base", "u_put", 10) },
      }),
      1,
    );
    const base = replica.revision;
    expect(
      replica.optimistic(
        patch({
          actionId: "a_local",
          updateId: "u_local",
          ms: 20,
          fields: { title: leaf("Local", "u_local", 20) },
        }),
      ),
    ).toBe(base + 1);
    expect(replica.get("e_1")?.data.fields.title).toEqual(leaf("Local", "u_local", 20));
    expect(replica.discard("a_local")).toBe(base + 2);
    expect(replica.get("e_1")?.data.fields.title).toEqual(leaf("Base", "u_put", 10));
  });

  it("recomposes an overlaid id when an unrelated durable action lands", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_put",
        updateId: "u_put",
        ms: 10,
        fields: { title: leaf("Base", "u_put", 10), note: leaf("n", "u_n", 10) },
      }),
      1,
    );
    replica.optimistic(
      patch({
        actionId: "a_local",
        updateId: "u_local",
        ms: 30,
        fields: { title: leaf("Local", "u_local", 30) },
      }),
    );
    ingest(
      replica,
      patch({
        actionId: "a_peer",
        updateId: "u_peer",
        gsn: 2,
        ms: 20,
        fields: { note: leaf("peer", "u_peer", 20) },
      }),
      2,
    );
    expect(replica.get("e_1")?.data.fields.title).toEqual(leaf("Local", "u_local", 30));
    expect(replica.get("e_1")?.data.fields.note).toEqual(leaf("peer", "u_peer", 20));
  });
});

describe("replica: orphan reconciliation (#475)", () => {
  it("retains a patch that arrives before its base and reconciles on a later put", () => {
    const replica = createReplica();
    ingest(
      replica,
      patch({
        actionId: "a_patch",
        updateId: "u_patch",
        gsn: 5,
        ms: 50,
        fields: { title: leaf("Patched", "u_patch", 50) },
      }),
      1,
    );
    expect(replica.get("e_1")).toBeUndefined();
    ingest(
      replica,
      put({
        actionId: "a_put",
        updateId: "u_put",
        gsn: 3,
        ms: 30,
        fields: { title: leaf("Base", "u_put", 30) },
      }),
      2,
    );
    expect(replica.get("e_1")?.data.fields.title).toEqual(leaf("Patched", "u_patch", 50));
    expect(replica.get("e_1")?.last_gsn).toBe(5);
  });

  it("supersedes an orphan whose gsn does not exceed the put's", () => {
    const replica = createReplica();
    ingest(
      replica,
      patch({
        actionId: "a_patch",
        updateId: "u_patch",
        gsn: 2,
        ms: 20,
        fields: { title: leaf("Patched", "u_patch", 20) },
      }),
      1,
    );
    ingest(
      replica,
      put({
        actionId: "a_put",
        updateId: "u_put",
        gsn: 5,
        ms: 30,
        fields: { title: leaf("Base", "u_put", 30) },
      }),
      2,
    );
    expect(replica.get("e_1")?.data.fields.title).toEqual(leaf("Base", "u_put", 30));
  });

  it("caps the record position at the oldest retained orphan", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_put",
        updateId: "u_put",
        ms: 10,
        fields: { title: leaf("Base", "u_put", 10) },
      }),
      1,
    );
    ingest(
      replica,
      patch({
        actionId: "a_patch",
        updateId: "u_patch",
        entityId: "e_orphan",
        gsn: 5,
        ms: 50,
        fields: { title: leaf("Patched", "u_patch", 50) },
      }),
      2,
    );
    expect(replica.toRecord().position).toBe(1);
    const clean = createReplica();
    ingest(
      clean,
      put({
        actionId: "a_put",
        updateId: "u_put",
        ms: 10,
        fields: { title: leaf("Base", "u_put", 10) },
      }),
      4,
    );
    expect(clean.toRecord().position).toBe(4);
  });
});

describe("replica: load and toRecord", () => {
  it("loads a record and folds the tail to match an incremental fold", () => {
    const incremental = createReplica();
    ingest(
      incremental,
      put({ actionId: "a_1", updateId: "u_1", ms: 10, fields: { title: leaf("Base", "u_1", 10) } }),
      1,
    );
    ingest(
      incremental,
      patch({
        actionId: "a_2",
        updateId: "u_2",
        gsn: 2,
        ms: 20,
        fields: { title: leaf("Mid", "u_2", 20) },
      }),
      2,
    );
    const record = incremental.toRecord();
    expect(record.format).toBe(REPLICA_RECORD_FORMAT);

    const hydrated = createReplica();
    expect(hydrated.load(record)).toBe(record.revision);
    expect(hydrated.get("e_1")).toEqual(incremental.get("e_1"));

    ingest(
      hydrated,
      patch({
        actionId: "a_3",
        updateId: "u_3",
        gsn: 3,
        ms: 30,
        fields: { title: leaf("Tail", "u_3", 30) },
      }),
      3,
    );
    ingest(
      incremental,
      patch({
        actionId: "a_3",
        updateId: "u_3",
        gsn: 3,
        ms: 30,
        fields: { title: leaf("Tail", "u_3", 30) },
      }),
      3,
    );
    expect(hydrated.get("e_1")).toEqual(incremental.get("e_1"));
    expect(hydrated.iterate("todo")).toEqual(incremental.iterate("todo"));
    expect(hydrated.revision).toBe(incremental.revision);
  });

  it("persists and reloads a gsn-0 backfill row", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_bf",
        updateId: "u_bf",
        gsn: 0,
        ms: 10,
        fields: { title: leaf("Fetched", "u_bf", 10) },
      }),
      1,
    );
    const record = replica.toRecord();
    expect(record.position).toBe(1);

    const hydrated = createReplica();
    hydrated.load(record);
    expect(hydrated.get("e_1")?.data.fields.title).toEqual(leaf("Fetched", "u_bf", 10));
    expect(hydrated.get("e_1")?.last_gsn).toBe(0);
  });

  it("ignores an invalid record and leaves the replica untouched", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({ actionId: "a_1", updateId: "u_1", ms: 10, fields: { title: leaf("Base", "u_1", 10) } }),
      1,
    );
    const before = replica.get("e_1");
    const revision = replica.revision;
    expect(replica.load({ format: 99 } as unknown as ReplicaRecord)).toBe(revision);
    expect(replica.get("e_1")).toBe(before);
    expect(replica.iterate("todo")).toHaveLength(1);
  });
});

describe("replica: materialization policy", () => {
  it("defaults to holding every type", () => {
    expect(holdAll.holds("todo")).toBe(true);
    expect(holdAll.holds("anything")).toBe(true);
  });

  it("neither retains nor journals a not-held type", () => {
    const replica = createReplica({ materialization: { holds: (type) => type !== "cold" } });
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        entityId: "e_cold",
        type: "cold",
        ms: 10,
        fields: { title: leaf("Cold", "u_1", 10) },
      }),
      1,
    );
    expect(replica.get("e_cold")).toBeUndefined();
    expect(replica.iterate("cold")).toEqual([]);
    expect(replica.revision).toBe(0);
    expect(replica.changesSince(0)).toEqual([]);
  });

  it("journals the held row a put moves into a not-held type exactly once", () => {
    const replica = createReplica({ materialization: { holds: (type) => type !== "cold" } });
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        ms: 10,
        fields: { title: leaf("Todo", "u_1", 10) },
      }),
      1,
    );
    expect(replica.revision).toBe(1);
    ingest(
      replica,
      put({
        actionId: "a_2",
        updateId: "u_2",
        gsn: 2,
        type: "cold",
        ms: 20,
        fields: { title: leaf("Cold", "u_2", 20) },
      }),
      2,
    );
    expect(replica.get("e_1")).toBeUndefined();
    expect(replica.iterate("todo")).toEqual([]);
    expect(replica.revision).toBe(2);
    expect(replica.changesSince(1)).toEqual([
      { revision: 2, id: "e_1", type: "todo", deleted: true },
    ]);
  });
});

describe("replica: change signal", () => {
  it("notifies after an observable fold settles and stops on unsubscribe", () => {
    const replica = createReplica();
    let fired = 0;
    const unsub = replica.subscribe(() => {
      fired += 1;
    });

    ingest(
      replica,
      put({ actionId: "a_1", updateId: "u_1", fields: { title: leaf("Todo", "u_1", 10) } }),
      1,
    );
    expect(fired).toBe(1);
    expect(replica.revision).toBe(1);

    replica.optimistic(
      put({ actionId: "a_2", updateId: "u_2", fields: { title: leaf("Next", "u_2", 20) } }),
    );
    expect(fired).toBe(2);

    replica.discard("a_2");
    expect(fired).toBe(3);

    unsub();
    replica.discard("a_1");
    expect(fired).toBe(3);
  });

  it("fires for a no-op write too, leaving the revision to say nothing changed", () => {
    const replica = createReplica();
    let fired = 0;
    replica.subscribe(() => {
      fired += 1;
    });
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        ms: 20,
        fields: { title: leaf("Todo", "u_1", 20) },
      }),
      1,
    );
    const revision = replica.revision;

    ingest(
      replica,
      patch({
        actionId: "a_2",
        updateId: "u_2",
        gsn: 2,
        ms: 10,
        fields: { title: leaf("Older", "u_2", 10) },
      }),
      2,
    );
    expect(replica.revision).toBe(revision);
    expect(fired).toBe(2);
  });

  it("notifies on load, which replaces the journal wholesale", () => {
    const replica = createReplica();
    let fired = 0;
    replica.subscribe(() => {
      fired += 1;
    });

    replica.load({
      format: REPLICA_RECORD_FORMAT,
      position: 0,
      revision: 7,
      entities: [entity({ id: "e_9", type: "note" })],
    });

    expect(fired).toBe(1);
    expect(replica.revision).toBe(7);
    expect(replica.get("e_9")?.type).toBe("note");
  });
});

describe("replica: evict (#499)", () => {
  it("drops rows and their adjacency, journaling each removal and ignoring absent ids", () => {
    const replica = createReplica();
    ingest(replica, relationship("a_r", "r_1", "src_1", "tgt_1", 1, 1), 1);
    ingest(replica, membership("a_m", "m_1", "grp_1", "e_1", 2, 2), 2);
    let fired = 0;
    replica.subscribe(() => {
      fired += 1;
    });

    expect(replica.evict(["r_1", "m_1", "missing", "r_1"])).toBe(4);

    expect(replica.get("r_1")).toBeUndefined();
    expect(replica.get("m_1")).toBeUndefined();
    expect(replica.iterate("relationship")).toEqual([]);
    expect(replica.iterate("entityGroup")).toEqual([]);
    expect(replica.relationships({ as: "author", type: "wrote", sourceId: "src_1" })).toEqual([]);
    expect(replica.relationships({ as: "author", type: "wrote", targetId: "tgt_1" })).toEqual([]);
    expect(replica.memberships({ groupId: "grp_1" })).toEqual([]);
    expect(replica.memberships({ entityId: "e_1" })).toEqual([]);
    expect(replica.relationshipLinks({ as: "author", type: "wrote", sourceId: "src_1" })).toEqual(
      [],
    );
    expect(replica.membershipLinks("e_1")).toEqual([]);
    expect(fired).toBe(1);
    expect(replica.changesSince(2)).toEqual([
      { revision: 3, id: "r_1", type: "relationship", deleted: true },
      { revision: 4, id: "m_1", type: "entityGroup", deleted: true },
    ]);

    // A repeat eviction removes nothing, so it neither bumps nor notifies.
    expect(replica.evict(["r_1", "missing"])).toBe(4);
    expect(fired).toBe(1);
  });
});

describe("replica: journal capacity (#499)", () => {
  const seed = (replica: Replica, count: number): void => {
    for (let i = 1; i <= count; i += 1) {
      ingest(
        replica,
        put({
          actionId: `a_${i}`,
          updateId: `u_${i}`,
          entityId: `e_${i}`,
          gsn: i,
          ms: i,
          fields: { title: leaf(`Row ${i}`, `u_${i}`, i) },
        }),
        i,
      );
    }
  };

  it("bounds the retained journal and moves the floor to the newest drop", () => {
    const replica = createReplica({ journalCapacity: 3 });
    for (let i = 1; i <= 6; i += 1) {
      ingest(
        replica,
        put({
          actionId: `a_${i}`,
          updateId: `u_${i}`,
          entityId: `e_${i}`,
          gsn: i,
          ms: i,
          fields: { title: leaf(`Row ${i}`, `u_${i}`, i) },
        }),
        i,
      );
      expect(replica.stats().changes).toBeLessThanOrEqual(3);
    }

    expect(replica.revision).toBe(6);
    expect(replica.changeFloor).toBe(3);
    expect(replica.stats().changeFloor).toBe(replica.changeFloor);
    expect(replica.stats().changes).toBe(3);
    // A cursor older than the floor cannot be served: the gap says reload.
    expect(replica.changesSince(0)).toEqual([]);
    expect(replica.changesSince(2)).toEqual([]);
    expect(replica.changesSince(replica.changeFloor)).toEqual([
      { revision: 4, id: "e_4", type: "todo", deleted: false },
      { revision: 5, id: "e_5", type: "todo", deleted: false },
      { revision: 6, id: "e_6", type: "todo", deleted: false },
    ]);
  });

  it("keeps the journal unbounded for a non-positive or non-finite capacity", () => {
    for (const capacity of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      const replica = createReplica({ journalCapacity: capacity });
      seed(replica, 5);
      expect(replica.changeFloor).toBe(0);
      expect(replica.stats().changes).toBe(5);
      expect(replica.changesSince(0)).toHaveLength(5);
    }
  });

  it("resets the journal and the floor to the loaded record", () => {
    const replica = createReplica({ journalCapacity: 2 });
    seed(replica, 3);
    expect(replica.changeFloor).toBe(1);
    expect(replica.stats().changes).toBe(2);

    const record: ReplicaRecord = {
      format: REPLICA_RECORD_FORMAT,
      position: 9,
      revision: 2,
      entities: [entity({ id: "e_9", type: "note" })],
    };
    // The record is older than the resident revision, so load moves the
    // revision forward rather than backwards.
    expect(replica.load(record)).toBe(4);

    // The loaded record is the new complete baseline: no retained changes and
    // a floor at its revision, so only a later cursor is served.
    expect(replica.changeFloor).toBe(4);
    expect(replica.stats()).toEqual({
      entities: 1,
      byType: { note: 1 },
      held: 1,
      heldByType: { note: 1 },
      revision: 4,
      position: 9,
      changes: 0,
      changeFloor: 4,
      pinned: 0,
    });
    expect(replica.changesSince(0)).toEqual([]);
    expect(replica.changesSince(4)).toEqual([]);
  });
  it("advances the revision when load replaces an equal-revision base", () => {
    const replica = createReplica();
    const record: ReplicaRecord = {
      format: REPLICA_RECORD_FORMAT,
      position: 4,
      revision: 2,
      entities: [entity({ id: "e_9", type: "note" })],
    };

    expect(replica.load(record)).toBe(2);
    expect(replica.load(record)).toBe(3);
    expect(replica.changeFloor).toBe(3);
  });
});

describe("replica: stats (#499)", () => {
  it("counts an optimistic row the composed view exposes", () => {
    const replica = createReplica();
    replica.optimistic(
      put({
        actionId: "a_1",
        updateId: "u_1",
        ms: 10,
        fields: { title: leaf("Local", "u_1", 10) },
      }),
    );

    expect(replica.stats()).toMatchObject({
      entities: 1,
      byType: { todo: 1 },
      revision: 1,
    });
  });

  it("reports materialized counts by type, the revision, and the durable position", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({ actionId: "a_1", updateId: "u_1", ms: 10, fields: { title: leaf("Todo", "u_1", 10) } }),
      3,
    );
    ingest(
      replica,
      put({
        actionId: "a_2",
        updateId: "u_2",
        entityId: "e_2",
        type: "note",
        gsn: 2,
        ms: 20,
        fields: { title: leaf("Note", "u_2", 20) },
      }),
      5,
    );
    ingest(replica, remove({ actionId: "a_3", updateId: "u_3", gsn: 3, ms: 30 }), 7);

    // A tombstone is still a materialized row, so both counts include it.
    expect(replica.stats()).toEqual({
      entities: 2,
      byType: { todo: 1, note: 1 },
      held: 2,
      heldByType: { todo: 1, note: 1 },
      revision: 3,
      position: 7,
      changes: 3,
      changeFloor: 0,
      pinned: 0,
    });
  });
});

describe("replica: on-demand residency (#500)", () => {
  // `document` is the heavy body; everything else stays held, as with the
  // page metadata / content split at 10k documents.
  const onDemand = { holds: (type: string): boolean => type !== "document" };

  const documentRow = (id: string, text = `body ${id}`): Entity =>
    entity({
      id,
      type: "document",
      data: { fields: { text: leaf(text, `u_${id}`, 5) } },
      last_gsn: 5,
    });

  const reader =
    (rows: Record<string, Entity>, reads: string[] = []) =>
    async (id: string): Promise<Entity | null> => {
      reads.push(id);
      return rows[id] ?? null;
    };

  it("reports which types it holds and which it materializes on demand", () => {
    const replica = createReplica({ materialization: onDemand });

    expect(replica.isHeld("todo")).toBe(true);
    expect(replica.isHeld("document")).toBe(false);
    expect(createReplica().isHeld("document")).toBe(true);
  });

  it("opens a cold on-demand row, pinning and journaling it", async () => {
    const rows = { doc_1: documentRow("doc_1") };
    const reads: string[] = [];
    const replica = createReplica({ materialization: onDemand, readEntity: reader(rows, reads) });
    let fired = 0;
    replica.subscribe(() => {
      fired += 1;
    });

    const opened = await replica.open("doc_1");

    expect(opened).toEqual(documentRow("doc_1"));
    expect(reads).toEqual(["doc_1"]);
    expect(replica.get("doc_1")).toEqual(documentRow("doc_1"));
    expect(replica.iterate("document")).toEqual([documentRow("doc_1")]);
    expect(replica.isOpen("doc_1")).toBe(true);
    expect(replica.stats()).toMatchObject({ entities: 1, byType: { document: 1 }, pinned: 1 });
    expect(fired).toBe(1);
    // A derived reader must see the row arrive.
    expect(replica.changesSince(0)).toEqual([
      { revision: 1, id: "doc_1", type: "document", deleted: false },
    ]);
  });

  it("misses on a cold open that reads nothing, then installs on a later open", async () => {
    const rows: Record<string, Entity> = {};
    const reads: string[] = [];
    const replica = createReplica({ materialization: onDemand, readEntity: reader(rows, reads) });

    expect(await replica.open("doc_1")).toBeNull();
    expect(replica.isOpen("doc_1")).toBe(false);
    expect(replica.get("doc_1")).toBeUndefined();
    expect(replica.revision).toBe(0);

    rows.doc_1 = documentRow("doc_1");
    expect(await replica.open("doc_1")).toEqual(documentRow("doc_1"));
    expect(replica.isOpen("doc_1")).toBe(true);
    expect(reads).toEqual(["doc_1", "doc_1"]);
  });

  it("coalesces concurrent opens and re-opens without another read", async () => {
    const rows = { doc_1: documentRow("doc_1") };
    const reads: string[] = [];
    const replica = createReplica({ materialization: onDemand, readEntity: reader(rows, reads) });

    const [first, second] = await Promise.all([replica.open("doc_1"), replica.open("doc_1")]);
    expect(first).toEqual(documentRow("doc_1"));
    expect(second).toEqual(first);
    expect(reads).toEqual(["doc_1"]);

    const revision = replica.revision;
    expect(await replica.open("doc_1")).toEqual(documentRow("doc_1"));
    expect(reads).toEqual(["doc_1"]);
    expect(replica.revision).toBe(revision);
  });

  it("replays updates that land while a cold open is reading", async () => {
    let release!: (row: Entity) => void;
    const replica = createReplica({
      materialization: onDemand,
      pinnedTtlMs: 0,
      readEntity: () =>
        new Promise<Entity>((resolve) => {
          release = resolve;
        }),
    });

    const opening = replica.open("doc_1");
    ingest(
      replica,
      patch({
        actionId: "a_live",
        updateId: "u_live",
        entityId: "doc_1",
        type: "document",
        gsn: 6,
        ms: 6,
        fields: { text: leaf("live", "u_live", 6) },
      }),
      6,
    );
    release(documentRow("doc_1"));

    expect(await opening).toEqual(
      entity({
        id: "doc_1",
        type: "document",
        data: { fields: { text: leaf("live", "u_live", 6) } },
        updated_hlc: makeHlc(6),
        last_gsn: 6,
      }),
    );
    expect(replica.get("doc_1")?.data.fields.text).toEqual(leaf("live", "u_live", 6));
  });

  it("does not resurrect a row whose open was closed while the read was in flight", async () => {
    let release!: (row: Entity) => void;
    const replica = createReplica({
      materialization: onDemand,
      pinnedTtlMs: 0,
      readEntity: () =>
        new Promise<Entity>((resolve) => {
          release = resolve;
        }),
    });

    const opening = replica.open("doc_1");
    replica.close("doc_1");
    release(documentRow("doc_1"));

    expect(await opening).toBeNull();
    expect(replica.get("doc_1")).toBeUndefined();
    expect(replica.isOpen("doc_1")).toBe(false);
    expect(replica.stats().pinned).toBe(0);
  });

  it("serves a held row from the reader without installing or pinning it", async () => {
    const rows = { e_1: entity({ id: "e_1", type: "todo" }) };
    const replica = createReplica({ materialization: onDemand, readEntity: reader(rows) });

    expect(await replica.open("e_1")).toEqual(entity({ id: "e_1", type: "todo" }));
    expect(replica.get("e_1")).toBeUndefined();
    expect(replica.isOpen("e_1")).toBe(false);
    expect(replica.revision).toBe(0);
  });

  it("drops the pin when a fold moves the row into a held type", async () => {
    const rows = { doc_1: documentRow("doc_1") };
    const replica = createReplica({ materialization: onDemand, readEntity: reader(rows) });
    await replica.open("doc_1");

    ingest(
      replica,
      put({
        actionId: "a_move",
        updateId: "u_move",
        entityId: "doc_1",
        type: "todo",
        gsn: 9,
        ms: 9,
        fields: { title: leaf("Now held", "u_move", 9) },
      }),
      9,
    );

    expect(replica.get("doc_1")?.type).toBe("todo");
    expect(replica.isOpen("doc_1")).toBe(false);
    expect(replica.stats().pinned).toBe(0);

    replica.close("doc_1");
    expect(replica.get("doc_1")?.type).toBe("todo");
  });

  it("keeps folding live updates into a pinned row", async () => {
    const rows = { doc_1: documentRow("doc_1") };
    const replica = createReplica({ materialization: onDemand, readEntity: reader(rows) });
    await replica.open("doc_1");

    ingest(
      replica,
      patch({
        actionId: "a_live",
        updateId: "u_live",
        entityId: "doc_1",
        type: "document",
        gsn: 6,
        ms: 6,
        fields: { text: leaf("live", "u_live", 6) },
      }),
      6,
    );

    expect(replica.get("doc_1")?.data.fields.text).toEqual(leaf("live", "u_live", 6));
    expect(replica.isOpen("doc_1")).toBe(true);
  });

  it("drops a patch for an unopened on-demand row instead of retaining an orphan", () => {
    const replica = createReplica({ materialization: onDemand, pinnedTtlMs: 0 });

    ingest(
      replica,
      patch({
        actionId: "a_cold",
        updateId: "u_cold",
        entityId: "doc_1",
        type: "document",
        gsn: 7,
        ms: 7,
        fields: { text: leaf("cold", "u_cold", 7) },
      }),
      7,
    );

    expect(replica.get("doc_1")).toBeUndefined();
    expect(replica.changesSince(0)).toEqual([]);
    // An orphan would hold the record's watermark back to position 6 and
    // retain the body in memory.
    expect(replica.toRecord().position).toBe(7);
    expect(replica.toRecord().entities).toEqual([]);
  });

  it("keeps 10k held metadata rows and materializes only an opened body", async () => {
    // The #500 shape at 10k documents: page metadata is held, bodies are not.
    const entities: Entity[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      entities.push(entity({ id: `page_${i}`, type: "page" }));
      entities.push(documentRow(`doc_${i}`));
    }
    const rows = { doc_0: documentRow("doc_0") };
    const replica = createReplica({
      materialization: onDemand,
      pinnedTtlMs: 0,
      readEntity: reader(rows),
    });

    replica.load({ format: REPLICA_RECORD_FORMAT, position: 0, revision: 1, entities });

    expect(replica.stats()).toMatchObject({
      held: 10_000,
      heldByType: { page: 10_000 },
      byType: { page: 10_000 },
      pinned: 0,
    });
    expect(replica.stats().byType.document).toBeUndefined();

    await replica.open("doc_0");

    expect(replica.stats()).toMatchObject({
      held: 10_000,
      byType: { page: 10_000, document: 1 },
      pinned: 1,
    });
  });

  it("closes an open row, releasing it with the TTL disabled, and leaves held rows alone", async () => {
    const rows = { doc_1: documentRow("doc_1") };
    const replica = createReplica({
      materialization: onDemand,
      pinnedTtlMs: 0,
      readEntity: reader(rows),
    });
    ingest(
      replica,
      put({ actionId: "a_1", updateId: "u_1", ms: 10, fields: { title: leaf("Todo", "u_1", 10) } }),
      1,
    );
    await replica.open("doc_1");
    const openRevision = replica.revision;

    replica.close("doc_1");

    expect(replica.get("doc_1")).toBeUndefined();
    expect(replica.isOpen("doc_1")).toBe(false);
    expect(replica.stats().pinned).toBe(0);
    expect(replica.changesSince(openRevision)).toEqual([
      { revision: openRevision + 1, id: "doc_1", type: "document", deleted: true },
    ]);

    replica.close("e_1");
    expect(replica.get("e_1")?.type).toBe("todo");
  });

  it("evicts a row and drops its pin", async () => {
    const rows = { doc_1: documentRow("doc_1") };
    const replica = createReplica({ materialization: onDemand, readEntity: reader(rows) });
    await replica.open("doc_1");

    replica.evict(["doc_1"]);

    expect(replica.isOpen("doc_1")).toBe(false);
    expect(replica.stats().pinned).toBe(0);
  });

  it("releases the least recently opened row when the pinned window overflows", async () => {
    const rows = {
      doc_1: documentRow("doc_1"),
      doc_2: documentRow("doc_2"),
      doc_3: documentRow("doc_3"),
    };
    const replica = createReplica({
      materialization: onDemand,
      pinnedCapacity: 2,
      pinnedTtlMs: 0,
      readEntity: reader(rows),
    });
    await replica.open("doc_1");
    await replica.open("doc_2");
    await replica.open("doc_1");
    await replica.open("doc_3");

    expect(replica.isOpen("doc_2")).toBe(false);
    expect(replica.get("doc_2")).toBeUndefined();
    expect(replica.isOpen("doc_1")).toBe(true);
    expect(replica.isOpen("doc_3")).toBe(true);
    expect(replica.stats().pinned).toBe(2);
  });

  it("retains every pinned row when the capacity is unbounded", async () => {
    const rows: Record<string, Entity> = {};
    for (let i = 1; i <= 20; i += 1) rows[`doc_${i}`] = documentRow(`doc_${i}`);
    const replica = createReplica({
      materialization: onDemand,
      pinnedCapacity: 0,
      pinnedTtlMs: 0,
      readEntity: reader(rows),
    });

    for (const id of Object.keys(rows)) await replica.open(id);

    expect(replica.stats().pinned).toBe(20);
    expect(replica.stats().byType).toEqual({ document: 20 });
  });

  it("persists held rows only, never a pinned body", async () => {
    const rows = { doc_1: documentRow("doc_1") };
    const replica = createReplica({
      materialization: onDemand,
      pinnedTtlMs: 0,
      readEntity: reader(rows),
    });
    ingest(
      replica,
      put({ actionId: "a_1", updateId: "u_1", ms: 10, fields: { title: leaf("Todo", "u_1", 10) } }),
      1,
    );
    await replica.open("doc_1");

    expect(replica.toRecord().entities).toEqual([
      entity({
        id: "e_1",
        type: "todo",
        data: { fields: { title: leaf("Todo", "u_1", 10) } },
        created_hlc: makeHlc(10),
        updated_hlc: makeHlc(10),
        last_gsn: 1,
      }),
    ]);
  });

  it("clears pins on load and installs held rows only", async () => {
    const rows = { doc_1: documentRow("doc_1") };
    const replica = createReplica({
      materialization: onDemand,
      pinnedTtlMs: 0,
      readEntity: reader(rows),
    });
    await replica.open("doc_1");

    replica.load({
      format: REPLICA_RECORD_FORMAT,
      position: 0,
      revision: 5,
      entities: [documentRow("doc_2"), entity({ id: "e_1", type: "todo" })],
    });

    expect(replica.isOpen("doc_1")).toBe(false);
    expect(replica.get("doc_1")).toBeUndefined();
    expect(replica.get("doc_2")).toBeUndefined();
    expect(replica.get("e_1")?.type).toBe("todo");
    expect(replica.stats()).toMatchObject({ entities: 1, byType: { todo: 1 }, pinned: 0 });
  });

  describe("pinned TTL", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("releases a closed row once the TTL elapses", async () => {
      const rows = { doc_1: documentRow("doc_1") };
      const replica = createReplica({
        materialization: onDemand,
        pinnedTtlMs: 1_000,
        readEntity: reader(rows),
      });
      await replica.open("doc_1");
      replica.close("doc_1");

      await vi.advanceTimersByTimeAsync(999);
      expect(replica.isOpen("doc_1")).toBe(false);
      expect(replica.get("doc_1")).toEqual(documentRow("doc_1"));

      await vi.advanceTimersByTimeAsync(1);
      expect(replica.get("doc_1")).toBeUndefined();
      expect(replica.stats().pinned).toBe(0);
    });

    it("cancels the TTL when a closed row is opened again", async () => {
      const rows = { doc_1: documentRow("doc_1") };
      const replica = createReplica({
        materialization: onDemand,
        pinnedTtlMs: 1_000,
        readEntity: reader(rows),
      });
      await replica.open("doc_1");
      replica.close("doc_1");

      await vi.advanceTimersByTimeAsync(600);
      await replica.open("doc_1");
      await vi.advanceTimersByTimeAsync(600);
      expect(replica.isOpen("doc_1")).toBe(true);
      expect(replica.get("doc_1")).toEqual(documentRow("doc_1"));
    });

    it("keeps an open row indefinitely and releases it on close when the TTL is disabled", async () => {
      const rows = { doc_1: documentRow("doc_1") };
      const replica = createReplica({
        materialization: onDemand,
        pinnedTtlMs: 0,
        readEntity: reader(rows),
      });
      await replica.open("doc_1");

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(replica.isOpen("doc_1")).toBe(true);

      replica.close("doc_1");
      expect(replica.get("doc_1")).toBeUndefined();
    });

    it("cancels a pending TTL release when the row is evicted", async () => {
      const rows = { doc_1: documentRow("doc_1") };
      const replica = createReplica({
        materialization: onDemand,
        pinnedTtlMs: 1_000,
        readEntity: reader(rows),
      });
      await replica.open("doc_1");
      replica.close("doc_1");
      replica.evict(["doc_1"]);
      const revision = replica.revision;

      await vi.advanceTimersByTimeAsync(5_000);

      expect(replica.stats().pinned).toBe(0);
      expect(replica.revision).toBe(revision);
    });
  });
});
