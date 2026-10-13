/**
 * Unit tests for the Conflicts view.
 *
 * The view projects the outbox's `conflicted` rows into the
 * application-facing `ConflictEntry` shape, keeps a synchronous count for
 * #125, notifies `onChange` without polling, and turns the application's
 * `retry` / `discard` decision into the outbox transition that decision
 * implies.
 */

import { describe, it, expect, vi, type Mock } from "vitest";
import { makeHlc, type Action, type Update } from "@ebbjs/core";
import type { OutboxConflict } from "@ebbjs/storage/types";

import type { ConflictedOutboxEntry, OutboxCounts } from "./outbox";
import { createConflicts, type ConflictsDependencies } from "./conflicts";

const LOCAL_HLC = makeHlc(1_711_036_800_000);
const PEER_HLC = makeHlc(1_711_036_800_001);

const mkAction = (actionId: string): Action => ({
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
});

const mkConflict = (actionId: string, detectedAtHlc: string): OutboxConflict => ({
  subjects: ["todo_1"],
  slots: [
    {
      subjectId: "todo_1",
      field: "title",
      path: [],
      local: { value: "mine", update_id: `u_${actionId}`, hlc: LOCAL_HLC },
      remote: { value: "theirs", update_id: "u_peer", hlc: PEER_HLC },
    },
  ],
  catchUpId: "cu_1",
  conflictId: `c_${actionId}`,
  detectedAtHlc,
});

/** One conflicted outbox row, keyed by its losing Action's id. */
const mkRow = (actionId: string, detectedAtHlc: string): ConflictedOutboxEntry => ({
  action: mkAction(actionId),
  status: "conflicted",
  enqueuedAtHlc: detectedAtHlc,
  basedOnGsn: 0,
  conflict: mkConflict(actionId, detectedAtHlc),
});

/** In-test outbox exposing only the seam the view reads and resolves through. */
const mkOutbox = (initial: readonly ConflictedOutboxEntry[] = []) => {
  let rows: readonly ConflictedOutboxEntry[] = initial.map((row) => structuredClone(row));
  const listeners = new Set<(counts: OutboxCounts) => void>();

  const counts = (): OutboxCounts => ({
    pending: 0,
    acknowledged: 0,
    error: 0,
    conflicted: rows.length,
  });
  const emit = (): void => {
    for (const listener of listeners) listener(counts());
  };

  return {
    get rows(): readonly ConflictedOutboxEntry[] {
      return rows;
    },
    conflicts: (): readonly ConflictedOutboxEntry[] => rows.map((row) => structuredClone(row)),
    onChange: (listener: (counts: OutboxCounts) => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    rehydrate: async (): Promise<void> => {},
    clearConflict: async (actionId: string): Promise<void> => {
      rows = rows.filter((row) => row.action.id !== actionId);
      emit();
    },
    /** Simulate a detection landing on the outbox. */
    put(row: ConflictedOutboxEntry): void {
      rows = [...rows.filter((candidate) => candidate.action.id !== row.action.id), row];
      emit();
    },
  };
};

interface Harness {
  deps: ConflictsDependencies;
  outbox: ReturnType<typeof mkOutbox>;
  requeue: Mock;
  reMaterialize: Mock;
  stampAction: Mock;
  releaseSubjects: Mock;
}

const mkDeps = (initial: readonly ConflictedOutboxEntry[] = []): Harness => {
  const outbox = mkOutbox(initial);
  let tick = 0;
  const requeue = vi.fn(async (_action: Action): Promise<void> => {});
  const reMaterialize = vi.fn(async (_action: Action): Promise<void> => {});
  const releaseSubjects = vi.fn((_subjectIds: readonly string[]): void => {});
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
    outbox,
    requeue,
    reMaterialize,
    stampAction,
    releaseSubjects,
    deps: {
      outbox,
      requeue,
      reMaterialize,
      releaseSubjects,
      stampAction,
      hlc: () => String(++tick),
      generateUpdateId: () => `u_fresh_${tick}`,
    },
  };
};

describe("createConflicts", () => {
  it("projects the outbox's conflicted rows and reports the count", async () => {
    const harness = mkDeps([mkRow("act_a", "1"), mkRow("act_b", "2")]);

    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    expect(conflicts.count()).toBe(2);
    expect((await conflicts.list()).map((entry) => entry.action.id)).toEqual(["act_a", "act_b"]);
    // The projection carries the persisted payload, not a copy of the row.
    expect((await conflicts.list())[0]?.conflictId).toBe("c_act_a");
    expect((await conflicts.list())[0]?.subjects).toEqual(["todo_1"]);
  });

  it("orders entries by detectedAtHlc, not outbox order", async () => {
    const harness = mkDeps([mkRow("act_late", "99"), mkRow("act_early", "1")]);

    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    expect((await conflicts.list()).map((entry) => entry.action.id)).toEqual([
      "act_early",
      "act_late",
    ]);
  });

  it("fires onChange for the initial load and for a detection written to the outbox", async () => {
    const harness = mkDeps([mkRow("act_a", "1")]);
    const { conflicts } = createConflicts(harness.deps);
    const listener = vi.fn();
    conflicts.onChange(listener);

    await conflicts.rehydrate();
    expect(listener).toHaveBeenCalledTimes(1);

    harness.outbox.put(mkRow("act_b", "2"));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(conflicts.count()).toBe(2);
  });

  it("retry re-enqueues a fresh-stamped Action and removes the conflict", async () => {
    const harness = mkDeps([mkRow("act_local", "5")]);
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

    expect(harness.outbox.rows).toEqual([]);
    expect(conflicts.count()).toBe(0);
    expect(harness.reMaterialize).not.toHaveBeenCalled();
  });

  it("retry re-stamps only the conflicting fields", async () => {
    const action: Action = {
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
    };
    const row: ConflictedOutboxEntry = {
      action,
      status: "conflicted",
      enqueuedAtHlc: "5",
      basedOnGsn: 0,
      conflict: {
        subjects: ["todo_1"],
        slots: [
          {
            subjectId: "todo_1",
            field: "title",
            path: [],
            local: { value: "mine", update_id: "u_local", hlc: LOCAL_HLC },
            remote: { value: "theirs", update_id: "u_peer", hlc: PEER_HLC },
          },
        ],
        catchUpId: "cu_1",
        conflictId: "c_act_local",
        detectedAtHlc: "5",
      },
    };
    const harness = mkDeps([row]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    await conflicts.resolve("act_local", "retry");

    const rebased = harness.requeue.mock.calls[0]?.[0] as Action;
    expect(rebased.updates).toHaveLength(1);
    expect(rebased.updates[0]?.method).toBe("patch");
    expect(Object.keys(rebased.updates[0]?.data?.fields ?? {})).toEqual(["title"]);
    expect(rebased.updates[0]?.data?.fields.title?.value).toBe("mine");
  });

  it("retry re-stamps only the losing map key", async () => {
    const action: Action = {
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
              content: {
                map: {
                  a: { value: "mine", update_id: "u_local", hlc: LOCAL_HLC },
                  b: { value: "sibling", update_id: "u_local", hlc: LOCAL_HLC },
                },
              },
            },
          },
        },
      ],
    };
    const row: ConflictedOutboxEntry = {
      action,
      status: "conflicted",
      enqueuedAtHlc: "5",
      basedOnGsn: 0,
      conflict: {
        subjects: ["todo_1"],
        slots: [
          {
            subjectId: "todo_1",
            field: "content",
            path: ["a"],
            local: { value: "mine", update_id: "u_local", hlc: LOCAL_HLC },
            remote: { value: "theirs", update_id: "u_peer", hlc: PEER_HLC },
          },
        ],
        catchUpId: "cu_1",
        conflictId: "c_act_local",
        detectedAtHlc: "5",
      },
    };
    const harness = mkDeps([row]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    await conflicts.resolve("act_local", "retry");

    const rebased = harness.requeue.mock.calls[0]?.[0] as Action;
    const content = rebased.updates[0]?.data?.fields.content;
    expect(content).toEqual({
      map: { a: { value: "mine", update_id: "u_fresh_0", hlc: "1" } },
    });
  });

  it("discard re-materializes from the log and removes the conflict", async () => {
    const row = mkRow("act_local", "5");
    const harness = mkDeps([row]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    await conflicts.resolve("act_local", "discard");

    expect(harness.reMaterialize).toHaveBeenCalledWith(row.action);
    expect(harness.requeue).not.toHaveBeenCalled();
    expect(harness.outbox.rows).toEqual([]);
    expect(conflicts.count()).toBe(0);
  });

  it("releases the resolved action's subjects once no conflict references them", async () => {
    const harness = mkDeps([mkRow("act_local", "5")]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    await conflicts.resolve("act_local", "discard");

    expect(harness.releaseSubjects).toHaveBeenCalledWith(["todo_1"]);
  });

  it("keeps a subject another conflict still references", async () => {
    const harness = mkDeps([mkRow("act_a", "1"), mkRow("act_b", "2")]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    await conflicts.resolve("act_a", "retry");

    expect(harness.releaseSubjects).not.toHaveBeenCalled();
  });

  it("ignores an unknown action id", async () => {
    const harness = mkDeps();
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    await conflicts.resolve("act_missing", "retry");

    expect(harness.requeue).not.toHaveBeenCalled();
    expect(harness.reMaterialize).not.toHaveBeenCalled();
  });

  it("keeps the conflict resolvable when the retry re-enqueue fails", async () => {
    const harness = mkDeps([mkRow("act_local", "5")]);
    harness.requeue.mockRejectedValueOnce(new Error("outbox unavailable"));
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    await expect(conflicts.resolve("act_local", "retry")).rejects.toThrow("outbox unavailable");

    expect(harness.outbox.rows.map((row) => row.action.id)).toEqual(["act_local"]);
    expect(conflicts.count()).toBe(1);
  });

  it("isolates a throwing onChange listener", async () => {
    const harness = mkDeps();
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

describe("createConflicts observable", () => {
  it("publishes the snapshot on the initial load, a detection, and a resolution", async () => {
    const harness = mkDeps([mkRow("act_a", "1")]);
    const { conflicts, observable } = createConflicts(harness.deps);
    const listener = vi.fn();
    observable.subscribe(listener);

    expect(observable.get()).toEqual({ count: 0, entries: [] });

    await conflicts.rehydrate();
    expect(observable.get().count).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);

    harness.outbox.put(mkRow("act_b", "2"));
    expect(observable.get().count).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);

    await conflicts.resolve("act_a", "discard");
    expect(observable.get().count).toBe(1);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(observable.get().entries.map((entry) => entry.action.id)).toEqual(["act_b"]);
  });

  it("keeps count in step with list().length", async () => {
    const harness = mkDeps([mkRow("act_a", "1"), mkRow("act_b", "2")]);
    const { conflicts, observable } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    expect(observable.get().count).toBe((await conflicts.list()).length);

    harness.outbox.put(mkRow("act_c", "3"));
    expect(observable.get().count).toBe((await conflicts.list()).length);
  });

  it("stops notifying after unsubscribe", async () => {
    const harness = mkDeps();
    const { observable } = createConflicts(harness.deps);
    const listener = vi.fn();
    observable.subscribe(listener)();

    harness.outbox.put(mkRow("act_a", "1"));

    expect(listener).not.toHaveBeenCalled();
    expect(observable.get().count).toBe(1);
  });

  it("isolates a throwing observable listener", async () => {
    const harness = mkDeps();
    const { observable } = createConflicts(harness.deps);
    const bad = vi.fn(() => {
      throw new Error("bad listener");
    });
    const good = vi.fn();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    observable.subscribe(bad);
    observable.subscribe(good);

    harness.outbox.put(mkRow("act_a", "1"));

    expect(good).toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
