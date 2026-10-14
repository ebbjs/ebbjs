/**
 * Unit tests for the Snapshots manager (#395, per-pass capture #408).
 *
 * The manager owns the pre-sync capture of entity rows at risk during a
 * catch-up: one local read per at-risk entity per catch-up pass, keyed by
 * that pass's `catchUpId`, exposed as the `client.snapshots` read/release
 * surface. A later pass captures afresh rather than reusing the first
 * pass's row, so the outbox can pair each conflict with the row that
 * preceded its own window.
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
    const { snapshots, capture, readPass } = createSnapshots(harness.deps);

    await capture("cu_1", ["todo_1"]);

    expect(snapshots.list()).toEqual(["todo_1"]);
    expect(await snapshots.get("todo_1")).toBe(a);
    expect(readPass("cu_1", "todo_1")).toBe(a);
  });

  it("reads each at-risk entity at most once within a pass", async () => {
    const harness = mkDeps({ todo_1: mkEntity("todo_1", "a"), todo_2: mkEntity("todo_2", "b") });
    const { capture } = createSnapshots(harness.deps);

    await capture("cu_1", ["todo_1", "todo_2", "todo_1"]);

    expect(harness.read).toHaveBeenCalledTimes(2);
    expect(harness.read.mock.calls.map(([id]) => id)).toEqual(["todo_1", "todo_2"]);
  });

  it("reads nothing for entities with no buffered write", async () => {
    const harness = mkDeps();
    const { capture, snapshots } = createSnapshots(harness.deps);

    await capture("cu_1", []);

    expect(harness.read).not.toHaveBeenCalled();
    expect(snapshots.list()).toEqual([]);
  });

  it("skips an entity with no cached row", async () => {
    const harness = mkDeps();
    const { capture, snapshots } = createSnapshots(harness.deps);

    await capture("cu_1", ["todo_missing"]);

    expect(snapshots.list()).toEqual([]);
    expect(await snapshots.get("todo_missing")).toBeNull();
  });

  it("retries a previously-missing row on a later pass", async () => {
    const harness = mkDeps();
    const { capture, snapshots } = createSnapshots(harness.deps);

    await capture("cu_1", ["todo_1"]);
    harness.read.mockResolvedValue(mkEntity("todo_1", "appeared"));
    await capture("cu_2", ["todo_1"]);

    expect(await snapshots.get("todo_1")).not.toBeNull();
  });

  it("captures afresh on a later pass instead of reusing the first capture", async () => {
    const first = mkEntity("todo_1", "before");
    const second = mkEntity("todo_1", "after");
    const harness = mkDeps({ todo_1: first });
    const { capture, readPass, snapshots } = createSnapshots(harness.deps);

    await capture("cu_1", ["todo_1"]);
    harness.read.mockResolvedValue(second);
    await capture("cu_2", ["todo_1"]);

    // Each pass keeps its own row; the public read stays session-first,
    // so a reconnect does not overlay the backup row.
    expect(harness.read).toHaveBeenCalledTimes(2);
    expect(readPass("cu_1", "todo_1")).toBe(first);
    expect(readPass("cu_2", "todo_1")).toBe(second);
    expect(await snapshots.get("todo_1")).toBe(first);
  });

  it("lets the first capture within a pass win", async () => {
    const first = mkEntity("todo_1", "before");
    const harness = mkDeps({ todo_1: first });
    const { capture, readPass } = createSnapshots(harness.deps);

    await capture("cu_1", ["todo_1"]);
    harness.read.mockResolvedValue(mkEntity("todo_1", "overlay"));
    await capture("cu_1", ["todo_1"]);

    expect(harness.read).toHaveBeenCalledTimes(1);
    expect(readPass("cu_1", "todo_1")).toBe(first);
  });

  it("returns null from a pass-keyed read with no capture", async () => {
    const harness = mkDeps({ todo_1: mkEntity("todo_1", "a") });
    const { capture, readPass } = createSnapshots(harness.deps);
    await capture("cu_1", ["todo_1"]);

    expect(readPass("cu_other", "todo_1")).toBeNull();
    expect(readPass("cu_1", "todo_missing")).toBeNull();
  });

  it("releases one capture without touching the others", async () => {
    const harness = mkDeps({ todo_1: mkEntity("todo_1", "a"), todo_2: mkEntity("todo_2", "b") });
    const { capture, snapshots } = createSnapshots(harness.deps);
    await capture("cu_1", ["todo_1", "todo_2"]);

    snapshots.release("todo_1");

    expect(snapshots.list()).toEqual(["todo_2"]);
    expect(await snapshots.get("todo_1")).toBeNull();
    expect(await snapshots.get("todo_2")).not.toBeNull();
  });

  it("release drops an entity across every pass", async () => {
    const harness = mkDeps({ todo_1: mkEntity("todo_1", "a") });
    const { capture, readPass, snapshots } = createSnapshots(harness.deps);
    await capture("cu_1", ["todo_1"]);
    await capture("cu_2", ["todo_1"]);

    snapshots.release("todo_1");

    expect(readPass("cu_1", "todo_1")).toBeNull();
    expect(readPass("cu_2", "todo_1")).toBeNull();
    expect(await snapshots.get("todo_1")).toBeNull();
    expect(snapshots.list()).toEqual([]);
  });

  it("clears every capture across passes", async () => {
    const harness = mkDeps({ todo_1: mkEntity("todo_1", "a") });
    const { capture, readPass, snapshots } = createSnapshots(harness.deps);
    await capture("cu_1", ["todo_1"]);
    await capture("cu_2", ["todo_1"]);

    snapshots.clear();

    expect(snapshots.list()).toEqual([]);
    expect(readPass("cu_1", "todo_1")).toBeNull();
    expect(readPass("cu_2", "todo_1")).toBeNull();
    expect(await snapshots.get("todo_1")).toBeNull();
  });

  it("releases a batch of captures", async () => {
    const harness = mkDeps({ todo_1: mkEntity("todo_1", "a"), todo_2: mkEntity("todo_2", "b") });
    const { capture, releaseMany, snapshots } = createSnapshots(harness.deps);
    await capture("cu_1", ["todo_1", "todo_2"]);

    releaseMany(["todo_1", "todo_2"]);

    expect(snapshots.list()).toEqual([]);
  });
});
