import { deepStrictEqual } from "node:assert";
import { describe, expect, it } from "vitest";
import { makeHlc, type Action, type Entity, type FieldValue, type Update } from "@ebbjs/core";

import { createMemoryAdapter } from "../memory/memory-adapter";
import type { StorageAdapter } from "../types/storage-adapter";
import { createReplica } from "./replica";
import type { Replica } from "./types";

/**
 * Dual-run oracle for the replica: drive the memory adapter and a replica in
 * lockstep and assert the replica's composed reads equal the adapter's
 * materialized rows. The adapter sorts an entity's log by gsn on read; the
 * replica folds in delivery order. The fixtures below keep delivery order and
 * gsn order consistent except where the orphan path deliberately diverges.
 */

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

const build = (
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

const put = (spec: WriteSpec): Action => build("put", spec, { fields: spec.fields });
const patch = (spec: WriteSpec): Action => build("patch", spec, { fields: spec.fields });
const remove = (spec: Omit<WriteSpec, "fields">): Action =>
  build("delete", { ...spec, fields: {} }, null);

const openRun = () => {
  const adapter = createMemoryAdapter();
  const replica = createReplica();
  const durable = async (write: Action) => {
    const entry = await adapter.actions.append(write);
    replica.ingest(entry.action, entry.added, entry.position);
    return entry;
  };
  return { adapter, replica, durable };
};

const sorted = (rows: readonly Entity[]): readonly Entity[] =>
  [...rows].sort((a, b) => a.id.localeCompare(b.id));

/** `get` first: it triggers the adapter's lazy materialize, and its type index. */
const equivalent = async (
  replica: Replica,
  adapter: StorageAdapter,
  id: string,
  type: string,
): Promise<void> => {
  const actual = replica.get(id);
  const expected = (await adapter.entities.get(id)) ?? undefined;
  deepStrictEqual(actual, expected, `get(${id})`);

  const actualRows = sorted(replica.iterate(type));
  const expectedRows = sorted(await adapter.entities.query(type));
  deepStrictEqual(actualRows, expectedRows, `iterate(${type})`);
};

describe("replica/memory dual-run", () => {
  it("matches for a put", async () => {
    const { adapter, replica, durable } = openRun();
    await durable(
      put({
        actionId: "a_1",
        updateId: "u_1",
        gsn: 1,
        ms: 10,
        fields: { title: leaf("Hello", "u_1", 10) },
      }),
    );
    await equivalent(replica, adapter, "e_1", "todo");
  });

  it("matches across higher- and lower-HLC patches", async () => {
    const { adapter, replica, durable } = openRun();
    await durable(
      put({
        actionId: "a_1",
        updateId: "u_1",
        gsn: 1,
        ms: 20,
        fields: { title: leaf("Hello", "u_1", 20) },
      }),
    );
    await equivalent(replica, adapter, "e_1", "todo");

    await durable(
      patch({
        actionId: "a_2",
        updateId: "u_2",
        gsn: 2,
        ms: 30,
        fields: { title: leaf("Updated", "u_2", 30) },
      }),
    );
    await equivalent(replica, adapter, "e_1", "todo");

    await durable(
      patch({
        actionId: "a_3",
        updateId: "u_3",
        gsn: 3,
        ms: 10,
        fields: { title: leaf("Older", "u_3", 10) },
      }),
    );
    await equivalent(replica, adapter, "e_1", "todo");
  });

  it("matches on an equal-HLC update_id tiebreak (win and lose)", async () => {
    const { adapter, replica, durable } = openRun();
    await durable(
      put({
        actionId: "a_seed",
        updateId: "u_seed",
        gsn: 1,
        ms: 50,
        fields: { title: leaf("Seed", "u_seed", 50) },
      }),
    );
    await equivalent(replica, adapter, "e_1", "todo");

    await durable(
      patch({
        actionId: "a_lose",
        updateId: "u_lose",
        gsn: 2,
        ms: 50,
        fields: { title: leaf("Loser", "u_aaa", 50) },
      }),
    );
    await equivalent(replica, adapter, "e_1", "todo");

    await durable(
      patch({
        actionId: "a_win",
        updateId: "u_win",
        gsn: 3,
        ms: 50,
        fields: { title: leaf("Winner", "u_zzz", 50) },
      }),
    );
    await equivalent(replica, adapter, "e_1", "todo");
  });

  it("matches on a map union", async () => {
    const { adapter, replica, durable } = openRun();
    await durable(
      put({
        actionId: "a_1",
        updateId: "u_a",
        gsn: 1,
        ms: 10,
        fields: { content: map({ a: leaf(1, "u_a", 10) }) },
      }),
    );
    await durable(
      patch({
        actionId: "a_2",
        updateId: "u_b",
        gsn: 2,
        ms: 20,
        fields: { content: map({ b: leaf(2, "u_b", 20) }) },
      }),
    );
    await equivalent(replica, adapter, "e_1", "todo");
  });

  it("matches on a delete tombstone and a read of the deleted entity", async () => {
    const { adapter, replica, durable } = openRun();
    await durable(
      put({
        actionId: "a_1",
        updateId: "u_1",
        gsn: 1,
        ms: 20,
        fields: { title: leaf("Hello", "u_1", 20) },
      }),
    );
    await durable(remove({ actionId: "a_2", updateId: "u_2", gsn: 2, ms: 30 }));
    await equivalent(replica, adapter, "e_1", "todo");
  });

  it("matches across a type change", async () => {
    const { adapter, replica, durable } = openRun();
    await durable(
      put({
        actionId: "a_1",
        updateId: "u_1",
        gsn: 1,
        ms: 10,
        fields: { title: leaf("Todo", "u_1", 10) },
      }),
    );
    await equivalent(replica, adapter, "e_1", "todo");

    await durable(
      put({
        actionId: "a_2",
        updateId: "u_2",
        gsn: 2,
        type: "note",
        ms: 20,
        fields: { title: leaf("Note", "u_2", 20) },
      }),
    );
    await equivalent(replica, adapter, "e_1", "note");
    await equivalent(replica, adapter, "e_1", "todo");
  });

  it("matches on a gsn-0 backfill put", async () => {
    const { adapter, replica, durable } = openRun();
    await durable(
      put({
        actionId: "a_backfill",
        updateId: "u_backfill",
        gsn: 0,
        ms: 10,
        fields: { title: leaf("Fetched", "u_backfill", 10) },
      }),
    );
    await equivalent(replica, adapter, "e_1", "todo");
  });

  it("matches when a patch arrives before its backfilled base", async () => {
    const { adapter, replica, durable } = openRun();
    await durable(
      patch({
        actionId: "a_patch",
        updateId: "u_patch",
        gsn: 5,
        ms: 50,
        fields: { title: leaf("Patched", "u_patch", 50) },
      }),
    );
    await equivalent(replica, adapter, "e_1", "todo");

    await durable(
      put({
        actionId: "a_backfill",
        updateId: "u_base",
        gsn: 3,
        ms: 30,
        fields: { title: leaf("Fetched", "u_base", 30) },
      }),
    );
    await equivalent(replica, adapter, "e_1", "todo");
  });

  it("carries an orphan across a toRecord()/load() cycle", async () => {
    const { adapter, replica, durable } = openRun();
    await durable(
      patch({
        actionId: "a_patch",
        updateId: "u_patch",
        gsn: 5,
        ms: 50,
        fields: { title: leaf("Patched", "u_patch", 50) },
      }),
    );
    await equivalent(replica, adapter, "e_1", "todo");

    const record = replica.toRecord();
    expect(record.position).toBe(0);

    const hydrated = createReplica();
    hydrated.load(record);
    for (const entry of await adapter.actions.readTail(record.position)) {
      hydrated.ingest(entry.action, entry.added, entry.position);
    }
    await equivalent(hydrated, adapter, "e_1", "todo");

    const entry = await durable(
      put({
        actionId: "a_backfill",
        updateId: "u_base",
        gsn: 3,
        ms: 30,
        fields: { title: leaf("Fetched", "u_base", 30) },
      }),
    );
    hydrated.ingest(entry.action, entry.added, entry.position);
    await equivalent(replica, adapter, "e_1", "todo");
    await equivalent(hydrated, adapter, "e_1", "todo");
  });

  it("folds a #473 per-group delivery once", async () => {
    const { adapter, replica, durable } = openRun();
    const first = put({
      actionId: "a_multi",
      updateId: "u_1",
      gsn: 1,
      ms: 10,
      fields: { title: leaf("Hello", "u_1", 10) },
    });
    const second = patch({
      actionId: "a_multi",
      updateId: "u_2",
      gsn: 1,
      ms: 20,
      fields: { title: leaf("Updated", "u_2", 20) },
    });

    await durable(first);
    await equivalent(replica, adapter, "e_1", "todo");

    const entry = await durable(second);
    expect(entry.added).toEqual([second.updates[0]]);
    await equivalent(replica, adapter, "e_1", "todo");
  });

  it("dedups a #473 re-delivery so a newer patch survives", async () => {
    const { adapter, replica, durable } = openRun();
    const backfill = put({
      actionId: "a_base",
      updateId: "u_base",
      gsn: 1,
      ms: 10,
      fields: { title: leaf("Base", "u_base", 10) },
    });
    const newer = patch({
      actionId: "a_patch",
      updateId: "u_patch",
      gsn: 2,
      ms: 20,
      fields: { title: leaf("Newer", "u_patch", 20) },
    });

    await durable(backfill);
    await durable(newer);
    await equivalent(replica, adapter, "e_1", "todo");

    const redelivery = await durable(backfill);
    expect(redelivery.added).toEqual([]);
    await equivalent(replica, adapter, "e_1", "todo");
  });
});
