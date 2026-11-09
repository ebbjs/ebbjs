/**
 * Unit tests for the Conflicts view.
 *
 * The view projects the outbox's `conflicted` rows into entity-level
 * {@link Conflict}s, keeps a synchronous count for #125, notifies
 * `onChange` without polling, and turns the application's choice into one
 * of the two mechanism verbs: send the held Actions unchanged, or clear
 * them and converge on the remote view.
 */

import { describe, it, expect, vi, type Mock } from "vitest";
import { makeHlc, type Action, type Entity, type FieldValue } from "@ebbjs/core";
import type {
  ConflictRemoteAction,
  ConflictSlot,
  ConflictSubjectState,
  OutboxConflict,
} from "@ebbjs/storage/types";

import type { ConflictedOutboxEntry, OutboxCounts, OutboxEntry } from "./outbox";
import { createConflicts, findPreSyncRow, type ConflictsDependencies } from "./conflicts";

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

/** A leaf field value at the local HLC unless overridden. */
const leaf = (value: unknown, updateId = "u_local", hlc = LOCAL_HLC): FieldValue => ({
  value,
  update_id: updateId,
  hlc,
});

/** A materialized entity row for one subject. */
const mkEntity = (id: string, fields: Record<string, FieldValue>): Entity => ({
  id,
  type: "todo",
  data: { fields },
  created_hlc: LOCAL_HLC,
  updated_hlc: LOCAL_HLC,
  deleted_hlc: null,
  last_gsn: 1,
});

/** The before/after rows for one losing subject. */
const mkState = (
  subjectId: string,
  before: Entity | null,
  after: Entity | null,
): ConflictSubjectState => ({ subjectId, subjectType: "todo", before, after });

/** The default contested `title` slot. */
const mkSlot = (overrides: Partial<ConflictSlot> = {}): ConflictSlot => ({
  subjectId: "todo_1",
  field: "title",
  path: [],
  local: { value: "mine", update_id: "u_local", hlc: LOCAL_HLC },
  remote: { value: "theirs", update_id: "u_peer", hlc: PEER_HLC },
  ...overrides,
});

/** One conflated missed Action reference. */
const mkRemote = (actionId: string, gsn = 9): ConflictRemoteAction => ({
  actorId: "actor_peer",
  actionId,
  gsn,
});

/** One conflicted outbox row, keyed by its losing Action's id. */
const mkRow = (
  actionId: string,
  detectedAtHlc: string,
  overrides: {
    readonly conflictId?: string;
    readonly subjects?: readonly string[];
    readonly subjectStates?: readonly ConflictSubjectState[];
    readonly slots?: readonly ConflictSlot[];
    readonly scope?: "field" | "entity";
    readonly remoteActions?: readonly ConflictRemoteAction[];
    readonly action?: Action;
  } = {},
): ConflictedOutboxEntry => ({
  action: overrides.action ?? mkAction(actionId),
  status: "conflicted",
  enqueuedAtHlc: detectedAtHlc,
  basedOnGsn: 0,
  conflict: {
    scope: overrides.scope ?? "field",
    subjects: overrides.subjects ?? ["todo_1"],
    subjectStates: overrides.subjectStates ?? [],
    slots: overrides.slots ?? [mkSlot()],
    remoteActions: overrides.remoteActions ?? [mkRemote("act_peer")],
    catchUpId: "cu_1",
    conflictId: overrides.conflictId ?? `c_${actionId}`,
    detectedAtHlc,
  } satisfies OutboxConflict,
});

/** In-test outbox exposing only the seam the view reads and verbs through. */
const mkOutbox = (initial: readonly ConflictedOutboxEntry[] = []) => {
  let rows: readonly ConflictedOutboxEntry[] = initial.map((row) => structuredClone(row));
  const listeners = new Set<(counts: OutboxCounts) => void>();
  const released: string[] = [];

  const counts = (): OutboxCounts => ({
    pending: 0,
    acknowledged: 0,
    error: 0,
    conflicted: rows.length,
  });
  const emit = (): void => {
    for (const listener of listeners) listener(counts());
  };
  const releaseConflict = vi.fn(async (actionId: string): Promise<void> => {
    if (!rows.some((row) => row.action.id === actionId)) return;
    released.push(actionId);
    rows = rows.filter((row) => row.action.id !== actionId);
    emit();
  });
  const heldPending = vi.fn((_subjects: readonly string[]): readonly OutboxEntry[] => []);
  const dropHeld = vi.fn(async (_actionIds: readonly string[]): Promise<readonly Action[]> => []);

  return {
    releaseConflict,
    heldPending,
    dropHeld,
    get rows(): readonly ConflictedOutboxEntry[] {
      return rows;
    },
    get released(): readonly string[] {
      return released;
    },
    conflicts: (): readonly ConflictedOutboxEntry[] => rows.map((row) => structuredClone(row)),
    onChange: (listener: (counts: OutboxCounts) => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    rehydrate: async (): Promise<void> => {},
    clearConflict: vi.fn(async (actionId: string): Promise<void> => {
      rows = rows.filter((row) => row.action.id !== actionId);
      emit();
    }),
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
  reMaterialize: Mock;
  flush: Mock;
  heldPending: Mock;
  dropHeld: Mock;
}

const mkDeps = (initial: readonly ConflictedOutboxEntry[] = []): Harness => {
  const outbox = mkOutbox(initial);
  const reMaterialize = vi.fn(async (_action: Action): Promise<void> => {});
  const flush = vi.fn(async (): Promise<void> => {});
  return {
    outbox,
    reMaterialize,
    flush,
    heldPending: outbox.heldPending as Mock,
    dropHeld: outbox.dropHeld as Mock,
    deps: { outbox, reMaterialize, flush },
  };
};

describe("createConflicts", () => {
  it("projects the outbox's conflicted rows into entity-level conflicts and reports the count", async () => {
    const harness = mkDeps([mkRow("act_a", "1"), mkRow("act_b", "2")]);

    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    expect(conflicts.count()).toBe(2);
    const list = await conflicts.list();
    expect(list.map((conflict) => conflict.id)).toEqual(["c_act_a", "c_act_b"]);
    expect(list[0]?.entries.map((entry) => entry.action.id)).toEqual(["act_a"]);
    expect(list[0]?.subjects).toEqual(["todo_1"]);
    expect(list[0]?.entries[0]?.conflictId).toBe("c_act_a");
  });

  it("orders conflicts by their earliest detection HLC", async () => {
    const harness = mkDeps([mkRow("act_late", "99"), mkRow("act_early", "1")]);

    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    expect((await conflicts.list()).map((conflict) => conflict.id)).toEqual([
      "c_act_early",
      "c_act_late",
    ]);
  });

  it("groups entries sharing a conflictId, in detection order, with the union of subjects", async () => {
    const harness = mkDeps([
      mkRow("act_b", "2", { conflictId: "c_shared", subjects: ["todo_2"] }),
      mkRow("act_a", "1", { conflictId: "c_shared", subjects: ["todo_1"] }),
    ]);

    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const [conflict] = await conflicts.list();
    expect(await conflicts.list()).toHaveLength(1);
    expect(conflict?.id).toBe("c_shared");
    expect(conflict?.entries.map((entry) => entry.action.id)).toEqual(["act_a", "act_b"]);
    expect(conflict?.subjects).toEqual(["todo_1", "todo_2"]);
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

  it("sendLocalActions releases every held Action unchanged, then flushes once", async () => {
    const harness = mkDeps([
      mkRow("act_a", "1", { conflictId: "c_shared" }),
      mkRow("act_b", "2", { conflictId: "c_shared" }),
    ]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const result = await conflicts.sendLocalActions("c_shared");

    expect(result).toEqual({ resolved: ["act_a", "act_b"], failed: [] });
    // The view only names the row; the outbox keeps the Action verbatim.
    expect(harness.outbox.releaseConflict.mock.calls.map((call) => call[0])).toEqual([
      "act_a",
      "act_b",
    ]);
    // One flush after the whole group left the hold.
    expect(harness.flush).toHaveBeenCalledTimes(1);
    expect(harness.outbox.rows).toEqual([]);
    expect(conflicts.count()).toBe(0);
    expect(harness.reMaterialize).not.toHaveBeenCalled();
  });

  it("sendLocalActions does not touch the losing Action's envelope", async () => {
    const action = mkAction("act_local");
    const harness = mkDeps([mkRow("act_local", "5", { action })]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    await conflicts.sendLocalActions("c_act_local");

    // No re-stamping collaborator is even available: the view hands the
    // outbox only the id of the row whose Action it sends.
    expect(harness.outbox.releaseConflict).toHaveBeenCalledWith("act_local");
    expect(harness.outbox.released).toEqual(["act_local"]);
  });

  it("clearLocalActions drops exactly the writes snapshotted under the hold, then converges", async () => {
    const row = mkRow("act_local", "5");
    const harness = mkDeps([row]);
    const later: OutboxEntry = {
      action: mkAction("act_later"),
      status: "pending",
      enqueuedAtHlc: "6",
      basedOnGsn: 0,
    };
    harness.heldPending.mockReturnValueOnce([later]);
    harness.dropHeld.mockResolvedValueOnce([later.action]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const result = await conflicts.clearLocalActions("c_act_local");

    expect(result).toEqual({ resolved: ["act_local"], failed: [] });
    // Snapshot first, while the conflicted row still holds the subject; a
    // write made after the hold lifts is never named and so never dropped.
    expect(harness.heldPending).toHaveBeenCalledWith(["todo_1"]);
    expect(harness.dropHeld).toHaveBeenCalledWith(["act_later"]);
    expect(harness.reMaterialize.mock.calls.map((call) => call[0])).toEqual([
      row.action,
      later.action,
    ]);
    expect(harness.outbox.releaseConflict).not.toHaveBeenCalled();
    expect(harness.flush).not.toHaveBeenCalled();
    expect(harness.outbox.rows).toEqual([]);
    expect(conflicts.count()).toBe(0);
  });

  it("clearLocalActions drops nothing when an entry fails, so the held subject keeps its writes", async () => {
    const harness = mkDeps([mkRow("act_local", "5")]);
    harness.heldPending.mockReturnValueOnce([
      {
        action: mkAction("act_later"),
        status: "pending",
        enqueuedAtHlc: "6",
        basedOnGsn: 0,
      },
    ]);
    harness.outbox.clearConflict.mockRejectedValueOnce(new Error("store unavailable"));
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const result = await conflicts.clearLocalActions("c_act_local");

    expect(result.resolved).toEqual([]);
    expect(result.failed.map((failure) => failure.entryId)).toEqual(["act_local"]);
    expect(harness.dropHeld).not.toHaveBeenCalled();
    expect(harness.outbox.rows.map((row) => row.action.id)).toEqual(["act_local"]);
  });

  it("reads a pre-v10 conflicted row as field scope with no remote context", async () => {
    const legacy = mkRow("act_local", "1");
    const { scope: _scope, remoteActions: _remoteActions, ...rest } = legacy.conflict;
    const harness = mkDeps([{ ...legacy, conflict: rest as unknown as OutboxConflict }]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const [projected] = await conflicts.list();
    expect(projected?.scope).toBe("field");
    expect(projected?.remoteActions).toEqual([]);
    expect(projected?.entries[0]?.scope).toBe("field");
    expect(projected?.entries[0]?.slots).toHaveLength(1);
  });

  it("rejects when the send's final flush faults, after the rows moved", async () => {
    const harness = mkDeps([mkRow("act_local", "5")]);
    harness.flush.mockRejectedValueOnce(new Error("store fault"));
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    await expect(conflicts.sendLocalActions("c_act_local")).rejects.toThrow("store fault");

    // The release already committed: the row is pending, not conflicted.
    expect(harness.outbox.rows).toEqual([]);
    expect(harness.outbox.released).toEqual(["act_local"]);
  });

  it("rejects when a clear's drop faults, after the rows moved", async () => {
    const harness = mkDeps([mkRow("act_local", "5")]);
    harness.heldPending.mockReturnValueOnce([
      {
        action: mkAction("act_later"),
        status: "pending",
        enqueuedAtHlc: "6",
        basedOnGsn: 0,
      },
    ]);
    harness.dropHeld.mockRejectedValueOnce(new Error("drop fault"));
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    await expect(conflicts.clearLocalActions("c_act_local")).rejects.toThrow("drop fault");

    expect(harness.outbox.rows).toEqual([]);
  });

  it("on a partial clear, drops only the writes of the subjects that were released", async () => {
    const multi = (id: string, subjects: readonly string[]): Action => ({
      id,
      actor_id: "actor_1",
      hlc: LOCAL_HLC,
      gsn: 0,
      updates: subjects.map((subjectId) => ({
        id: `u_${id}_${subjectId}`,
        subject_id: subjectId,
        subject_type: "todo",
        method: "patch",
        data: { fields: {} },
      })),
    });
    const harness = mkDeps([
      mkRow("act_a", "1", {
        conflictId: "c_shared",
        subjects: ["todo_1", "todo_2"],
        action: multi("act_a", ["todo_1", "todo_2"]),
      }),
      mkRow("act_b", "2", {
        conflictId: "c_shared",
        subjects: ["todo_2", "todo_3"],
        action: multi("act_b", ["todo_2", "todo_3"]),
      }),
    ]);
    const toOne: OutboxEntry = {
      action: multi("act_one", ["todo_1"]),
      status: "pending",
      enqueuedAtHlc: "3",
      basedOnGsn: 0,
    };
    const toThree: OutboxEntry = {
      action: multi("act_three", ["todo_3"]),
      status: "pending",
      enqueuedAtHlc: "4",
      basedOnGsn: 0,
    };
    harness.heldPending.mockReturnValueOnce([toOne, toThree]);
    // The first entry's clear fails; its subject stays held. The second
    // resolves, releasing `todo_3` only.
    harness.outbox.clearConflict.mockRejectedValueOnce(new Error("store unavailable"));
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const result = await conflicts.clearLocalActions("c_shared");

    expect(result.resolved).toEqual(["act_b"]);
    expect(result.failed.map((failure) => failure.entryId)).toEqual(["act_a"]);
    // `todo_1` is still held by the failed entry; only the released
    // subject's blocked write is dropped.
    expect(harness.dropHeld).toHaveBeenCalledWith(["act_three"]);
  });

  it("a verb on an unknown conflict id is an empty no-op with no flush", async () => {
    const harness = mkDeps();
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    expect(await conflicts.sendLocalActions("c_missing")).toEqual({ resolved: [], failed: [] });
    expect(await conflicts.clearLocalActions("c_missing")).toEqual({ resolved: [], failed: [] });

    expect(harness.outbox.releaseConflict).not.toHaveBeenCalled();
    expect(harness.heldPending).not.toHaveBeenCalled();
    expect(harness.dropHeld).not.toHaveBeenCalled();
    expect(harness.reMaterialize).not.toHaveBeenCalled();
    expect(harness.flush).not.toHaveBeenCalled();
  });

  it("reports a failed entry and leaves it resolvable under the same conflictId", async () => {
    const harness = mkDeps([mkRow("act_local", "5")]);
    const error = new Error("outbox unavailable");
    harness.outbox.releaseConflict.mockRejectedValueOnce(error);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const result = await conflicts.sendLocalActions("c_act_local");

    expect(result.resolved).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.entryId).toBe("act_local");
    expect(result.failed[0]?.error).toBe(error);
    // A fully failed pass moves nothing, so there is nothing to flush.
    expect(harness.flush).not.toHaveBeenCalled();
    expect(harness.outbox.rows.map((row) => row.action.id)).toEqual(["act_local"]);
    expect((await conflicts.list())[0]?.id).toBe("c_act_local");
  });

  it("resolves the entries after a failure without rolling back, under the same conflictId", async () => {
    const harness = mkDeps([
      mkRow("act_a", "1", { conflictId: "c_shared" }),
      mkRow("act_b", "2", { conflictId: "c_shared" }),
    ]);
    harness.outbox.releaseConflict.mockRejectedValueOnce(new Error("first failed"));
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const result = await conflicts.sendLocalActions("c_shared");

    expect(result.resolved).toEqual(["act_b"]);
    expect(result.failed.map((failure) => failure.entryId)).toEqual(["act_a"]);
    expect(harness.flush).toHaveBeenCalledTimes(1);
    const list = await conflicts.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("c_shared");
    expect(list[0]?.entries.map((entry) => entry.action.id)).toEqual(["act_a"]);
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

describe("Conflict scope and report", () => {
  it("project a field-scope conflict's slots with their remoteWins verdicts", async () => {
    const harness = mkDeps([mkRow("act_local", "1")]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const [conflict] = await conflicts.list();

    expect(conflict?.scope).toBe("field");
    expect(conflict?.entries[0]?.scope).toBe("field");
    expect(conflict?.entries[0]?.slots).toHaveLength(1);
    expect(conflict?.entries[0]?.slots?.[0]?.remoteWins()).toBe(true);
  });

  it("makes slots absent for an entity-scope conflict and keeps the diff", async () => {
    const before = mkEntity("doc_1", { content: { map: { a: leaf("mine") } } });
    const after = mkEntity("doc_1", { content: { map: { b: leaf("theirs", "u_peer") } } });
    const harness = mkDeps([
      mkRow("act_local", "1", {
        scope: "entity",
        subjects: ["doc_1"],
        slots: [],
        subjectStates: [mkState("doc_1", before, after)],
      }),
    ]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const [conflict] = await conflicts.list();
    expect(conflict?.scope).toBe("entity");
    expect(conflict?.entries[0]?.scope).toBe("entity");
    // No position-level verdict to misread at entity scope.
    expect(conflict?.entries[0]?.slots).toBeUndefined();
    expect(conflict?.subjectStates[0]?.diff).toEqual([
      { field: "content", path: ["a"], before: "mine", after: undefined, kind: "removed" },
      { field: "content", path: ["b"], before: undefined, after: "theirs", kind: "added" },
    ]);
  });

  it("takes entity scope when any grouped entry declared it", async () => {
    const harness = mkDeps([
      mkRow("act_field", "1", { conflictId: "c_shared" }),
      mkRow("act_entity", "2", { conflictId: "c_shared", scope: "entity", slots: [] }),
    ]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const [conflict] = await conflicts.list();
    expect(conflict?.scope).toBe("entity");
    expect(conflict?.entries.map((entry) => entry.scope)).toEqual(["field", "entity"]);
  });

  it("unions remoteActions across entries, deduped by action id in window order", async () => {
    const harness = mkDeps([
      mkRow("act_a", "1", {
        conflictId: "c_shared",
        remoteActions: [mkRemote("act_peer_1", 7), mkRemote("act_peer_2", 8)],
      }),
      mkRow("act_b", "2", {
        conflictId: "c_shared",
        remoteActions: [mkRemote("act_peer_2", 8), mkRemote("act_peer_3", 9)],
      }),
    ]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const [conflict] = await conflicts.list();
    expect(conflict?.remoteActions).toEqual([
      mkRemote("act_peer_1", 7),
      mkRemote("act_peer_2", 8),
      mkRemote("act_peer_3", 9),
    ]);
    expect(conflict?.entries[0]?.remoteActions).toEqual([
      mkRemote("act_peer_1", 7),
      mkRemote("act_peer_2", 8),
    ]);
  });
});

describe("Conflict.subjectStates", () => {
  /** Project one row carrying a single subject's states into its conflict. */
  const conflictForState = async (
    state: ConflictSubjectState,
    slots: readonly ConflictSlot[] = [],
    scope: "field" | "entity" = "entity",
  ) => {
    const harness = mkDeps([
      mkRow("act_local", "1", {
        scope,
        slots,
        subjectStates: [state],
        subjects: [state.subjectId],
      }),
    ]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();
    const [conflict] = await conflicts.list();
    if (conflict === undefined) throw new Error("expected a conflict");
    return conflict;
  };

  it("projects changed, added, and removed positions, including nested map keys, in deterministic order", async () => {
    const before = mkEntity("todo_1", {
      title: leaf("mine"),
      notes: leaf("draft"),
      content: { map: { b: leaf("mine", "u_b"), a: leaf("keep", "u_a") } },
    });
    const after = mkEntity("todo_1", {
      title: leaf("theirs", "u_title"),
      completed: leaf(true, "u_done"),
      content: { map: { c: leaf("new", "u_c"), b: leaf("theirs", "u_b"), a: leaf("keep", "u_a") } },
    });

    const conflict = await conflictForState(mkState("todo_1", before, after));

    expect(conflict.subjectStates).toHaveLength(1);
    expect(conflict.subjectStates[0]?.diff).toEqual([
      { field: "completed", path: [], before: undefined, after: true, kind: "added" },
      { field: "content", path: ["b"], before: "mine", after: "theirs", kind: "changed" },
      { field: "content", path: ["c"], before: undefined, after: "new", kind: "added" },
      { field: "notes", path: [], before: "draft", after: undefined, kind: "removed" },
      { field: "title", path: [], before: "mine", after: "theirs", kind: "changed" },
    ]);
  });

  it("reports a map-vs-leaf kind divergence as one changed diff at that path", async () => {
    const before = mkEntity("doc_1", { content: { map: { a: leaf("mine") } } });
    const after = mkEntity("doc_1", { content: leaf("whole") });

    const conflict = await conflictForState(mkState("doc_1", before, after));

    expect(conflict.subjectStates[0]?.diff).toEqual([
      { field: "content", path: [], before: { a: "mine" }, after: "whole", kind: "changed" },
    ]);
  });

  it("reads a nested tombstone as a removed position, not a changed one", async () => {
    const before = mkEntity("doc_1", {
      content: { map: { a: leaf("mine"), b: leaf("keep") } },
    });
    const after = mkEntity("doc_1", {
      content: { map: { a: leaf(null, "u_peer"), b: leaf("keep") } },
    });

    const conflict = await conflictForState(mkState("doc_1", before, after));

    expect(conflict.subjectStates[0]?.diff).toEqual([
      { field: "content", path: ["a"], before: "mine", after: undefined, kind: "removed" },
    ]);
  });

  it("treats a null before as every after field added and a null after as every before field removed", async () => {
    const row = mkEntity("todo_1", { title: leaf("mine") });
    const advanced = mkEntity("todo_1", { title: leaf("theirs", "u_peer") });

    const created = await conflictForState(mkState("todo_1", null, advanced));
    expect(created.subjectStates[0]?.diff).toEqual([
      { field: "title", path: [], before: undefined, after: "theirs", kind: "added" },
    ]);

    const deleted = await conflictForState(mkState("todo_1", row, null));
    expect(deleted.subjectStates[0]?.diff).toEqual([
      { field: "title", path: [], before: "mine", after: undefined, kind: "removed" },
    ]);
  });

  it("exposes a non-empty diff for an entity-scope conflict with no slots", async () => {
    const before = mkEntity("doc_1", { content: { map: { a: leaf("mine") } } });
    const after = mkEntity("doc_1", { content: { map: { b: leaf("theirs", "u_peer") } } });

    const conflict = await conflictForState(mkState("doc_1", before, after), [], "entity");

    expect(conflict.scope).toBe("entity");
    expect(conflict.entries[0]?.slots).toBeUndefined();
    expect(conflict.subjectStates[0]?.diff).toEqual([
      { field: "content", path: ["a"], before: "mine", after: undefined, kind: "removed" },
      { field: "content", path: ["b"], before: undefined, after: "theirs", kind: "added" },
    ]);
  });

  it("dedupes a subject across losing entries, keeping the earliest before and latest after", async () => {
    const first = mkEntity("todo_1", { title: leaf("first") });
    const middle = mkEntity("todo_1", { title: leaf("middle") });
    const last = mkEntity("todo_1", { title: leaf("last") });
    const harness = mkDeps([
      mkRow("act_b", "2", {
        conflictId: "c_shared",
        subjectStates: [mkState("todo_1", middle, last)],
      }),
      mkRow("act_a", "1", {
        conflictId: "c_shared",
        subjectStates: [mkState("todo_1", first, middle)],
      }),
    ]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const [conflict] = await conflicts.list();

    expect(conflict?.subjects).toEqual(["todo_1"]);
    expect(conflict?.subjectStates).toHaveLength(1);
    expect(conflict?.subjectStates[0]?.before).toEqual(first);
    expect(conflict?.subjectStates[0]?.after).toEqual(last);
  });

  it("keeps subjectStates in the same order as subjects", async () => {
    const harness = mkDeps([
      mkRow("act_a", "1", {
        subjects: ["todo_2", "todo_1"],
        subjectStates: [
          mkState("todo_2", mkEntity("todo_2", { title: leaf("a") }), null),
          mkState("todo_1", mkEntity("todo_1", { title: leaf("b") }), null),
        ],
      }),
    ]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const [conflict] = await conflicts.list();

    expect(conflict?.subjects).toEqual(["todo_2", "todo_1"]);
    expect(conflict?.subjectStates.map((state) => state.subjectId)).toEqual(["todo_2", "todo_1"]);
  });

  it("leaves subjects, entries, and the verbs unchanged when states are present", async () => {
    const harness = mkDeps([
      mkRow("act_a", "1", {
        conflictId: "c_shared",
        subjects: ["todo_1", "todo_2"],
        slots: [],
        subjectStates: [
          mkState(
            "todo_1",
            mkEntity("todo_1", { title: leaf("mine") }),
            mkEntity("todo_1", { title: leaf("theirs", "u_peer") }),
          ),
          mkState(
            "todo_2",
            mkEntity("todo_2", { title: leaf("mine") }),
            mkEntity("todo_2", { title: leaf("theirs", "u_peer") }),
          ),
        ],
      }),
      mkRow("act_b", "2", { conflictId: "c_shared", subjects: [], subjectStates: [], slots: [] }),
    ]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const [conflict] = await conflicts.list();
    expect(conflict?.subjects).toEqual(["todo_1", "todo_2"]);
    expect(conflict?.entries.map((entry) => entry.action.id)).toEqual(["act_a", "act_b"]);

    const result = await conflicts.sendLocalActions("c_shared");
    expect(result.resolved).toEqual(["act_a", "act_b"]);
    expect(harness.outbox.releaseConflict).toHaveBeenCalledTimes(2);
  });
});

describe("findPreSyncRow", () => {
  it("returns the before row of the earliest conflict referencing the entity", async () => {
    const early = mkEntity("todo_1", { title: leaf("early") });
    const late = mkEntity("todo_1", { title: leaf("late") });
    const harness = mkDeps([
      mkRow("act_late", "99", {
        conflictId: "c_late",
        subjects: ["todo_1"],
        subjectStates: [mkState("todo_1", late, null)],
      }),
      mkRow("act_early", "1", {
        conflictId: "c_early",
        subjects: ["todo_1"],
        subjectStates: [mkState("todo_1", early, null)],
      }),
    ]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    expect(await findPreSyncRow(conflicts, "todo_1")).toEqual(early);
  });

  it("returns null when no conflict references the entity", async () => {
    const harness = mkDeps([
      mkRow("act_a", "1", {
        subjects: ["todo_2"],
        subjectStates: [mkState("todo_2", mkEntity("todo_2", { title: leaf("x") }), null)],
      }),
    ]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    expect(await findPreSyncRow(conflicts, "todo_1")).toBeNull();
  });

  it("returns null when the earliest conflict's before row is null", async () => {
    const harness = mkDeps([
      mkRow("act_a", "1", {
        subjects: ["todo_1"],
        subjectStates: [mkState("todo_1", null, mkEntity("todo_1", { title: leaf("merged") }))],
      }),
    ]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    expect(await findPreSyncRow(conflicts, "todo_1")).toBeNull();
  });
});

describe("ConflictSlotView.remoteWins", () => {
  /** Read the single projected slot's verdict for one row. */
  const verdict = async (slot: ConflictSlot): Promise<boolean> => {
    const harness = mkDeps([mkRow("act_local", "1", { slots: [slot] })]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();
    const [conflict] = await conflicts.list();
    return conflict?.entries[0]?.slots?.[0]?.remoteWins() ?? false;
  };

  it("treats an absent remote as a remote win", async () => {
    expect(await verdict(mkSlot({ remote: { value: undefined } }))).toBe(true);
  });

  it("treats a kind divergence as a remote win", async () => {
    // Local leaf, remote whole-field map.
    expect(await verdict(mkSlot({ remote: { value: { map: {} } } }))).toBe(true);
  });

  it("gives the lower remote HLC the loss", async () => {
    const remoteOlder = mkSlot({
      local: { value: "mine", update_id: "u_local", hlc: PEER_HLC },
      remote: { value: "theirs", update_id: "u_peer", hlc: LOCAL_HLC },
    });
    expect(await verdict(remoteOlder)).toBe(false);
  });

  it("gives the higher remote HLC the win", async () => {
    expect(
      await verdict(
        mkSlot({
          local: { value: "mine", update_id: "u_local", hlc: LOCAL_HLC },
          remote: { value: "theirs", update_id: "u_peer", hlc: PEER_HLC },
        }),
      ),
    ).toBe(true);
  });

  it("breaks an HLC tie toward the greater update_id", async () => {
    expect(
      await verdict(
        mkSlot({
          local: { value: "mine", update_id: "u_a", hlc: LOCAL_HLC },
          remote: { value: "theirs", update_id: "u_b", hlc: LOCAL_HLC },
        }),
      ),
    ).toBe(true);
    expect(
      await verdict(
        mkSlot({
          local: { value: "mine", update_id: "u_b", hlc: LOCAL_HLC },
          remote: { value: "theirs", update_id: "u_a", hlc: LOCAL_HLC },
        }),
      ),
    ).toBe(false);
  });
});

describe("createConflicts observable", () => {
  it("publishes the conflict set on the initial load, a detection, and a verb", async () => {
    const harness = mkDeps([mkRow("act_a", "1")]);
    const { conflicts, observable } = createConflicts(harness.deps);
    const listener = vi.fn();
    observable.subscribe(listener);

    expect(observable.get()).toEqual({ count: 0, conflicts: [] });

    await conflicts.rehydrate();
    expect(observable.get().count).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);

    harness.outbox.put(mkRow("act_b", "2"));
    expect(observable.get().count).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);

    await conflicts.clearLocalActions("c_act_a");
    expect(observable.get().count).toBe(1);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(observable.get().conflicts.map((conflict) => conflict.id)).toEqual(["c_act_b"]);
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
