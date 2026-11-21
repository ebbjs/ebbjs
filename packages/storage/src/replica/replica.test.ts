import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  componentName,
  ebbComponent,
  isFieldMap,
  makeHlc,
  type Action,
  type ComponentName,
  type Entity,
  type FieldValue,
  type Update,
} from "@ebbjs/core";

import { REPLICA_RECORD_FORMAT } from "../internal/replica-record";
import type { ReplicaRecord } from "../types/replica-store";
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
  readonly model?: string;
  readonly gsn?: number;
  readonly ms?: number;
  readonly fields: Record<string, FieldValue>;
  /** The component a keyed (map) field is written under; `ebb/link` for edges. */
  readonly keyedComponent?: ComponentName;
}

/** One component Update per fixture field; a keyed component always merges. */
const componentUpdates = (spec: WriteSpec, method: "merge" | "replace"): Update[] =>
  Object.entries(spec.fields).map(([field, value]) => {
    const keyed = isFieldMap(value);
    return {
      id: `${spec.updateId}_${field}`,
      subject_id: spec.entityId ?? "e_1",
      component: keyed
        ? (spec.keyedComponent ?? componentName(spec.model ?? "todo", field))
        : componentName(spec.model ?? "todo", field),
      method: keyed ? "merge" : method,
      data: value,
    };
  });

/** A row put: the row's create, then one `replace` (or keyed `merge`) per field. */
const put = (spec: WriteSpec): Action => {
  const hlc = makeHlc(spec.ms ?? 1);
  return {
    id: spec.actionId,
    actor_id: "user_1",
    hlc,
    gsn: spec.gsn ?? 1,
    updates: [
      {
        id: `${spec.updateId}_create`,
        subject_id: spec.entityId ?? "e_1",
        model: spec.model ?? "todo",
        method: "create",
        hlc,
        data: null,
      },
      ...componentUpdates(spec, "replace"),
    ],
  };
};

/** The row create: the row's model and creation time, and no component. */
const create = (spec: Omit<WriteSpec, "fields">): Action => {
  const hlc = makeHlc(spec.ms ?? 1);
  return {
    id: spec.actionId,
    actor_id: "user_1",
    hlc,
    gsn: spec.gsn ?? 1,
    updates: [
      {
        id: spec.updateId,
        subject_id: spec.entityId ?? "e_1",
        model: spec.model ?? "todo",
        method: "create",
        hlc,
        data: null,
      },
    ],
  };
};

const patch = (spec: WriteSpec): Action => ({
  id: spec.actionId,
  actor_id: "user_1",
  hlc: makeHlc(spec.ms ?? 1),
  gsn: spec.gsn ?? 1,
  updates: componentUpdates(spec, "merge"),
});

const remove = (spec: Omit<WriteSpec, "fields">): Action => ({
  id: spec.actionId,
  actor_id: "user_1",
  hlc: makeHlc(spec.ms ?? 1),
  gsn: spec.gsn ?? 1,
  updates: [
    {
      id: spec.updateId,
      subject_id: spec.entityId ?? "e_1",
      method: "delete",
      data: null,
    },
  ],
});

/** One `drop` per fixture field. A drop for a row with no base is an orphan. */
const drop = (spec: WriteSpec): Action => ({
  id: spec.actionId,
  actor_id: "user_1",
  hlc: makeHlc(spec.ms ?? 1),
  gsn: spec.gsn ?? 1,
  updates: Object.keys(spec.fields).map((field) => ({
    id: `${spec.updateId}_${field}`,
    subject_id: spec.entityId ?? "e_1",
    component: componentName(spec.model ?? "todo", field),
    method: "drop" as const,
    data: null,
  })),
});

/** A `page` row carrying one live edge: `sourceId` —author/wrote→ `targetId`. */
const relationship = (
  actionId: string,
  sourceId: string,
  targetId: string,
  gsn: number,
  ms: number,
): Action =>
  put({
    actionId,
    updateId: `u_${sourceId}`,
    entityId: sourceId,
    model: "page",
    gsn,
    ms,
    fields: {
      link: {
        map: {
          author: {
            map: {
              wrote: { map: { [targetId]: leaf(true, `u_${sourceId}`, ms) } },
            },
          },
        },
      },
    },
    keyedComponent: ebbComponent("link"),
  });

/** A materialized `ebb/membership` row putting `entityId` in `groupId`. */
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
    model: "ebb",
    gsn,
    ms,
    fields: {
      membership: leaf({ entity_id: entityId, group_id: groupId }, `u_${rowId}`, ms),
    },
  });

const ingest = (replica: Replica, write: Action, position: number): number =>
  replica.ingest(write, write.updates, position);

const entity = (overrides: Partial<Entity> = {}): Entity => ({
  id: "e_1",
  model: "todo",
  data: { fields: {} },
  exists: true,
  created_hlc: makeHlc(1),
  updated_hlc: makeHlc(1),
  deleted_hlc: null,
  last_gsn: 1,
  ...overrides,
});

describe("replica: durable fold", () => {
  it("materializes a put into the base and the model index", () => {
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
    expect(row?.model).toBe("todo");
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

  it("resurrects a tombstone on a component write", () => {
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
    ).toBe(3);
    expect(replica.get("e_1")?.data.fields.title).toEqual(leaf("Zombie", "u_3", 40));
    expect(replica.get("e_1")?.deleted_hlc).toBeNull();
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
    // The put brings the row into the set; the losing patch is a content change
    // on the leaf it rewrites.
    expect(replica.changesSince(0)).toEqual([
      {
        revision: 1,
        id: "e_1",
        kind: "membership",
        deleted: false,
        membership: "entered",
        models: ["todo"],
      },
      { revision: 2, id: "e_1", kind: "content", deleted: false, components: ["todo/title"] },
    ]);
    expect(replica.changesSince(1)).toEqual([
      { revision: 2, id: "e_1", kind: "content", deleted: false, components: ["todo/title"] },
    ]);
    expect(replica.changesSince(2)).toEqual([]);
  });

  it("journals the touched component and not its siblings", () => {
    const replica = createReplica();
    const status = leaf("open", "u_status", 10);
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_title",
        model: "note",
        ms: 10,
        fields: { title: leaf("First", "u_title", 10), status },
      }),
      1,
    );
    expect(replica.changesSince(0)).toEqual([
      {
        revision: 1,
        id: "e_1",
        kind: "membership",
        deleted: false,
        membership: "entered",
        models: ["note"],
      },
    ]);

    ingest(
      replica,
      patch({
        actionId: "a_2",
        updateId: "u_2",
        model: "note",
        gsn: 2,
        ms: 20,
        fields: { title: leaf("Second", "u_2", 20) },
      }),
      2,
    );

    // The plan component's leaf is untouched, so only the title changes.
    expect(replica.changesSince(1)).toEqual([
      { revision: 2, id: "e_1", kind: "content", deleted: false, components: ["note/title"] },
    ]);
  });

  it("journals the component a drop detached", () => {
    const replica = createReplica();
    const title = leaf("Kept", "u_1", 10);
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        ms: 10,
        fields: { title, draft: leaf("d", "u_draft", 10) },
      }),
      1,
    );
    ingest(
      replica,
      drop({
        actionId: "a_2",
        updateId: "u_2",
        gsn: 2,
        ms: 20,
        fields: { draft: leaf("", "u_2", 20) },
      }),
      2,
    );

    expect(replica.get("e_1")?.data.fields.title).toBe(title);
    expect(replica.changesSince(1)).toEqual([
      { revision: 2, id: "e_1", kind: "content", deleted: false, components: ["todo/draft"] },
    ]);
  });

  it("journals a delete as the row leaving the set it was read from", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        ms: 10,
        fields: { title: leaf("Hello", "u_1", 10), status: leaf("open", "u_status", 10) },
      }),
      1,
    );
    ingest(replica, remove({ actionId: "a_2", updateId: "u_2", gsn: 2, ms: 20 }), 2);

    expect(replica.changesSince(1)).toEqual([
      {
        revision: 2,
        id: "e_1",
        kind: "membership",
        deleted: true,
        membership: "left",
        models: ["todo"],
      },
    ]);
  });

  it("serves iterate an id whose model only the overlay knows", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        entityId: "note_1",
        model: "note",
        ms: 10,
        fields: { title: leaf("Note", "u_1", 10) },
      }),
      1,
    );
    ingest(
      replica,
      put({
        actionId: "a_2",
        updateId: "u_2",
        entityId: "note_2",
        model: "note",
        ms: 10,
        fields: { title: leaf("Other", "u_2", 10) },
      }),
      2,
    );
    expect(replica.iterate("note").map((row) => row.id)).toEqual(["note_1", "note_2"]);

    // An optimistic create lands a row the base has never seen, so the base's
    // model index cannot answer for it: `iterate` must serve the overlay's row.
    replica.optimistic(
      create({
        actionId: "a_local",
        updateId: "u_local",
        entityId: "note_3",
        model: "note",
        ms: 20,
      }),
    );
    expect(replica.iterate("note").map((row) => row.id)).toEqual(["note_1", "note_2", "note_3"]);
    expect(replica.iterate("todo")).toEqual([]);
    expect(replica.get("note_3")?.model).toBe("note");

    replica.discard("a_local");
    expect(replica.iterate("note").map((row) => row.id)).toEqual(["note_1", "note_2"]);
    expect(replica.get("note_3")).toBeUndefined();
  });

  it("does not move an id out of the model its create named", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({ actionId: "a_1", updateId: "u_1", ms: 10, fields: { title: leaf("Todo", "u_1", 10) } }),
      1,
    );
    // The wire refuses a component prefix that disagrees with the row's created
    // model. A replica that meets one anyway must not relabel the row, and must
    // not let the id answer under a second model.
    ingest(
      replica,
      patch({
        actionId: "a_2",
        updateId: "u_2",
        gsn: 2,
        model: "note",
        ms: 20,
        fields: { title: leaf("Note", "u_2", 20) },
      }),
      2,
    );
    expect(replica.get("e_1")?.model).toBe("todo");
    expect(replica.iterate("todo").map((row) => row.id)).toEqual(["e_1"]);
    expect(replica.iterate("note")).toEqual([]);
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

  it("creates the row from an optimistic write with no base", () => {
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
    ).toBe(1);
    expect(replica.get("e_1")?.data.fields.title).toEqual(leaf("Ghost", "u_1", 20));
    expect(replica.iterate("todo").map((row) => row.id)).toEqual(["e_1"]);
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
  it("creates the row from a component write that arrives before its base", () => {
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
    expect(replica.get("e_1")?.data.fields.title).toEqual(leaf("Patched", "u_patch", 50));
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
    // The newer leaf keeps the position: a late backfill is the leaf-level
    // LWW compare, not a clobber.
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
      drop({
        actionId: "a_drop",
        updateId: "u_drop",
        entityId: "e_orphan",
        gsn: 5,
        ms: 50,
        fields: { title: leaf("Dropped", "u_drop", 50) },
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
    expect(holdAll.holds("todo/title")).toBe(true);
    expect(holdAll.holds("anything/leaf")).toBe(true);
  });

  it("neither retains nor journals a not-held component", () => {
    const replica = createReplica({
      materialization: { holds: (component) => !component.startsWith("cold/") },
    });
    // A component write with no base is a placeholder whose value the policy
    // does not hold, so the replica keeps neither the value nor the row.
    ingest(
      replica,
      patch({
        actionId: "a_1",
        updateId: "u_1",
        entityId: "e_cold",
        model: "cold",
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

  it("keeps a create's row even when no component of it is held", () => {
    const replica = createReplica({
      materialization: { holds: () => false },
    });
    // The row's existence is not a component value, so there is nothing for the
    // policy to drop: a zero-component row is the whole row.
    ingest(
      replica,
      create({ actionId: "a_create", updateId: "u_create", entityId: "e_cold", model: "cold" }),
      1,
    );

    expect(replica.get("e_cold")).toMatchObject({
      id: "e_cold",
      model: "cold",
      data: { fields: {} },
      exists: true,
    });
  });

  it("journals a row that loses its last held component exactly once", () => {
    const replica = createReplica({
      materialization: { holds: (component) => component !== "cold/body" },
    });
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        entityId: "e_cold",
        model: "cold",
        ms: 10,
        fields: { keep: leaf("Kept", "u_keep", 10), body: leaf("Body", "u_body", 10) },
      }),
      1,
    );
    expect(replica.revision).toBe(1);
    // The lazy body's value is not retained; its existence is.
    expect(replica.components("cold/body")).toEqual(["e_cold"]);

    // With the held component detached the lazy one is all the row carries, so
    // it retains nothing and leaves the replica: one removal, and the removal
    // is the row leaving its model's set rather than a value that changed.
    ingest(
      replica,
      drop({
        actionId: "a_2",
        updateId: "u_2",
        entityId: "e_cold",
        model: "cold",
        gsn: 2,
        ms: 20,
        fields: { keep: leaf(null, "u_keep", 20) },
      }),
      2,
    );

    expect(replica.get("e_cold")).toBeUndefined();
    expect(replica.iterate("cold")).toEqual([]);
    expect(replica.components("cold/body")).toEqual([]);
    expect(replica.revision).toBe(2);
    expect(replica.changesSince(1)).toEqual([
      {
        revision: 2,
        id: "e_cold",
        kind: "membership",
        deleted: false,
        membership: "left",
        models: ["cold"],
      },
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
      componentVersions: {},
      position: 0,
      revision: 7,
      entities: [entity({ id: "e_9", model: "note" })],
    });

    expect(fired).toBe(1);
    expect(replica.revision).toBe(7);
    expect(replica.get("e_9")?.model).toBe("note");
  });
});

describe("replica: evict (#499)", () => {
  it("drops rows and their adjacency, journaling each removal and ignoring absent ids", () => {
    const replica = createReplica();
    ingest(replica, relationship("a_r", "src_1", "tgt_1", 1, 1), 1);
    ingest(replica, membership("a_m", "m_1", "grp_1", "e_1", 2, 2), 2);
    let fired = 0;
    replica.subscribe(() => {
      fired += 1;
    });

    expect(replica.evict(["src_1", "m_1", "missing", "src_1"])).toBe(4);

    expect(replica.get("src_1")).toBeUndefined();
    expect(replica.get("m_1")).toBeUndefined();
    expect(replica.iterate("page")).toEqual([]);
    expect(replica.iterate("ebb")).toEqual([]);
    expect(replica.relationships({ as: "author", type: "wrote", sourceId: "src_1" })).toEqual([]);
    expect(replica.relationships({ as: "author", type: "wrote", targetId: "tgt_1" })).toEqual([]);
    expect(replica.memberships({ groupId: "grp_1" })).toEqual([]);
    expect(replica.memberships({ entityId: "e_1" })).toEqual([]);
    expect(replica.membershipLinks("e_1")).toEqual([]);
    expect(fired).toBe(1);
    expect(replica.changesSince(2)).toEqual([
      {
        revision: 3,
        id: "src_1",
        kind: "membership",
        deleted: false,
        membership: "left",
        models: ["page"],
      },
      {
        revision: 4,
        id: "m_1",
        kind: "membership",
        deleted: false,
        membership: "left",
        models: ["ebb"],
      },
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
      {
        revision: 4,
        id: "e_4",
        kind: "membership",
        deleted: false,
        membership: "entered",
        models: ["todo"],
      },
      {
        revision: 5,
        id: "e_5",
        kind: "membership",
        deleted: false,
        membership: "entered",
        models: ["todo"],
      },
      {
        revision: 6,
        id: "e_6",
        kind: "membership",
        deleted: false,
        membership: "entered",
        models: ["todo"],
      },
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
      componentVersions: {},
      position: 9,
      revision: 2,
      entities: [entity({ id: "e_9", model: "note" })],
    };
    // The record is older than the resident revision, so load moves the
    // revision forward rather than backwards.
    expect(replica.load(record)).toBe(4);

    // The loaded record is the new complete baseline: no retained changes and
    // a floor at its revision, so only a later cursor is served.
    expect(replica.changeFloor).toBe(4);
    expect(replica.stats()).toEqual({
      entities: 1,
      byModel: { note: 1 },
      held: 1,
      heldByModel: { note: 1 },
      revision: 4,
      position: 9,
      changes: 0,
      changeFloor: 4,
      readsInFlight: 0,
      leases: {
        leased: 0,
        inactive: 0,
        resident: 0,
        timers: 0,
        oldestInactiveMs: 0,
        byComponent: {},
      },
      components: 0,
      residentComponents: 0,
      heldComponents: {},
      nonResidentComponents: {},
      nonResident: 0,
    });
    expect(replica.changesSince(0)).toEqual([]);
    expect(replica.changesSince(4)).toEqual([]);
  });
  it("advances the revision when load replaces an equal-revision base", () => {
    const replica = createReplica();
    const record: ReplicaRecord = {
      format: REPLICA_RECORD_FORMAT,
      componentVersions: {},
      position: 4,
      revision: 2,
      entities: [entity({ id: "e_9", model: "note" })],
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
      byModel: { todo: 1 },
      revision: 1,
    });
  });

  it("reports materialized counts by model, the revision, and the durable position", () => {
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
        model: "note",
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
      byModel: { todo: 1, note: 1 },
      held: 2,
      heldByModel: { todo: 1, note: 1 },
      revision: 3,
      position: 7,
      changes: 3,
      changeFloor: 0,
      readsInFlight: 0,
      leases: {
        leased: 0,
        inactive: 0,
        resident: 0,
        timers: 0,
        oldestInactiveMs: 0,
        byComponent: {},
      },
      components: 2,
      residentComponents: 2,
      heldComponents: { "note/title": 1, "todo/title": 1 },
      nonResidentComponents: {},
      nonResident: 0,
    });
  });
});

describe("replica: on-demand residency (#500)", () => {
  // `document` is the heavy body; everything else stays held, as with the
  // page metadata / content split at 10k documents.
  const onDemand = {
    holds: (component: string): boolean => !component.startsWith("document/"),
  };

  const documentRow = (id: string, text = `body ${id}`): Entity =>
    entity({
      id,
      model: "document",
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

    expect(replica.isHeld("todo/title")).toBe(true);
    expect(replica.isHeld("document/text")).toBe(false);
    expect(createReplica().isHeld("document/text")).toBe(true);
  });

  it("reads a cold component through the store as residency, never as content", async () => {
    const rows = { doc_1: documentRow("doc_1") };
    const reads: string[] = [];
    const replica = createReplica({
      materialization: onDemand,
      readComponent: reader(rows, reads),
    });
    let fired = 0;
    replica.subscribe(() => {
      fired += 1;
    });

    const row = await replica.read("doc_1", ["document/text"]);

    expect(row).toEqual(documentRow("doc_1"));
    expect(reads).toEqual(["doc_1"]);
    expect(replica.get("doc_1")).toEqual(documentRow("doc_1"));
    expect(replica.iterate("document")).toEqual([documentRow("doc_1")]);
    // A read installs a value; it is not a content change, so nothing journals
    // and the revision a derived reader tracks does not move.
    expect(replica.revision).toBe(0);
    expect(replica.changesSince(0)).toEqual([]);
    // The read released its claim before returning, so the value waits out one
    // grace period rather than vanishing from under the projection.
    expect(replica.stats().leases).toMatchObject({
      leased: 0,
      inactive: 1,
      resident: 1,
      timers: 1,
      byComponent: { "document/text": { leased: 0, inactive: 1 } },
    });
    expect(fired).toBe(1);
  });

  it("misses on a cold read that reads nothing, then installs on a later read", async () => {
    const rows: Record<string, Entity> = {};
    const reads: string[] = [];
    const replica = createReplica({
      materialization: onDemand,
      readComponent: reader(rows, reads),
    });

    expect(await replica.read("doc_1", ["document/text"])).toBeNull();
    expect(replica.get("doc_1")).toBeUndefined();
    expect(replica.revision).toBe(0);
    expect(replica.stats().leases).toEqual({
      leased: 0,
      inactive: 0,
      resident: 0,
      timers: 0,
      oldestInactiveMs: 0,
      byComponent: {},
    });

    rows.doc_1 = documentRow("doc_1");
    expect(await replica.read("doc_1", ["document/text"])).toEqual(documentRow("doc_1"));
    expect(reads).toEqual(["doc_1", "doc_1"]);
  });

  it("coalesces concurrent reads and shares the warm value without another read", async () => {
    const rows = { doc_1: documentRow("doc_1") };
    const reads: string[] = [];
    const replica = createReplica({
      materialization: onDemand,
      readComponent: reader(rows, reads),
    });

    const [first, second] = await Promise.all([
      replica.read("doc_1", ["document/text"]),
      replica.read("doc_1", ["document/text"]),
    ]);
    expect(first).toEqual(documentRow("doc_1"));
    expect(second).toEqual(first);
    expect(reads).toEqual(["doc_1"]);

    const revision = replica.revision;
    expect(await replica.read("doc_1", ["document/text"])).toEqual(documentRow("doc_1"));
    expect(reads).toEqual(["doc_1"]);
    expect(replica.revision).toBe(revision);
  });

  it("retries the store after a read rejects, and folds the writes that waited", async () => {
    // `note/title` is held, `note/body` is not: a wedged read must lose neither
    // the held write that lands behind it nor the next attempt at the body.
    const stored = entity({
      id: "note_1",
      model: "note",
      data: { fields: { title: leaf("One", "u_title", 10), body: leaf("body", "u_body", 10) } },
      created_hlc: makeHlc(10),
      updated_hlc: makeHlc(10),
      last_gsn: 10,
    });
    const reads: string[] = [];
    let down = true;
    const replica = createReplica({
      materialization: { holds: (component) => component === "note/title" },
      residencyTtlMs: 0,
      readComponent: async (id, component) => {
        reads.push(`${id}:${component}`);
        if (down) throw new Error("store down");
        return stored;
      },
    });

    await expect(replica.read("note_1", ["note/body"])).rejects.toThrow("store down");
    // A read that installed nothing leaves neither a claim nor bookkeeping.
    expect(replica.stats().leases).toMatchObject({
      leased: 0,
      inactive: 0,
      resident: 0,
    });
    expect(replica.stats().readsInFlight).toBe(0);

    ingest(
      replica,
      patch({
        actionId: "a_1",
        updateId: "u_1",
        entityId: "note_1",
        model: "note",
        gsn: 1,
        ms: 20,
        fields: { title: leaf("Renamed", "u_1", 20) },
      }),
      1,
    );

    // The row is not wedged: the held write landed, and the next read asks the
    // store again instead of replaying the stale rejection.
    expect(replica.get("note_1")?.data.fields.title).toEqual(leaf("Renamed", "u_1", 20));
    down = false;
    const loaded = await replica.read("note_1", ["note/body"]);

    expect(reads).toEqual(["note_1:note/body", "note_1:note/body"]);
    expect(loaded?.data.fields.body).toEqual(leaf("body", "u_body", 10));
    expect(loaded?.data.fields.title).toEqual(leaf("Renamed", "u_1", 20));
    expect(replica.stats().leases).toMatchObject({ leased: 0, inactive: 1, resident: 1 });
    expect(replica.stats().readsInFlight).toBe(0);
  });

  it("retries the store after a read throws synchronously", async () => {
    const stored = entity({
      id: "note_1",
      model: "note",
      data: { fields: { title: leaf("One", "u_title", 10), body: leaf("body", "u_body", 10) } },
      created_hlc: makeHlc(10),
      updated_hlc: makeHlc(10),
      last_gsn: 10,
    });
    const reads: string[] = [];
    let down = true;
    const replica = createReplica({
      materialization: { holds: (component) => component === "note/title" },
      residencyTtlMs: 0,
      readComponent: (id, component) => {
        reads.push(`${id}:${component}`);
        if (down) throw new Error("sync boom");
        return Promise.resolve(stored);
      },
    });

    await expect(replica.read("note_1", ["note/body"])).rejects.toThrow("sync boom");

    down = false;
    const loaded = await replica.read("note_1", ["note/body"]);

    expect(reads).toEqual(["note_1:note/body", "note_1:note/body"]);
    expect(loaded?.data.fields.body).toEqual(leaf("body", "u_body", 10));
    expect(replica.stats().leases).toMatchObject({ leased: 0, inactive: 1, resident: 1 });
    expect(replica.stats().readsInFlight).toBe(0);
  });

  it("shares one read failure with the readers waiting on it, then retries", async () => {
    const reads: string[] = [];
    let down = true;
    const replica = createReplica({
      materialization: onDemand,
      residencyTtlMs: 0,
      readComponent: async (id) => {
        reads.push(id);
        if (down) throw new Error("store down");
        return documentRow("doc_1");
      },
    });

    const [first, second] = await Promise.allSettled([
      replica.read("doc_1", ["document/text"]),
      replica.read("doc_1", ["document/text"]),
    ]);
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("rejected");
    // One store read served both callers.
    expect(reads).toEqual(["doc_1"]);
    expect(replica.stats().leases).toMatchObject({ leased: 0, resident: 0 });
    expect(replica.stats().readsInFlight).toBe(0);

    down = false;
    expect(await replica.read("doc_1", ["document/text"])).toEqual(documentRow("doc_1"));
    expect(reads).toEqual(["doc_1", "doc_1"]);
  });

  it("replays a write behind a read that installs nothing into the indices and the journal", async () => {
    // `ebb/link` is held, `page/body` is not. The read installs nothing, so the
    // write that arrived during it must reach the replica whole: the base, the
    // component index, the adjacency index, the journal, and the subscribers.
    let deliver!: (row: Entity | null) => void;
    const replica = createReplica({
      materialization: { holds: (component: string) => component !== "page/body" },
      residencyTtlMs: 0,
      readComponent: () =>
        new Promise<Entity | null>((resolve) => {
          deliver = resolve;
        }),
    });
    const seen: string[] = [];
    replica.subscribe(() => {
      seen.push(replica.components("ebb/link").join(","));
    });

    const reading = replica.read("page_1", ["page/body"]);
    ingest(replica, relationship("a_1", "page_1", "target_1", 1, 10), 1);
    deliver(null);
    await reading;

    expect(replica.components("ebb/link")).toEqual(["page_1"]);
    expect(replica.relationships({ as: "author", type: "wrote", targetId: "target_1" })).toEqual([
      "page_1",
    ]);
    // The install is residency and journals nothing, so what a reader sees is
    // the row arriving with the replayed edge: it entered its model, and the
    // notification a subscriber receives last carries the edge.
    expect(replica.changesSince(0)).toEqual([
      {
        revision: 1,
        id: "page_1",
        kind: "membership",
        deleted: false,
        membership: "entered",
        models: ["page"],
      },
    ]);
    expect(seen.at(-1)).toBe("page_1");
  });

  it("replays a write behind a rejected read into the indices and the journal", async () => {
    let deliver!: (error: Error) => void;
    const replica = createReplica({
      materialization: { holds: (component: string) => component !== "page/body" },
      residencyTtlMs: 0,
      readComponent: () =>
        new Promise<Entity | null>((_resolve, reject) => {
          deliver = reject;
        }),
    });

    const reading = replica.read("page_1", ["page/body"]);
    ingest(replica, relationship("a_1", "page_1", "target_1", 1, 10), 1);
    deliver(new Error("store down"));
    await expect(reading).rejects.toThrow("store down");

    expect(replica.components("ebb/link")).toEqual(["page_1"]);
    expect(replica.relationships({ as: "author", type: "wrote", targetId: "target_1" })).toEqual([
      "page_1",
    ]);
    expect(replica.changesSince(0)).toEqual([
      {
        revision: 1,
        id: "page_1",
        kind: "membership",
        deleted: false,
        membership: "entered",
        models: ["page"],
      },
    ]);
  });

  it("republishes an overlaid row when a buffered write replays", async () => {
    let deliver!: (row: Entity | null) => void;
    const replica = createReplica({
      materialization: { holds: (component: string) => component !== "page/body" },
      residencyTtlMs: 0,
      readComponent: () =>
        new Promise<Entity | null>((resolve) => {
          deliver = resolve;
        }),
    });
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        entityId: "page_1",
        model: "page",
        gsn: 1,
        ms: 10,
        fields: { title: leaf("One", "u_1", 10) },
      }),
      1,
    );
    replica.optimistic({
      id: "a_opt",
      actor_id: "user_2",
      hlc: makeHlc(15),
      gsn: 0,
      updates: [
        {
          id: "u_opt",
          subject_id: "page_1",
          component: componentName("page", "title"),
          method: "merge",
          data: leaf("Local", "u_opt", 15),
        },
      ],
    });
    expect(replica.get("page_1")?.data.fields.title).toEqual(leaf("Local", "u_opt", 15));

    const reading = replica.read("page_1", ["page/body"]);
    ingest(
      replica,
      put({
        actionId: "a_2",
        updateId: "u_2",
        entityId: "page_1",
        model: "page",
        gsn: 2,
        ms: 30,
        fields: { title: leaf("Remote", "u_2", 30) },
      }),
      2,
    );
    deliver(null);
    await reading;

    // The remote write beats the local one, so the composed view must be
    // republished: `get` reads the base plus the overlay, and the two cannot
    // disagree about what the row now holds.
    expect(replica.base("page_1")?.data.fields.title).toEqual(leaf("Remote", "u_2", 30));
    expect(replica.get("page_1")?.data.fields.title).toEqual(leaf("Remote", "u_2", 30));
  });

  it("replays the writes a read leaves behind when the store row lacks the component", async () => {
    let deliver!: (row: Entity) => void;
    const replica = createReplica({
      materialization: { holds: (component: string) => component !== "page/body" },
      residencyTtlMs: 0,
      readComponent: () =>
        new Promise<Entity>((resolve) => {
          deliver = resolve;
        }),
    });

    const reading = replica.read("page_1", ["page/body"]);
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        entityId: "page_1",
        model: "page",
        gsn: 1,
        ms: 20,
        fields: { title: leaf("Remote", "u_1", 20) },
      }),
      1,
    );
    // A store row without the requested component refuses the install; the
    // write that waited behind it still lands.
    deliver(
      entity({
        id: "page_1",
        model: "page",
        data: { fields: { title: leaf("Store", "u_store", 5) } },
        last_gsn: 5,
      }),
    );

    expect((await reading)?.data.fields.title).toEqual(leaf("Remote", "u_1", 20));
    expect(replica.get("page_1")?.data.fields.title).toEqual(leaf("Remote", "u_1", 20));
    expect(replica.changesSince(0)).toEqual([
      {
        revision: 1,
        id: "page_1",
        kind: "membership",
        deleted: false,
        membership: "entered",
        models: ["page"],
      },
    ]);
  });

  it("keeps no per-read bookkeeping once the reads settle", async () => {
    const rows: Record<string, Entity> = {};
    for (let i = 1; i <= 50; i += 1) rows[`doc_${i}`] = documentRow(`doc_${i}`);
    const replica = createReplica({
      materialization: onDemand,
      residencyTtlMs: 0,
      readComponent: reader(rows),
    });

    for (const id of Object.keys(rows)) await replica.read(id, ["document/text"]);

    // The values are warm; the read path kept nothing else. A leftover entry
    // would show up here as a row with a read it never settled.
    expect(replica.stats().readsInFlight).toBe(0);
    expect(replica.stats().leases).toMatchObject({ leased: 0, inactive: 50, resident: 50 });
  });

  it("drops the reads in flight on load", async () => {
    let deliver!: (row: Entity) => void;
    const replica = createReplica({
      materialization: onDemand,
      residencyTtlMs: 0,
      readComponent: () =>
        new Promise<Entity>((resolve) => {
          deliver = resolve;
        }),
    });

    const reading = replica.read("doc_1", ["document/text"]);
    expect(replica.stats().readsInFlight).toBe(1);

    replica.load({
      format: REPLICA_RECORD_FORMAT,
      componentVersions: {},
      position: 0,
      revision: 5,
      entities: [entity({ id: "e_9", model: "todo" })],
    });
    expect(replica.stats().readsInFlight).toBe(0);

    deliver(documentRow("doc_1"));
    expect(await reading).toBeNull();
    expect(replica.get("doc_1")).toBeUndefined();
  });

  it("holds the lease from before the store read until the value is installed", async () => {
    let deliver!: (row: Entity) => void;
    const replica = createReplica({
      materialization: onDemand,
      residencyTtlMs: 1_000,
      readComponent: () =>
        new Promise<Entity>((resolve) => {
          deliver = resolve;
        }),
    });

    const reading = replica.read("doc_1", ["document/text"]);
    expect(replica.stats().leases).toMatchObject({
      leased: 1,
      inactive: 0,
      resident: 1,
      byComponent: { "document/text": { leased: 1, inactive: 0 } },
    });

    deliver(documentRow("doc_1"));
    expect(await reading).toEqual(documentRow("doc_1"));
    expect(replica.stats().leases).toMatchObject({
      leased: 0,
      inactive: 1,
      resident: 1,
      byComponent: { "document/text": { leased: 0, inactive: 1 } },
    });
  });

  it("replays updates that land while a cold read is reading", async () => {
    let release!: (row: Entity) => void;
    const replica = createReplica({
      materialization: onDemand,
      residencyTtlMs: 0,
      readComponent: () =>
        new Promise<Entity>((resolve) => {
          release = resolve;
        }),
    });

    const reading = replica.read("doc_1", ["document/text"]);
    ingest(
      replica,
      patch({
        actionId: "a_live",
        updateId: "u_live",
        entityId: "doc_1",
        model: "document",
        gsn: 6,
        ms: 6,
        fields: { text: leaf("live", "u_live", 6) },
      }),
      6,
    );
    release(documentRow("doc_1"));

    expect(await reading).toEqual(
      entity({
        id: "doc_1",
        model: "document",
        data: { fields: { text: leaf("live", "u_live", 6) } },
        updated_hlc: makeHlc(6),
        last_gsn: 6,
      }),
    );
    expect(replica.get("doc_1")?.data.fields.text).toEqual(leaf("live", "u_live", 6));
  });

  it("does not resurrect a row evicted while its read was in flight", async () => {
    let release!: (row: Entity) => void;
    const replica = createReplica({
      materialization: onDemand,
      residencyTtlMs: 0,
      readComponent: () =>
        new Promise<Entity>((resolve) => {
          release = resolve;
        }),
    });

    const reading = replica.read("doc_1", ["document/text"]);
    replica.evict(["doc_1"]);
    release(documentRow("doc_1"));

    expect(await reading).toBeNull();
    expect(replica.get("doc_1")).toBeUndefined();
  });

  it("does not read or lease a held component", async () => {
    const replica = createReplica({ materialization: onDemand });

    expect(await replica.read("e_1", ["todo/title"])).toBeNull();
    expect(replica.revision).toBe(0);
    expect(replica.stats().leases).toEqual({
      leased: 0,
      inactive: 0,
      resident: 0,
      timers: 0,
      oldestInactiveMs: 0,
      byComponent: {},
    });
  });

  it("keeps a component's value while its claim lives, and drops it when the fold detaches it", async () => {
    const rows = { doc_1: documentRow("doc_1") };
    const replica = createReplica({ materialization: onDemand, readComponent: reader(rows) });
    await replica.read("doc_1", ["document/text"]);

    ingest(
      replica,
      drop({
        actionId: "a_drop",
        updateId: "u_drop",
        entityId: "doc_1",
        model: "document",
        gsn: 9,
        ms: 9,
        fields: { text: leaf(null, "u_drop", 9) },
      }),
      9,
    );

    // The row keeps the model its create named and survives with no component;
    // the value the claim kept goes with the component.
    expect(replica.get("doc_1")?.model).toBe("document");
    expect(replica.get("doc_1")?.data.fields.text).toBeUndefined();
    // The claim has nothing left to keep, so it does not report residency the
    // composed view does not have.
    expect(replica.stats().residentComponents).toBe(0);
    expect(replica.stats().leases).toMatchObject({
      leased: 0,
      inactive: 0,
      resident: 0,
      byComponent: {},
    });
  });

  it("keeps folding live updates into a read row", async () => {
    const rows = { doc_1: documentRow("doc_1") };
    const replica = createReplica({ materialization: onDemand, readComponent: reader(rows) });
    await replica.read("doc_1", ["document/text"]);

    ingest(
      replica,
      patch({
        actionId: "a_live",
        updateId: "u_live",
        entityId: "doc_1",
        model: "document",
        gsn: 6,
        ms: 6,
        fields: { text: leaf("live", "u_live", 6) },
      }),
      6,
    );

    expect(replica.get("doc_1")?.data.fields.text).toEqual(leaf("live", "u_live", 6));
  });

  it("drops a patch for an unread on-demand row instead of retaining an orphan", () => {
    const replica = createReplica({ materialization: onDemand });

    ingest(
      replica,
      patch({
        actionId: "a_cold",
        updateId: "u_cold",
        entityId: "doc_1",
        model: "document",
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

  it("keeps 10k held metadata rows and materializes only a read body", async () => {
    // The #500 shape at 10k documents: page metadata is held, bodies are not.
    const entities: Entity[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      entities.push(entity({ id: `page_${i}`, model: "page" }));
      entities.push(documentRow(`doc_${i}`));
    }
    const rows = { doc_0: documentRow("doc_0") };
    const replica = createReplica({
      materialization: onDemand,
      readComponent: reader(rows),
    });

    replica.load({
      format: REPLICA_RECORD_FORMAT,
      componentVersions: {},
      position: 0,
      revision: 1,
      entities,
    });

    expect(replica.stats()).toMatchObject({
      held: 10_000,
      heldByModel: { page: 10_000 },
      byModel: { page: 10_000 },
      leases: { leased: 0, inactive: 0, resident: 0 },
    });
    expect(replica.stats().byModel.document).toBeUndefined();

    await replica.read("doc_0", ["document/text"]);

    expect(replica.stats()).toMatchObject({
      held: 10_000,
      byModel: { page: 10_000, document: 1 },
      leases: {
        leased: 0,
        inactive: 1,
        resident: 1,
        byComponent: { "document/text": { leased: 0, inactive: 1 } },
      },
    });
  });

  it("evicts a row, its value, and the claim waiting out its grace period", async () => {
    const rows = { doc_1: documentRow("doc_1") };
    const replica = createReplica({ materialization: onDemand, readComponent: reader(rows) });
    await replica.read("doc_1", ["document/text"]);
    expect(replica.stats().leases).toMatchObject({ inactive: 1, resident: 1 });

    replica.evict(["doc_1"]);

    expect(replica.get("doc_1")).toBeUndefined();
    expect(replica.stats().residentComponents).toBe(0);
    expect(replica.stats().leases).toMatchObject({
      leased: 0,
      inactive: 0,
      resident: 0,
      byComponent: {},
    });
  });

  it("retains every read row", async () => {
    const rows: Record<string, Entity> = {};
    for (let i = 1; i <= 20; i += 1) rows[`doc_${i}`] = documentRow(`doc_${i}`);
    const replica = createReplica({
      materialization: onDemand,
      readComponent: reader(rows),
    });

    for (const id of Object.keys(rows)) await replica.read(id, ["document/text"]);

    expect(replica.stats().leases).toMatchObject({ leased: 0, inactive: 20, resident: 20 });
    expect(replica.stats().byModel).toEqual({ document: 20 });
  });

  it("persists held rows only, never a read body", async () => {
    const rows = { doc_1: documentRow("doc_1") };
    const replica = createReplica({ materialization: onDemand, readComponent: reader(rows) });
    ingest(
      replica,
      put({ actionId: "a_1", updateId: "u_1", ms: 10, fields: { title: leaf("Todo", "u_1", 10) } }),
      1,
    );
    await replica.read("doc_1", ["document/text"]);

    expect(replica.toRecord().entities).toEqual([
      entity({
        id: "e_1",
        model: "todo",
        data: { fields: { title: leaf("Todo", "u_1", 10) } },
        exists: true,
        created_hlc: makeHlc(10),
        updated_hlc: makeHlc(10),
        last_gsn: 1,
      }),
    ]);
  });

  it("drops every claim on load and installs held rows only", async () => {
    const rows = { doc_1: documentRow("doc_1") };
    const replica = createReplica({ materialization: onDemand, readComponent: reader(rows) });
    await replica.read("doc_1", ["document/text"]);

    replica.load({
      format: REPLICA_RECORD_FORMAT,
      componentVersions: {},
      position: 0,
      revision: 5,
      entities: [documentRow("doc_2"), entity({ id: "e_1", model: "todo" })],
    });

    expect(replica.get("doc_1")).toBeUndefined();
    expect(replica.get("doc_2")).toBeUndefined();
    expect(replica.get("e_1")?.model).toBe("todo");
    expect(replica.stats()).toMatchObject({
      entities: 1,
      byModel: { todo: 1 },
      leases: { leased: 0, inactive: 0, resident: 0 },
    });
  });

  describe("residency grace period", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("releases a read value once its grace period elapses, journalling nothing", async () => {
      const rows = { doc_1: documentRow("doc_1") };
      const replica = createReplica({
        materialization: onDemand,
        residencyTtlMs: 1_000,
        readComponent: reader(rows),
      });
      await replica.read("doc_1", ["document/text"]);
      const revision = replica.revision;

      await vi.advanceTimersByTimeAsync(999);
      expect(replica.get("doc_1")).toEqual(documentRow("doc_1"));
      expect(replica.stats().leases.oldestInactiveMs).toBe(999);

      await vi.advanceTimersByTimeAsync(1);

      // The value left the composed view, and that is not a content change: a
      // derived reader sees no revision move and no journal entry.
      expect(replica.get("doc_1")).toBeUndefined();
      expect(replica.revision).toBe(revision);
      expect(replica.changesSince(revision)).toEqual([]);
      expect(replica.stats().leases).toEqual({
        leased: 0,
        inactive: 0,
        resident: 0,
        timers: 0,
        oldestInactiveMs: 0,
        byComponent: {},
      });
    });

    it("cancels the pending release when a read lands inside the grace period", async () => {
      const rows = { doc_1: documentRow("doc_1") };
      const reads: string[] = [];
      const replica = createReplica({
        materialization: onDemand,
        residencyTtlMs: 1_000,
        readComponent: reader(rows, reads),
      });
      await replica.read("doc_1", ["document/text"]);

      await vi.advanceTimersByTimeAsync(600);
      await replica.read("doc_1", ["document/text"]);
      expect(reads).toEqual(["doc_1"]);

      await vi.advanceTimersByTimeAsync(600);
      expect(replica.get("doc_1")).toEqual(documentRow("doc_1"));

      await vi.advanceTimersByTimeAsync(400);
      expect(replica.get("doc_1")).toBeUndefined();
    });

    it("never expires a value under a live claim", async () => {
      let deliver!: (row: Entity) => void;
      const replica = createReplica({
        materialization: onDemand,
        residencyTtlMs: 1_000,
        readComponent: () =>
          new Promise<Entity>((resolve) => {
            deliver = resolve;
          }),
      });

      const reading = replica.read("doc_1", ["document/text"]);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      deliver(documentRow("doc_1"));

      expect(await reading).toEqual(documentRow("doc_1"));
      expect(replica.get("doc_1")).toEqual(documentRow("doc_1"));

      // The release that ends the claim starts a fresh grace period.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(replica.get("doc_1")).toBeUndefined();
    });

    it("keeps a read value indefinitely when the grace period is disabled", async () => {
      const rows = { doc_1: documentRow("doc_1") };
      const replica = createReplica({
        materialization: onDemand,
        residencyTtlMs: 0,
        readComponent: reader(rows),
      });
      await replica.read("doc_1", ["document/text"]);

      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(replica.get("doc_1")).toEqual(documentRow("doc_1"));
      expect(replica.stats().leases).toMatchObject({ leased: 0, inactive: 1, timers: 0 });
    });

    it("leaves a pending release as a no-op when the row is evicted first", async () => {
      const rows = { doc_1: documentRow("doc_1") };
      const replica = createReplica({
        materialization: onDemand,
        residencyTtlMs: 1_000,
        readComponent: reader(rows),
      });
      await replica.read("doc_1", ["document/text"]);
      replica.evict(["doc_1"]);
      const revision = replica.revision;

      await vi.advanceTimersByTimeAsync(5_000);

      expect(replica.get("doc_1")).toBeUndefined();
      expect(replica.revision).toBe(revision);
      expect(replica.changesSince(revision)).toEqual([]);
    });
  });
});

describe("replica: a read selects every component (#934)", () => {
  // Every component of the row is on demand, so a read selects one per field.
  // Three is the issue's repro; twenty is past the window the replica used to
  // hold, so it goes red again if a cap ever comes back.
  const allOnDemand = { holds: (): boolean => false };
  const noteId = "note_1";
  const fieldsOf = (count: number): readonly string[] =>
    Array.from({ length: count }, (_, index) => `f_${index}`);
  const componentsOf = (count: number): readonly string[] =>
    fieldsOf(count).map((field) => `note/${field}`);

  const lazyRow = (fields: readonly string[]): Entity =>
    entity({
      id: noteId,
      model: "note",
      data: {
        fields: Object.fromEntries(
          fields.map((field) => [field, leaf(`${field} value`, `u_${field}`, 10)]),
        ),
      },
      created_hlc: makeHlc(10),
      updated_hlc: makeHlc(10),
    });

  /** One read of every component, and the revision it started from. */
  const readEveryComponent = async (
    count: number,
  ): Promise<{ replica: Replica; revision: number }> => {
    const replica = createReplica({
      materialization: allOnDemand,
      residencyTtlMs: 0,
      readComponent: async () => lazyRow(fieldsOf(count)),
    });
    ingest(replica, create({ actionId: "a_1", updateId: "u_1", ms: 10 }), 1);
    const revision = replica.revision;
    await replica.read(noteId, componentsOf(count));
    return { replica, revision };
  };

  const expectEveryComponentResident = (
    replica: Replica,
    revision: number,
    count: number,
  ): void => {
    expect(Object.keys(replica.get(noteId)?.data.fields ?? {})).toHaveLength(count);
    expect(
      fieldsOf(count).filter((field) => !replica.isComponentResident(noteId, `note/${field}`)),
    ).toEqual([]);
    // One read, one grace period, no cap on how many components a row keeps —
    // and residency never moves the revision.
    expect(replica.revision).toBe(revision);
    const leases = replica.stats().leases;
    expect(leases).toMatchObject({ leased: 0, inactive: count, resident: count });
    expect(Object.keys(leases.byComponent).sort()).toEqual([...componentsOf(count)].sort());
    for (const counts of Object.values(leases.byComponent)) {
      expect(counts).toMatchObject({ leased: 0, inactive: 1 });
    }
  };

  it("returns all three components of a row after all three are read", async () => {
    const { replica, revision } = await readEveryComponent(3);
    expectEveryComponentResident(replica, revision, 3);
  });

  it("returns all twenty components of a row after all twenty are read", async () => {
    const { replica, revision } = await readEveryComponent(20);
    expectEveryComponentResident(replica, revision, 20);
  });
});

describe("replica: content and membership changes (#939)", () => {
  it("journals a create as one membership change that names no component", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        ms: 10,
        fields: { title: leaf("Hello", "u_title", 10), status: leaf("open", "u_status", 10) },
      }),
      1,
    );

    // The row entered the set a reader draws from, which is a fact about the
    // row, not about the components it happened to arrive carrying.
    expect(replica.changesSince(0)).toEqual([
      {
        revision: 1,
        id: "e_1",
        kind: "membership",
        membership: "entered",
        models: ["todo"],
        deleted: false,
      },
    ]);
  });

  it("journals a delete as one membership change that names no component", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        ms: 10,
        fields: { title: leaf("Hello", "u_title", 10), status: leaf("open", "u_status", 10) },
      }),
      1,
    );
    ingest(replica, remove({ actionId: "a_2", updateId: "u_2", gsn: 2, ms: 20 }), 2);

    expect(replica.changesSince(1)).toEqual([
      {
        revision: 2,
        id: "e_1",
        kind: "membership",
        membership: "left",
        models: ["todo"],
        deleted: true,
      },
    ]);
  });

  it("journals a component write as one content change naming that component", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        ms: 10,
        fields: { title: leaf("First", "u_title", 10), status: leaf("open", "u_status", 10) },
      }),
      1,
    );
    ingest(
      replica,
      patch({
        actionId: "a_2",
        updateId: "u_2",
        gsn: 2,
        ms: 20,
        fields: { title: leaf("Second", "u_2", 20) },
      }),
      2,
    );

    expect(replica.changesSince(1)).toEqual([
      { revision: 2, id: "e_1", kind: "content", components: ["todo/title"], deleted: false },
    ]);
  });

  it("journals a model change as a membership change naming both models", () => {
    const replica = createReplica();
    // A component write before its create materializes a placeholder under the
    // component's prefix; the create adopts it and names the row's model.
    ingest(
      replica,
      patch({
        actionId: "a_1",
        updateId: "u_1",
        model: "note",
        ms: 10,
        fields: { title: leaf("First", "u_1", 10) },
      }),
      1,
    );
    ingest(replica, create({ actionId: "a_2", updateId: "u_2", model: "todo", gsn: 2, ms: 20 }), 2);

    expect(replica.changesSince(1)).toEqual([
      {
        revision: 2,
        id: "e_1",
        kind: "membership",
        membership: "changed-model",
        models: ["note", "todo"],
        deleted: false,
      },
    ]);
  });

  it("journals an evicted row as a membership change under the model it was filed in", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({ actionId: "a_1", updateId: "u_1", ms: 10, fields: { title: leaf("T", "u_1", 10) } }),
      1,
    );

    replica.evict(["e_1"]);

    expect(replica.changesSince(1)).toEqual([
      {
        revision: 2,
        id: "e_1",
        kind: "membership",
        membership: "left",
        models: ["todo"],
        deleted: false,
      },
    ]);
  });

  it("journals nothing for a cold read's install or its grace-period release", async () => {
    vi.useFakeTimers();
    const stored = entity({
      id: "doc_1",
      model: "document",
      data: { fields: { text: leaf("body", "u_text", 5) } },
    });
    const rows: Record<string, Entity> = { doc_1: stored };
    const replica = createReplica({
      materialization: { holds: (component: string) => component !== "document/text" },
      residencyTtlMs: 1_000,
      readComponent: async (id) => rows[id] ?? null,
    });
    const revision = replica.revision;

    await replica.read("doc_1", ["document/text"]);
    expect(replica.revision).toBe(revision);
    expect(replica.changesSince(revision)).toEqual([]);

    // The release path is residency, not content: the value leaves the replica
    // when the grace period elapses and nothing journals for it.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(replica.get("doc_1")).toBeUndefined();
    expect(replica.revision).toBe(revision);
    expect(replica.changesSince(revision)).toEqual([]);
    vi.useRealTimers();
  });

  // The set a read is drawn from is what `get` and `iterate` answer with, which
  // is residency-independent: a row the policy does not retain still reaches a
  // query, so the journal has to describe it.
  describe("a row the policy does not retain", () => {
    const noDocuments = { holds: (component: string) => !component.startsWith("document/") };

    it("journals a create as entering its model even though it keeps no value", () => {
      const replica = createReplica({ materialization: noDocuments });
      ingest(
        replica,
        put({
          actionId: "a_1",
          updateId: "u_1",
          entityId: "doc_1",
          model: "document",
          ms: 10,
          fields: { text: leaf("body", "u_text", 10) },
        }),
        1,
      );

      // `get` and `iterate` both answer with the row; a reader that scans the
      // model has to be told it arrived.
      expect(replica.get("doc_1")?.model).toBe("document");
      expect(replica.iterate("document").map((row) => row.id)).toEqual(["doc_1"]);
      expect(replica.changesSince(0)).toEqual([
        {
          revision: 1,
          id: "doc_1",
          kind: "membership",
          membership: "entered",
          models: ["document"],
          deleted: false,
        },
      ]);
    });

    it("journals no membership change for writes to a row that stays visible", () => {
      const replica = createReplica({ materialization: noDocuments });
      ingest(
        replica,
        create({ actionId: "a_1", updateId: "u_1", entityId: "doc_1", model: "document", ms: 10 }),
        1,
      );
      const dormant = (gsn: number, text: string): Action =>
        patch({
          actionId: `a_${gsn}`,
          updateId: `u_${gsn}`,
          entityId: "doc_1",
          model: "document",
          gsn,
          ms: gsn * 10,
          fields: { text: leaf(text, `u_${gsn}`, gsn * 10) },
        });

      ingest(replica, dormant(2, "first"), 2);
      ingest(replica, dormant(3, "second"), 3);

      // The row never left the set a read draws from: the first write adds a
      // component it knows exists, and the second changes nothing a reader can
      // observe. Neither is a membership change.
      expect(replica.iterate("document").map((row) => row.id)).toEqual(["doc_1"]);
      expect(replica.changesSince(0)).toEqual([
        {
          revision: 1,
          id: "doc_1",
          kind: "membership",
          membership: "entered",
          models: ["document"],
          deleted: false,
        },
        {
          revision: 2,
          id: "doc_1",
          kind: "content",
          components: ["document/text"],
          deleted: false,
        },
      ]);
    });

    it("journals nothing for a write to a row that never became visible", () => {
      const replica = createReplica({ materialization: noDocuments });
      ingest(
        replica,
        patch({
          actionId: "a_1",
          updateId: "u_1",
          entityId: "doc_1",
          model: "document",
          ms: 10,
          fields: { text: leaf("body", "u_text", 10) },
        }),
        1,
      );

      expect(replica.get("doc_1")).toBeUndefined();
      expect(replica.iterate("document")).toEqual([]);
      expect(replica.revision).toBe(0);
      expect(replica.changesSince(0)).toEqual([]);
    });
  });

  it("journals the values of a row no model has filed when it is evicted", () => {
    const replica = createReplica();
    // An edge write before its row's create materializes a row no model owns:
    // it is in no model's set, so what leaves is the value it carried.
    ingest(
      replica,
      patch({
        actionId: "a_1",
        updateId: "u_1",
        entityId: "page_1",
        ms: 10,
        fields: { link: map({ author: map({ wrote: map({ target_1: leaf(true, "u_1", 10) }) }) }) },
        keyedComponent: "ebb/link",
      }),
      1,
    );
    expect(replica.get("page_1")?.model).toBe("");

    replica.evict(["page_1"]);

    expect(replica.changesSince(1)).toEqual([
      { revision: 2, id: "page_1", kind: "content", components: ["ebb/link"], deleted: false },
    ]);
  });
});

describe("replica: a long-lived claim (#937)", () => {
  const onDemand = { holds: (component: string): boolean => !component.startsWith("document/") };
  const documentRow = (id: string): Entity =>
    entity({
      id,
      model: "document",
      data: { fields: { text: leaf(`body ${id}`, `u_${id}`, 5) } },
      last_gsn: 5,
    });
  const reader =
    (rows: Record<string, Entity>, reads: string[] = []) =>
    async (id: string): Promise<Entity | null> => {
      reads.push(id);
      return rows[id] ?? null;
    };

  it("holds one value for two callers and clears it on the last release", async () => {
    const rows = { doc_1: documentRow("doc_1") };
    const reads: string[] = [];
    const replica = createReplica({
      materialization: onDemand,
      residencyTtlMs: 1_000,
      readComponent: reader(rows, reads),
    });

    const first = await replica.acquire("doc_1", ["document/text"]);
    const second = await replica.acquire("doc_1", ["document/text"]);

    // One store read, one value, one residency entry two claims share.
    expect(reads).toEqual(["doc_1"]);
    expect(replica.stats().leases).toMatchObject({
      leased: 1,
      inactive: 0,
      resident: 1,
      byComponent: { "document/text": { leased: 1, inactive: 0 } },
    });

    first();
    first();
    expect(replica.stats().leases).toMatchObject({ leased: 1, inactive: 0 });

    second();
    expect(replica.stats().leases).toMatchObject({ leased: 0, inactive: 1, timers: 1 });
    expect(replica.get("doc_1")).toEqual(documentRow("doc_1"));
  });

  it("does not claim a held component or one the row does not carry", async () => {
    const replica = createReplica({
      materialization: { holds: (component) => component === "document/text" },
      readComponent: async () => documentRow("doc_1"),
    });

    const release = await replica.acquire("doc_1", ["document/text", "document/appendix"]);

    // The held value needs no claim, and the absent one installs nothing.
    expect(replica.stats().leases).toMatchObject({
      leased: 0,
      inactive: 0,
      resident: 0,
      byComponent: {},
    });
    release();
  });

  it("releases what it claimed when a later read throws", async () => {
    const replica = createReplica({
      materialization: { holds: () => false },
      readComponent: async (_id, component) => {
        if (component === "document/appendix") throw new Error("store down");
        return documentRow("doc_1");
      },
    });

    await expect(replica.acquire("doc_1", ["document/text", "document/appendix"])).rejects.toThrow(
      "store down",
    );

    // The value the first read installed is released, not leaked: it waits out
    // its grace period instead of staying claimed.
    expect(replica.stats().leases).toMatchObject({
      leased: 0,
      inactive: 1,
      byComponent: { "document/text": { leased: 0, inactive: 1 } },
    });
  });
});

describe("replica: component index (#798)", () => {
  it("indexes each present component as <type>/<field>, ascending", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        entityId: "e_2",
        gsn: 1,
        ms: 10,
        fields: { title: leaf("B", "u_1", 10), completed: leaf(true, "u_1", 10) },
      }),
      1,
    );
    ingest(
      replica,
      put({
        actionId: "a_2",
        updateId: "u_2",
        entityId: "e_1",
        gsn: 2,
        ms: 20,
        fields: { title: leaf("A", "u_2", 20) },
      }),
      2,
    );

    expect(replica.components("todo/title")).toEqual(["e_1", "e_2"]);
    expect(replica.components("todo/completed")).toEqual(["e_2"]);
    expect(replica.components("todo/note")).toEqual([]);
    expect(replica.components("user/title")).toEqual([]);
  });

  it("follows an optimistic write and its discard", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        ms: 10,
        fields: { title: leaf("Base", "u_1", 10) },
      }),
      1,
    );
    const local = patch({
      actionId: "a_local",
      updateId: "u_local",
      gsn: 0,
      ms: 20,
      fields: { note: leaf("Local", "u_local", 20) },
    });

    replica.optimistic(local);
    expect(replica.components("todo/note")).toEqual(["e_1"]);

    replica.discard("a_local");
    expect(replica.components("todo/note")).toEqual([]);
    expect(replica.components("todo/title")).toEqual(["e_1"]);
  });

  it("forgets a component the composed view drops, keeping the row", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        ms: 10,
        fields: { title: leaf("Base", "u_1", 10), note: leaf("note", "u_1", 10) },
      }),
      1,
    );
    ingest(
      replica,
      drop({
        actionId: "a_2",
        updateId: "u_2",
        gsn: 2,
        ms: 20,
        fields: { note: leaf(null, "u_2", 20) },
      }),
      2,
    );

    expect(replica.components("todo/note")).toEqual([]);
    expect(replica.components("todo/title")).toEqual(["e_1"]);
    expect(replica.get("e_1")?.data.fields).toEqual({ title: leaf("Base", "u_1", 10) });
  });

  it("forgets every component of an evicted row", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        ms: 10,
        fields: { title: leaf("Base", "u_1", 10), note: leaf("note", "u_1", 10) },
      }),
      1,
    );

    replica.evict(["e_1"]);

    expect(replica.components("todo/title")).toEqual([]);
    expect(replica.components("todo/note")).toEqual([]);
  });

  it("rebuilds from a loaded record, which never persists it", () => {
    const replica = createReplica();
    ingest(
      replica,
      put({
        actionId: "a_1",
        updateId: "u_1",
        ms: 10,
        fields: { title: leaf("Base", "u_1", 10), note: leaf("note", "u_1", 10) },
      }),
      1,
    );
    const record = replica.toRecord();
    expect(record).not.toHaveProperty("components");

    const hydrated = createReplica();
    hydrated.load(record);

    expect(hydrated.components("todo/title")).toEqual(["e_1"]);
    expect(hydrated.components("todo/note")).toEqual(["e_1"]);
  });
});

describe("replica: residency per component (#802)", () => {
  // The #775 shape: a note's metadata is held, its body is a component loaded
  // only when opened.
  const componentPolicy = {
    holds: (component: string): boolean => component !== "note/body",
  };
  const noteId = "note_1";
  const noteRow = (body = "300 KB body"): Entity =>
    entity({
      id: noteId,
      model: "note",
      data: {
        fields: {
          title: leaf("One", "u_title", 10),
          status: leaf("open", "u_status", 10),
          updated_at: leaf(1, "u_updated", 10),
          body: leaf(body, "u_body", 10),
        },
      },
      created_hlc: makeHlc(10),
      updated_hlc: makeHlc(10),
    });

  const noteReplica = (): Replica => {
    const replica = createReplica({ materialization: componentPolicy, residencyTtlMs: 0 });
    replica.load({
      format: REPLICA_RECORD_FORMAT,
      componentVersions: {},
      position: 1,
      revision: 1,
      entities: [noteRow()],
    });
    return replica;
  };

  it("holds metadata and drops the lazy component's value, keeping its existence", () => {
    const replica = noteReplica();
    const row = replica.get(noteId);

    expect(Object.keys(row?.data.fields ?? {}).sort()).toEqual(["status", "title", "updated_at"]);
    expect(replica.components("note/body")).toEqual([noteId]);
    expect(replica.stats()).toMatchObject({
      entities: 1,
      held: 1,
      components: 4,
      residentComponents: 3,
      nonResident: 1,
      heldComponents: {
        "note/title": 1,
        "note/status": 1,
        "note/updated_at": 1,
      },
      nonResidentComponents: { "note/body": 1 },
      leases: { leased: 0, inactive: 0, resident: 0 },
    });
    expect(replica.isComponentResident(noteId, "note/body")).toBe(false);
    expect([...replica.residentComponents(noteId)].sort()).toEqual([
      "note/status",
      "note/title",
      "note/updated_at",
    ]);
  });

  it("reads one component through the cold-read seam in exactly one read", async () => {
    const reads: string[] = [];
    const replica = createReplica({
      materialization: componentPolicy,
      residencyTtlMs: 0,
      readComponent: async (id, component) => {
        reads.push(`${id}:${component}`);
        return id === noteId && component === "note/body" ? noteRow() : null;
      },
    });
    replica.load({
      format: REPLICA_RECORD_FORMAT,
      componentVersions: {},
      position: 1,
      revision: 1,
      entities: [noteRow()],
    });

    const row = await replica.read(noteId, ["note/body"]);

    expect(reads).toEqual([`${noteId}:note/body`]);
    expect(row?.data.fields.body).toEqual(leaf("300 KB body", "u_body", 10));
    expect(replica.stats()).toMatchObject({
      residentComponents: 4,
      nonResident: 0,
      nonResidentComponents: {},
      leases: {
        leased: 0,
        inactive: 1,
        resident: 1,
        timers: 0,
        byComponent: { "note/body": { leased: 0, inactive: 1 } },
      },
    });
    // A warm re-read inside the grace period reads nothing.
    await replica.read(noteId, ["note/body"]);
    expect(reads).toHaveLength(1);
  });

  it("releases a read component back to non-resident after its grace period, keeping the row", async () => {
    vi.useFakeTimers();
    try {
      const replica = createReplica({
        materialization: componentPolicy,
        residencyTtlMs: 1_000,
        readComponent: async () => noteRow(),
      });
      replica.load({
        format: REPLICA_RECORD_FORMAT,
        componentVersions: {},
        position: 1,
        revision: 1,
        entities: [noteRow()],
      });

      await replica.read(noteId, ["note/body"]);
      expect(replica.stats()).toMatchObject({ nonResident: 0, residentComponents: 4 });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(replica.get(noteId)?.data.fields.body).toBeUndefined();
      expect(replica.components("note/body")).toEqual([noteId]);
      expect(replica.stats()).toMatchObject({
        nonResident: 1,
        leases: { leased: 0, inactive: 0, resident: 0 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never retains a lazy component an update writes while it is closed", () => {
    const replica = noteReplica();
    const before = replica.revision;
    ingest(
      replica,
      patch({
        actionId: "a_body",
        updateId: "u_body_live",
        entityId: noteId,
        model: "note",
        gsn: 2,
        ms: 20,
        fields: { body: leaf("new body", "u_body_live", 20) },
      }),
      2,
    );

    expect(replica.get(noteId)?.data.fields.body).toBeUndefined();
    expect(replica.components("note/body")).toEqual([noteId]);
    expect(replica.stats()).toMatchObject({ nonResident: 1, residentComponents: 3 });
    // The value never entered the replica, so metadata readers do not re-run.
    expect(replica.revision).toBe(before);
    expect(replica.changesSince(before)).toEqual([]);
  });

  it("persists held components and reloads the lazy component's existence", () => {
    const replica = noteReplica();
    const record = replica.toRecord();

    expect(record.entities[0].data.fields.body).toBeUndefined();
    expect(record.notResident).toEqual({ [noteId]: ["note/body"] });

    const hydrated = createReplica({ materialization: componentPolicy });
    hydrated.load(record);
    expect(hydrated.get(noteId)?.data.fields.body).toBeUndefined();
    expect(hydrated.components("note/body")).toEqual([noteId]);
    expect(hydrated.stats()).toMatchObject({ nonResident: 1 });
  });

  it("drops a lazy component's existence with the component", () => {
    const replica = noteReplica();
    ingest(
      replica,
      drop({
        actionId: "a_drop",
        updateId: "u_drop",
        entityId: noteId,
        model: "note",
        gsn: 2,
        ms: 20,
        fields: { body: leaf(null, "u_drop", 20) },
      }),
      2,
    );

    expect(replica.components("note/body")).toEqual([]);
    expect(replica.get(noteId)?.model).toBe("note");
    expect(replica.stats()).toMatchObject({ components: 3, nonResident: 0 });
  });

  it("is not resident, and journals nothing, when every component is lazy", async () => {
    vi.useFakeTimers();
    try {
      const replica = createReplica({
        materialization: { holds: () => false },
        residencyTtlMs: 1_000,
        readComponent: async () =>
          entity({
            id: "doc_1",
            model: "document",
            data: { fields: { text: leaf("body", "u_1", 10) } },
            created_hlc: makeHlc(10),
            updated_hlc: makeHlc(10),
          }),
      });
      ingest(
        replica,
        patch({
          actionId: "a_1",
          updateId: "u_1",
          entityId: "doc_1",
          model: "document",
          ms: 10,
          fields: { text: leaf("body", "u_1", 10) },
        }),
        1,
      );

      expect(replica.get("doc_1")).toBeUndefined();
      expect(replica.stats().leases).toMatchObject({ leased: 0, inactive: 0, resident: 0 });

      await replica.read("doc_1", ["document/text"]);
      expect(replica.get("doc_1")).toBeDefined();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(replica.get("doc_1")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
