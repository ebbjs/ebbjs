/**
 * Unit tests for the per-entity history read.
 *
 * History is a pure read over the replica's Action log: one event per
 * Action that touched the entity, each carrying the actor, HLC, GSN, the
 * entity's Update methods, and the field positions the Action moved. The
 * diff is the shared `diffEntity` projection the conflict view reads, so a
 * map-key edit is a `path` entry rather than a whole-map replacement.
 */

import { describe, expect, it, vi } from "vitest";
import { makeHlc, type Action, type FieldValue, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

import {
  DEFAULT_HISTORY_LIMIT as DEFAULT_FROM_ENTRY,
  type HistoryEvent,
  type HistoryOptions,
  type ReplayOptions,
} from "../index";
import { createClient } from "./client";
import { DEFAULT_HISTORY_LIMIT, readEntityHistory, replayEntity } from "./history";

const WALL = "wall_1";
const BASE_MS = 1_711_036_800_000;

/** A monotonic HLC for action number `n`; later actions win the merge. */
const stamp = (n: number): string => makeHlc(BASE_MS + n);

const leaf = (value: unknown, n: number, updateId = `u_${n}`): FieldValue => ({
  value,
  update_id: updateId,
  hlc: stamp(n),
});

/** One Action touching `subject`, stamped with `gsn` / `hlc`. */
const action = (
  id: string,
  gsn: number,
  updates: readonly Update[],
  actorId = "actor_1",
): Action => ({ id, actor_id: actorId, hlc: stamp(gsn), gsn, updates: [...updates] });

/** A put/patch Update carrying `fields`. */
const write = (
  method: "put" | "patch",
  fields: Record<string, FieldValue>,
  subjectId = WALL,
): Update => ({
  id: `u_${method}_${subjectId}_${Object.keys(fields).join("_")}`,
  subject_id: subjectId,
  subject_type: "wall",
  method,
  data: { fields },
});

const remove = (subjectId = WALL): Update => ({
  id: `u_delete_${subjectId}`,
  subject_id: subjectId,
  subject_type: "wall",
  method: "delete",
  data: null,
});

/** Append every Action to a memory adapter's log and hand the log back. */
const logWith = async (actions: readonly Action[]) => {
  const storage = createMemoryAdapter();
  for (const next of actions) await storage.actions.append(next);
  return storage.actions;
};

describe("readEntityHistory", () => {
  it("reports the create → map-key patch → field patch → delete sequence newest first", async () => {
    const log = await logWith([
      action("a_put", 1, [
        write("put", {
          plan: { map: { x: leaf(0, 1), y: leaf(0, 1) } },
          title: leaf("wall", 1),
        }),
      ]),
      action("a_key", 2, [write("patch", { plan: { map: { x: leaf(10, 2) } } })]),
      action("a_field", 3, [write("patch", { title: leaf("moved", 3) })]),
      action("a_delete", 4, [remove()]),
    ]);

    const events = await readEntityHistory(log, { entityId: WALL });

    expect(events.map((event) => event.actionId)).toEqual([
      "a_delete",
      "a_field",
      "a_key",
      "a_put",
    ]);
    expect(events.map((event) => event.gsn)).toEqual([4, 3, 2, 1]);
    expect(events.every((event) => event.actorId === "actor_1")).toBe(true);
    expect(events.map((event) => event.hlc)).toEqual([4, 3, 2, 1].map(stamp));
    expect(events.map((event) => [...event.methods])).toEqual([
      ["delete"],
      ["patch"],
      ["patch"],
      ["put"],
    ]);

    // The delete keeps the row's fields, so it carries no removals.
    expect(events[0].changes).toEqual([]);

    // One top-level position changed by the field patch.
    expect(events[1].changes).toEqual([
      { field: "title", path: [], before: "wall", after: "moved", kind: "changed" },
    ]);

    // The map-key patch moved one key, not the whole map.
    expect(events[2].changes).toEqual([
      { field: "plan", path: ["x"], before: 0, after: 10, kind: "changed" },
    ]);

    // The create reports every top-level field as added.
    expect(events[3].changes).toEqual([
      { field: "plan", path: [], before: undefined, after: { x: 0, y: 0 }, kind: "added" },
      { field: "title", path: [], before: undefined, after: "wall", kind: "added" },
    ]);
  });

  it("returns [] for an entity the log never held", async () => {
    const log = await logWith([action("a_put", 1, [write("put", { title: leaf("wall", 1) })])]);
    expect(await readEntityHistory(log, { entityId: "wall_unknown" })).toEqual([]);
  });

  it("reports only the entity's own changes when the Action also writes another subject", async () => {
    const log = await logWith([
      action("a_put", 1, [write("put", { title: leaf("wall", 1) })]),
      action("a_mixed", 2, [
        write("patch", { title: leaf("moved", 2) }),
        write("patch", { title: leaf("other", 2) }, "wall_2"),
      ]),
    ]);

    const [newest] = await readEntityHistory(log, { entityId: WALL });

    expect(newest.actionId).toEqual("a_mixed");
    expect(newest.methods).toEqual(["patch"]);
    expect(newest.changes).toEqual([
      { field: "title", path: [], before: "wall", after: "moved", kind: "changed" },
    ]);
  });

  it("lists the entity's Update methods once each, in first-seen order", async () => {
    const log = await logWith([
      action("a_create", 1, [
        write("put", { title: leaf("wall", 1) }),
        write("patch", { plan: { map: { x: leaf(2, 1) } } }),
        write("patch", { title: leaf("moved", 1) }),
      ]),
    ]);

    const [event] = await readEntityHistory(log, { entityId: WALL });

    expect(event.methods).toEqual(["put", "patch"]);
    expect(event.changes).toEqual([
      { field: "plan", path: [], before: undefined, after: { x: 2 }, kind: "added" },
      { field: "title", path: [], before: undefined, after: "moved", kind: "added" },
    ]);
  });
});

describe("paging", () => {
  const pagedLog = () =>
    logWith([
      action("a_put", 1, [write("put", { title: leaf("wall", 1) })]),
      action("a_two", 2, [write("patch", { title: leaf("two", 2) })]),
      action("a_three", 3, [write("patch", { title: leaf("three", 3) })]),
      action("a_four", 4, [write("patch", { title: leaf("four", 4) })]),
    ]);

  it("returns the newest `limit` events, newest first", async () => {
    const events = await readEntityHistory(await pagedLog(), { entityId: WALL, limit: 2 });
    expect(events.map((event) => event.actionId)).toEqual(["a_four", "a_three"]);
  });

  it("defaults to DEFAULT_HISTORY_LIMIT", async () => {
    const events = await readEntityHistory(await pagedLog(), { entityId: WALL });
    expect(events).toHaveLength(4);
    expect(DEFAULT_HISTORY_LIMIT).toBe(50);
  });

  it("returns only events strictly older than `beforeGsn`, still folded from the start", async () => {
    const events = await readEntityHistory(await pagedLog(), { entityId: WALL, beforeGsn: 3 });

    expect(events.map((event) => event.actionId)).toEqual(["a_two", "a_put"]);
    // The fold starts at the oldest Action even though the create is filtered
    // out, so `a_two` reports a change from "wall" rather than an addition.
    expect(events[0].changes).toEqual([
      { field: "title", path: [], before: "wall", after: "two", kind: "changed" },
    ]);
  });

  it("combines `beforeGsn` with `limit` over the survivors", async () => {
    const events = await readEntityHistory(await pagedLog(), {
      entityId: WALL,
      beforeGsn: 4,
      limit: 1,
    });
    expect(events.map((event) => event.actionId)).toEqual(["a_three"]);
  });

  it("returns [] for a non-positive limit", async () => {
    const log = await pagedLog();
    expect(await readEntityHistory(log, { entityId: WALL, limit: 0 })).toEqual([]);
    expect(await readEntityHistory(log, { entityId: WALL, limit: -1 })).toEqual([]);
  });

  it("does not mutate the Actions it reads", async () => {
    const log = createMemoryAdapter();
    const appended = [
      action("a_put", 1, [write("put", { title: leaf("wall", 1) })]),
      action("a_two", 2, [write("patch", { title: leaf("two", 2) })]),
    ];
    for (const next of appended) await log.actions.append(next);
    const before = await log.actions.getForEntity(WALL);

    await readEntityHistory(log.actions, { entityId: WALL, limit: 1 });

    expect(await log.actions.getForEntity(WALL)).toEqual(before);
  });
});

describe("replayEntity", () => {
  const replayLog = () =>
    logWith([
      action("a_put", 1, [write("put", { title: leaf("wall", 1) })]),
      action("a_field", 2, [write("patch", { title: leaf("moved", 2) })]),
      action("a_delete", 3, [remove()]),
    ]);

  it("returns the row as of an intermediate Action", async () => {
    const row = await replayEntity(await replayLog(), {
      entityId: WALL,
      at: { actionId: "a_put" },
    });

    expect(row).toMatchObject({
      id: WALL,
      type: "wall",
      data: { fields: { title: { value: "wall" } } },
      deleted_hlc: null,
      last_gsn: 1,
    });

    const later = await replayEntity(await replayLog(), {
      entityId: WALL,
      at: { actionId: "a_field" },
    });
    expect(later?.data.fields.title).toMatchObject({ value: "moved" });
    expect(later?.last_gsn).toBe(2);
    expect(later?.deleted_hlc).toBeNull();
  });

  it("returns the tombstoned row with its fields at the delete", async () => {
    const row = await replayEntity(await replayLog(), {
      entityId: WALL,
      at: { actionId: "a_delete" },
    });

    expect(row?.data.fields.title).toMatchObject({ value: "moved" });
    expect(row?.deleted_hlc).toBe(stamp(3));
    expect(row?.last_gsn).toBe(3);
  });

  it("returns null for an action id the entity's log does not hold", async () => {
    const log = await logWith([
      action("a_put", 1, [write("put", { title: leaf("wall", 1) })]),
      action("a_other", 2, [write("put", { title: leaf("other", 2) }, "wall_2")]),
    ]);

    expect(await replayEntity(log, { entityId: WALL, at: { actionId: "a_missing" } })).toBeNull();
    // An Action the log holds but that never touched this entity is not in
    // the entity's read, so it cannot be replayed here either.
    expect(await replayEntity(log, { entityId: WALL, at: { actionId: "a_other" } })).toBeNull();
  });
});

describe("SyncClient history surface", () => {
  it("reads history and replays a past row through the client, offline", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("no network in this test");
    });
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage: createMemoryAdapter(),
      fetchImpl,
    });
    for (const next of [
      action("a_put", 1, [write("put", { title: leaf("wall", 1) })]),
      action("a_field", 2, [write("patch", { title: leaf("moved", 2) })]),
    ]) {
      await client.storage.actions.append(next);
    }

    const options: HistoryOptions = { entityId: WALL };
    const events: readonly HistoryEvent[] = await client.history(options);

    expect(events.map((event) => event.actionId)).toEqual(["a_field", "a_put"]);
    expect(events[0].changes).toEqual([
      { field: "title", path: [], before: "wall", after: "moved", kind: "changed" },
    ]);

    const at: ReplayOptions = { entityId: WALL, at: { actionId: "a_put" } };
    const row = await client.replay(at);
    expect(row?.data.fields.title).toMatchObject({ value: "wall" });

    expect(await client.history({ entityId: "wall_unknown" })).toEqual([]);
    expect(await client.replay({ entityId: WALL, at: { actionId: "a_missing" } })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("exports the history surface and its default limit from the package entry", () => {
    expect(DEFAULT_FROM_ENTRY).toBe(50);
  });
});
