/**
 * Unit tests for the Conflicts manager (#310).
 *
 * The manager owns the application-facing contract over a durable
 * `ConflictStore`: a synchronous count for #125, `onChange` notifications
 * without polling, and the two resolution side effects (`retry` rebases
 * and re-enqueues, `discard` re-materializes from the log).
 */

import { describe, it, expect, vi } from "vitest";
import { makeHlc, type Action, type Update } from "@ebbjs/core";
import type { ConflictEntry, ConflictStore } from "@ebbjs/storage/types";

import { createConflicts, type ConflictsDependencies } from "./conflicts";

const LOCAL_HLC = makeHlc(1_711_036_800_000);
const PEER_HLC = makeHlc(1_711_036_800_001);

const mkEntry = (actionId: string, detectedAtHlc: string): ConflictEntry => ({
  action: {
    id: actionId,
    actor_id: "actor_1",
    hlc: LOCAL_HLC,
    gsn: 0,
    updates: [
      {
        id: `u_${actionId}`,
        subject_id: "todo_1",
        subject_type: "todo",
        method: "patch",
        data: {
          fields: { title: { value: "mine", update_id: `u_${actionId}`, hlc: LOCAL_HLC } },
        },
      },
    ],
  },
  winners: { title: { update_id: "u_peer", hlc: PEER_HLC, value: "theirs" } },
  fields: ["title"],
  detectedAtHlc,
});

const mkStore = (
  initial: readonly ConflictEntry[] = [],
): ConflictStore & { rows: Map<string, ConflictEntry> } => {
  const rows = new Map(initial.map((entry) => [entry.action.id, structuredClone(entry)]));
  return {
    rows,
    async put(entry: ConflictEntry): Promise<void> {
      rows.set(entry.action.id, structuredClone(entry));
    },
    async list(): Promise<readonly ConflictEntry[]> {
      return [...rows.values()]
        .map((entry) => structuredClone(entry))
        .sort((a, b) => a.detectedAtHlc.localeCompare(b.detectedAtHlc));
    },
    async get(actionId: string): Promise<ConflictEntry | null> {
      const row = rows.get(actionId);
      return row === undefined ? null : structuredClone(row);
    },
    async delete(actionId: string): Promise<void> {
      rows.delete(actionId);
    },
    async clear(): Promise<void> {
      rows.clear();
    },
  };
};

interface Harness {
  deps: ConflictsDependencies;
  store: ReturnType<typeof mkStore>;
  requeue: ReturnType<typeof vi.fn>;
  reMaterialize: ReturnType<typeof vi.fn>;
  stampAction: ReturnType<typeof vi.fn>;
}

const mkDeps = (store: ReturnType<typeof mkStore> = mkStore()): Harness => {
  let tick = 0;
  const requeue = vi.fn(async (_action: Action): Promise<void> => {});
  const reMaterialize = vi.fn(async (_action: Action): Promise<void> => {});
  const stampAction = vi.fn(
    (updates: readonly Update[]): Action => ({
      id: "act_rebased",
      actor_id: "actor_1",
      hlc: makeHlc(1_711_036_800_010),
      gsn: 0,
      updates: [...updates],
    }),
  );
  return {
    store,
    requeue,
    reMaterialize,
    stampAction,
    deps: {
      store,
      requeue,
      reMaterialize,
      stampAction,
      hlc: () => String(++tick),
      generateUpdateId: () => `u_fresh_${tick}`,
    },
  };
};

describe("createConflicts", () => {
  it("loads persisted conflicts and reports the count", async () => {
    const store = mkStore([mkEntry("act_a", "1"), mkEntry("act_b", "2")]);
    const { deps } = mkDeps(store);

    const { conflicts } = createConflicts(deps);
    await conflicts.rehydrate();

    expect(conflicts.count()).toBe(2);
    expect((await conflicts.list()).map((entry) => entry.action.id)).toEqual(["act_a", "act_b"]);
  });

  it("fires onChange for the initial load and for a detection written through the store view", async () => {
    const store = mkStore([mkEntry("act_a", "1")]);
    const { deps } = mkDeps(store);
    const { conflicts, store: view } = createConflicts(deps);
    const listener = vi.fn();
    conflicts.onChange(listener);

    await conflicts.rehydrate();
    expect(listener).toHaveBeenCalledTimes(1);

    await view.put(mkEntry("act_b", "2"));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(conflicts.count()).toBe(2);

    await view.delete("act_a");
    expect(listener).toHaveBeenCalledTimes(3);
    expect(conflicts.count()).toBe(1);
  });

  it("retry re-enqueues a fresh-stamped Action and removes the conflict", async () => {
    const store = mkStore([mkEntry("act_local", "5")]);
    const harness = mkDeps(store);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    await conflicts.resolve("act_local", "retry");

    expect(harness.requeue).toHaveBeenCalledTimes(1);
    const rebased = harness.requeue.mock.calls[0]?.[0] as Action;
    expect(rebased.id).toBe("act_rebased");
    expect(rebased.updates[0]?.method).toBe("patch");
    expect(rebased.updates[0]?.subject_id).toBe("todo_1");
    const field = rebased.updates[0]?.data?.fields.title;
    expect(field?.value).toBe("mine");
    expect(field?.update_id).not.toBe("u_act_local");
    expect(field?.hlc).toBe("1");

    expect(await store.get("act_local")).toBeNull();
    expect(conflicts.count()).toBe(0);
    expect(harness.reMaterialize).not.toHaveBeenCalled();
  });

  it("retry re-stamps only the conflicting fields", async () => {
    const entry: ConflictEntry = {
      action: {
        id: "act_local",
        actor_id: "actor_1",
        hlc: LOCAL_HLC,
        gsn: 0,
        updates: [
          {
            id: "u_local",
            subject_id: "todo_1",
            subject_type: "todo",
            method: "patch",
            data: {
              fields: {
                title: { value: "mine", update_id: "u_local", hlc: LOCAL_HLC },
                completed: { value: true, update_id: "u_local", hlc: LOCAL_HLC },
              },
            },
          },
        ],
      },
      winners: { title: { update_id: "u_peer", hlc: PEER_HLC, value: "theirs" } },
      fields: ["title"],
      detectedAtHlc: "5",
    };
    const store = mkStore([entry]);
    const harness = mkDeps(store);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    await conflicts.resolve("act_local", "retry");

    const rebased = harness.requeue.mock.calls[0]?.[0] as Action;
    expect(rebased.updates).toHaveLength(1);
    expect(rebased.updates[0]?.method).toBe("patch");
    expect(Object.keys(rebased.updates[0]?.data?.fields ?? {})).toEqual(["title"]);
    expect(rebased.updates[0]?.data?.fields.title?.value).toBe("mine");
  });

  it("discard re-materializes from the log and removes the conflict", async () => {
    const entry = mkEntry("act_local", "5");
    const store = mkStore([entry]);
    const harness = mkDeps(store);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    await conflicts.resolve("act_local", "discard");

    expect(harness.reMaterialize).toHaveBeenCalledWith(entry.action);
    expect(harness.requeue).not.toHaveBeenCalled();
    expect(await store.get("act_local")).toBeNull();
    expect(conflicts.count()).toBe(0);
  });

  it("ignores an unknown action id", async () => {
    const store = mkStore([]);
    const harness = mkDeps(store);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    await conflicts.resolve("act_missing", "retry");

    expect(harness.requeue).not.toHaveBeenCalled();
    expect(harness.reMaterialize).not.toHaveBeenCalled();
  });

  it("keeps the conflict resolvable when the retry re-enqueue fails", async () => {
    const store = mkStore([mkEntry("act_local", "5")]);
    const harness = mkDeps(store);
    harness.requeue.mockRejectedValueOnce(new Error("outbox unavailable"));
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    await expect(conflicts.resolve("act_local", "retry")).rejects.toThrow("outbox unavailable");

    expect(await store.get("act_local")).not.toBeNull();
    expect(conflicts.count()).toBe(1);
  });

  it("isolates a throwing onChange listener", async () => {
    const store = mkStore([]);
    const harness = mkDeps(store);
    const { conflicts } = createConflicts(harness.deps);
    const bad = vi.fn(() => {
      throw new Error("bad listener");
    });
    const good = vi.fn();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    conflicts.onChange(bad);
    conflicts.onChange(good);

    await conflicts.rehydrate();

    expect(good).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
