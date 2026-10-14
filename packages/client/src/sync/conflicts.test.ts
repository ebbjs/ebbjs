/**
 * Unit tests for the Conflicts view.
 *
 * The view projects the outbox's `conflicted` rows into entity-level
 * {@link Conflict}s, keeps a synchronous count for #125, notifies
 * `onChange` without polling, and turns the application's `retry` /
 * `discard` decision into the outbox transition that decision implies.
 */

import { describe, it, expect, vi, type Mock } from "vitest";
import { makeHlc, type Action, type Entity, type FieldValue, type Update } from "@ebbjs/core";
import type { ConflictSlot, ConflictSubjectState, OutboxConflict } from "@ebbjs/storage/types";

import type { ConflictedOutboxEntry, OutboxCounts } from "./outbox";
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

/** One conflicted outbox row, keyed by its losing Action's id. */
const mkRow = (
  actionId: string,
  detectedAtHlc: string,
  overrides: {
    readonly conflictId?: string;
    readonly subjects?: readonly string[];
    readonly subjectStates?: readonly ConflictSubjectState[];
    readonly slots?: readonly ConflictSlot[];
    readonly action?: Action;
  } = {},
): ConflictedOutboxEntry => ({
  action: overrides.action ?? mkAction(actionId),
  status: "conflicted",
  enqueuedAtHlc: detectedAtHlc,
  basedOnGsn: 0,
  conflict: {
    subjects: overrides.subjects ?? ["todo_1"],
    subjectStates: overrides.subjectStates ?? [],
    slots: overrides.slots ?? [mkSlot()],
    catchUpId: "cu_1",
    conflictId: overrides.conflictId ?? `c_${actionId}`,
    detectedAtHlc,
  } satisfies OutboxConflict,
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
  retry: Mock;
  reMaterialize: Mock;
  stampAction: Mock;
}

const mkDeps = (initial: readonly ConflictedOutboxEntry[] = []): Harness => {
  const outbox = mkOutbox(initial);
  let tick = 0;
  const retry = vi.fn(async (originalId: string, _action: Action): Promise<void> => {
    // The real outbox replaces the conflicted row with the re-assert in one
    // write; the fake just drops it, which is the same visible transition.
    await outbox.clearConflict(originalId);
  });
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
    outbox,
    retry,
    reMaterialize,
    stampAction,
    deps: {
      outbox,
      retry,
      reMaterialize,
      stampAction,
      hlc: () => String(++tick),
      generateUpdateId: () => `u_fresh_${tick}`,
    },
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

  it("retry re-asserts the whole Action, freshly stamped, and removes the conflict", async () => {
    const harness = mkDeps([mkRow("act_local", "5")]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const result = await conflicts.resolve("c_act_local", "retry");

    expect(result).toEqual({ resolved: ["act_local"], failed: [] });
    expect(harness.retry).toHaveBeenCalledTimes(1);
    expect(harness.retry.mock.calls[0]?.[0]).toBe("act_local");
    const rebased = harness.retry.mock.calls[0]?.[1] as Action;
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

  it("retry re-asserts the fields the conflict did not name", async () => {
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
    const harness = mkDeps([mkRow("act_local", "5", { action, slots: [mkSlot()] })]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    await conflicts.resolve("c_act_local", "retry");

    const rebased = harness.retry.mock.calls[0]?.[1] as Action;
    expect(rebased.updates).toHaveLength(1);
    const fields = rebased.updates[0]?.data?.fields ?? {};
    expect(Object.keys(fields).sort()).toEqual(["completed", "title"]);
    // Both leaves are fresh, so the whole Action out-dates the peer.
    expect(fields.title?.update_id).not.toBe("u_local");
    expect(fields.completed?.update_id).not.toBe("u_local");
    expect(fields.completed?.value).toBe(true);
  });

  it("retry re-stamps every key of a map field, not only the losing one", async () => {
    const action: Action = {
      id: "act_local",
      actor_id: "actor_1",
      hlc: LOCAL_HLC,
      gsn: 0,
      updates: [
        {
          id: "u_local",
          subject_id: "doc_1",
          subject_type: "doc",
          method: "patch",
          data: {
            fields: {
              content: {
                map: {
                  a: { value: "mine", update_id: "u_local", hlc: LOCAL_HLC },
                  b: { value: "keep", update_id: "u_local", hlc: LOCAL_HLC },
                },
              },
            },
          },
        },
      ],
    };
    const conflictSlot = mkSlot({
      subjectId: "doc_1",
      field: "content",
      path: ["a"],
    });
    const harness = mkDeps([
      mkRow("act_local", "5", { action, slots: [conflictSlot], subjects: ["doc_1"] }),
    ]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    await conflicts.resolve("c_act_local", "retry");

    const rebased = harness.retry.mock.calls[0]?.[1] as Action;
    const content = rebased.updates[0]?.data?.fields.content;
    if (content === undefined || !("map" in content)) throw new Error("expected a map field");
    expect(Object.keys(content.map).sort()).toEqual(["a", "b"]);
    expect(content.map.a?.update_id).not.toBe("u_local");
    expect(content.map.b?.update_id).not.toBe("u_local");
    expect(content.map.b?.value).toBe("keep");
  });

  it("discard re-materializes from the log and removes the conflict", async () => {
    const row = mkRow("act_local", "5");
    const harness = mkDeps([row]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const result = await conflicts.resolve("c_act_local", "discard");

    expect(result).toEqual({ resolved: ["act_local"], failed: [] });
    expect(harness.reMaterialize).toHaveBeenCalledWith(row.action);
    expect(harness.retry).not.toHaveBeenCalled();
    expect(harness.outbox.rows).toEqual([]);
    expect(conflicts.count()).toBe(0);
  });

  it("resolve of an unknown conflict id is an empty no-op", async () => {
    const harness = mkDeps();
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    expect(await conflicts.resolve("c_missing", "retry")).toEqual({ resolved: [], failed: [] });

    expect(harness.retry).not.toHaveBeenCalled();
    expect(harness.reMaterialize).not.toHaveBeenCalled();
  });

  it("reports a failed entry and leaves it resolvable under the same conflictId", async () => {
    const harness = mkDeps([mkRow("act_local", "5")]);
    const error = new Error("outbox unavailable");
    harness.retry.mockRejectedValueOnce(error);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const result = await conflicts.resolve("c_act_local", "retry");

    expect(result.resolved).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.entryId).toBe("act_local");
    expect(result.failed[0]?.error).toBe(error);
    expect(harness.outbox.rows.map((row) => row.action.id)).toEqual(["act_local"]);
    expect((await conflicts.list())[0]?.id).toBe("c_act_local");
  });

  it("resolves the entries after a failure without rolling back, under the same conflictId", async () => {
    const harness = mkDeps([
      mkRow("act_a", "1", { conflictId: "c_shared" }),
      mkRow("act_b", "2", { conflictId: "c_shared" }),
    ]);
    harness.retry.mockRejectedValueOnce(new Error("first failed"));
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const result = await conflicts.resolve("c_shared", "retry");

    expect(result.resolved).toEqual(["act_b"]);
    expect(result.failed.map((failure) => failure.entryId)).toEqual(["act_a"]);
    const list = await conflicts.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("c_shared");
    expect(list[0]?.entries.map((entry) => entry.action.id)).toEqual(["act_a"]);
  });

  it("resolveEntries is the per-entry primitive and skips unknown ids", async () => {
    const harness = mkDeps([
      mkRow("act_a", "1", { conflictId: "c_shared" }),
      mkRow("act_b", "2", { conflictId: "c_shared" }),
    ]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();

    const result = await conflicts.resolveEntries(["act_b", "act_missing"], "discard");

    expect(result).toEqual({ resolved: ["act_b"], failed: [] });
    expect(harness.reMaterialize).toHaveBeenCalledTimes(1);
    expect(harness.outbox.rows.map((row) => row.action.id)).toEqual(["act_a"]);
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

describe("Conflict.subjectStates", () => {
  /** Project one row carrying a single subject's states into its conflict. */
  const conflictForState = async (
    state: ConflictSubjectState,
    slots: readonly ConflictSlot[] = [],
  ) => {
    const harness = mkDeps([
      mkRow("act_local", "1", { slots, subjectStates: [state], subjects: [state.subjectId] }),
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

  it("exposes a non-empty diff for an entity-scope conflict with empty slots", async () => {
    const before = mkEntity("doc_1", { content: { map: { a: leaf("mine") } } });
    const after = mkEntity("doc_1", { content: { map: { b: leaf("theirs", "u_peer") } } });

    const conflict = await conflictForState(mkState("doc_1", before, after), []);

    expect(conflict.entries[0]?.slots).toEqual([]);
    expect(conflict.remoteWins()).toBe(false);
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

  it("leaves subjects, entries, remoteWins, and resolution unchanged when states are present", async () => {
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
    expect(conflict?.remoteWins()).toBe(false);

    const result = await conflicts.resolve("c_shared", "retry");
    expect(result.resolved).toEqual(["act_a", "act_b"]);
    expect(harness.retry).toHaveBeenCalledTimes(2);
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

describe("remoteWins", () => {
  /** Read the single projected slot's verdict for one row. */
  const verdict = async (slot: ConflictSlot): Promise<boolean> => {
    const harness = mkDeps([mkRow("act_local", "1", { slots: [slot] })]);
    const { conflicts } = createConflicts(harness.deps);
    await conflicts.rehydrate();
    const [conflict] = await conflicts.list();
    return conflict?.entries[0]?.slots[0]?.remoteWins() ?? false;
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

  it("aggregates over entries and is false for a conflict with no slots", async () => {
    const losing = mkDeps([
      mkRow("act_a", "1", {
        slots: [mkSlot({ remote: { value: "theirs", update_id: "u_peer", hlc: PEER_HLC } })],
      }),
    ]);
    const { conflicts: losingConflicts } = createConflicts(losing.deps);
    await losingConflicts.rehydrate();
    expect((await losingConflicts.list())[0]?.remoteWins()).toBe(true);

    const empty = mkDeps([mkRow("act_b", "1", { slots: [] })]);
    const { conflicts: emptyConflicts } = createConflicts(empty.deps);
    await emptyConflicts.rehydrate();
    expect((await emptyConflicts.list())[0]?.remoteWins()).toBe(false);
  });
});

describe("createConflicts observable", () => {
  it("publishes the conflict set on the initial load, a detection, and a resolution", async () => {
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

    await conflicts.resolve("c_act_a", "discard");
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
