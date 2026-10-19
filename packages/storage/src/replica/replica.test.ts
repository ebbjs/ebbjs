import { describe, expect, it } from "vitest";
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
