/**
 * Unit tests for the Snapshots manager (#395).
 *
 * The manager owns the pre-sync capture of entity rows at risk during a
 * catch-up: one local read per at-risk entity, deduped across the whole
 * sync, exposed as the `client.snapshots` read/release surface.
 */

import { describe, it, expect, vi } from "vitest";
import type { Entity } from "@ebbjs/core";

import { createSnapshots } from "./snapshots";

const mkEntity = (id: string, title: string): Entity => ({
  id,
  type: "todo",
  data: { fields: { title: { value: title, update_id: `u_${id}`, hlc: "1" } } },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 1,
});

const mkDeps = (rows: Record<string, Entity> = {}) => {
  const read = vi.fn(async (id: string): Promise<Entity | null> => rows[id] ?? null);
  return { read, deps: { read } };
};

describe("createSnapshots", () => {
  it("captures the pre-merge row for each at-risk entity", async () => {
    const a = mkEntity("todo_1", "before");
    const harness = mkDeps({ todo_1: a });
    const { snapshots, capture } = createSnapshots(harness.deps);

    await capture(["todo_1"]);

    expect(snapshots.list()).toEqual(["todo_1"]);
    expect(await snapshots.get("todo_1")).toBe(a);
  });

  it("reads each at-risk entity at most once", async () => {
    const harness = mkDeps({ todo_1: mkEntity("todo_1", "a"), todo_2: mkEntity("todo_2", "b") });
    const { capture } = createSnapshots(harness.deps);

    await capture(["todo_1", "todo_2", "todo_1"]);

    expect(harness.read).toHaveBeenCalledTimes(2);
    expect(harness.read.mock.calls.map(([id]) => id)).toEqual(["todo_1", "todo_2"]);
  });

  it("reads nothing for entities with no buffered write", async () => {
    const harness = mkDeps();
    const { capture, snapshots } = createSnapshots(harness.deps);

    await capture([]);

    expect(harness.read).not.toHaveBeenCalled();
    expect(snapshots.list()).toEqual([]);
  });

  it("skips an entity with no cached row", async () => {
    const harness = mkDeps();
    const { capture, snapshots } = createSnapshots(harness.deps);

    await capture(["todo_missing"]);

    expect(snapshots.list()).toEqual([]);
    expect(await snapshots.get("todo_missing")).toBeNull();
  });

  it("retries a previously-missing row on a later capture", async () => {
    const harness = mkDeps();
    const { capture, snapshots } = createSnapshots(harness.deps);

    await capture(["todo_1"]);
    harness.read.mockResolvedValue(mkEntity("todo_1", "appeared"));
    await capture(["todo_1"]);

    expect(await snapshots.get("todo_1")).not.toBeNull();
  });

  it("does not re-capture or overlay an already-captured row", async () => {
    const first = mkEntity("todo_1", "before");
    const harness = mkDeps({ todo_1: first });
    const { capture, snapshots } = createSnapshots(harness.deps);

    await capture(["todo_1"]);
    harness.read.mockResolvedValue(mkEntity("todo_1", "after"));
    await capture(["todo_1"]);

    expect(harness.read).toHaveBeenCalledTimes(1);
    expect(await snapshots.get("todo_1")).toBe(first);
  });

  it("releases one capture without touching the others", async () => {
    const harness = mkDeps({ todo_1: mkEntity("todo_1", "a"), todo_2: mkEntity("todo_2", "b") });
    const { capture, snapshots } = createSnapshots(harness.deps);
    await capture(["todo_1", "todo_2"]);

    snapshots.release("todo_1");

    expect(snapshots.list()).toEqual(["todo_2"]);
    expect(await snapshots.get("todo_1")).toBeNull();
    expect(await snapshots.get("todo_2")).not.toBeNull();
  });

  it("clears every capture", async () => {
    const harness = mkDeps({ todo_1: mkEntity("todo_1", "a") });
    const { capture, snapshots } = createSnapshots(harness.deps);
    await capture(["todo_1"]);

    snapshots.clear();

    expect(snapshots.list()).toEqual([]);
    expect(await snapshots.get("todo_1")).toBeNull();
  });

  it("releases a batch of captures", async () => {
    const harness = mkDeps({ todo_1: mkEntity("todo_1", "a"), todo_2: mkEntity("todo_2", "b") });
    const { capture, releaseMany, snapshots } = createSnapshots(harness.deps);
    await capture(["todo_1", "todo_2"]);

    releaseMany(["todo_1", "todo_2"]);

    expect(snapshots.list()).toEqual([]);
  });
});
