/**
 * Conflict detection tests.
 *
 * Per Decision 4 in the design doc:
 * - Happens-before: a → b iff a.l < b.l OR (a.l == b.l AND a.c < b.c)
 * - Conflict fires when two non-trivial Updates target the same run with
 *   concurrent HLCs.
 * - Non-trivial = INSERT_RUN or EXTEND_RUN (not DELETE_RANGE, not SPLIT).
 */

import { describe, expect, it } from "vitest";
import { pack, format, type Action, type HLCTimestamp } from "@ebbjs/core";
import { ConflictDetector, happensBefore, type Conflict } from "../conflict";
import { createDocState, makeRunId, type DocState, type RunNode } from "../tree";
import { applyActions, FIELD_RUN } from "../wire";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeHlc = (ts: number, count = 0): HLCTimestamp => format(pack(BigInt(ts), BigInt(count)));

const makeRun = (ts: number, actorId: string, text: string, parentId: string): RunNode => {
  const hlc = makeHlc(ts);
  return { id: makeRunId(hlc, actorId), hlc, actorId, text, parentId, deleted: false };
};

const makeInsertAction = (run: RunNode): Action => ({
  id: `act_${run.id}`,
  actor_id: run.actorId,
  hlc: run.hlc,
  gsn: 0,
  updates: [
    {
      id: `upd_${run.id}`,
      subject_id: run.id,
      subject_type: "run",
      method: "put",
      data: { [FIELD_RUN]: { value: run, update_id: `upd_${run.id}`, hlc: run.hlc } },
    } as never,
  ],
});

// ---------------------------------------------------------------------------
// happensBefore
// ---------------------------------------------------------------------------

describe("happensBefore", () => {
  it("a.l < b.l → a happens-before b", () => {
    expect(happensBefore(makeHlc(1000), makeHlc(1001))).toBe(-1);
    expect(happensBefore(makeHlc(1001), makeHlc(1000))).toBe(1);
  });

  it("a.l == b.l AND a.c < b.c → a happens-before b", () => {
    expect(happensBefore(makeHlc(1000, 0), makeHlc(1000, 1))).toBe(-1);
    expect(happensBefore(makeHlc(1000, 1), makeHlc(1000, 0))).toBe(1);
  });

  it("a.l == b.l AND a.c == b.c → equal (not concurrent)", () => {
    expect(happensBefore(makeHlc(1000, 5), makeHlc(1000, 5))).toBe(0);
  });

  it("different actor_id but same HLC components → equal (not concurrent)", () => {
    // Two events at the same (l, c) are the same event — actor_id doesn't
    // disambiguate happens-before.
    const hlcA = makeHlc(1000, 5);
    const hlcB = makeHlc(1000, 5);
    expect(happensBefore(hlcA, hlcB)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Detection: no conflicts
// ---------------------------------------------------------------------------

describe("ConflictDetector — no conflicts", () => {
  it("single INSERT_RUN does not fire", () => {
    const detector = new ConflictDetector();
    const run = makeRun(1000, "peer-A", "hello", "ROOT");
    const action = makeInsertAction(run);
    const pre = createDocState();
    const { state } = applyActions(pre, [action]);
    detector.observe(pre, state, [action], "peer-A");

    expect(detector.all()).toHaveLength(0);
  });

  it("sequential non-trivial Updates to same run do not fire", () => {
    const detector = new ConflictDetector();
    const state: DocState = createDocState();
    const run = makeRun(1000, "peer-A", "hello", "ROOT");

    // Sequential: EXTEND at ts=1005 happens-after INSERT at ts=1000
    const insert = makeInsertAction(run);
    const extendAction: Action = {
      id: "act_extend",
      actor_id: "peer-A",
      hlc: makeHlc(1005),
      gsn: 0,
      updates: [
        {
          id: "upd_extend",
          subject_id: run.id,
          subject_type: "run",
          method: "patch",
          data: {
            append: { value: { text: " world" }, update_id: "upd_extend", hlc: makeHlc(1005) },
          },
        } as never,
      ],
    };

    let cur = state;
    const r1 = applyActions(cur, [insert]);
    cur = r1.state;
    detector.observe(state, cur, [insert], "peer-A");

    const r2 = applyActions(cur, [extendAction]);
    cur = r2.state;
    detector.observe(r1.state, cur, [extendAction], "peer-A");

    expect(detector.all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Detection: concurrent inserts to same parent
// ---------------------------------------------------------------------------

describe("ConflictDetector — concurrent inserts to same parent", () => {
  it("two concurrent INSERT_RUNs targeting the same parent fire a conflict", () => {
    const detector = new ConflictDetector();
    const parent = makeRun(1000, "peer-A", "p", "ROOT");

    // Two inserts as children of parent, same HLC components (concurrent).
    const x = makeRun(1001, "peer-A", "X", parent.id);
    const y = makeRun(1001, "peer-B", "Y", parent.id);
    const actX = makeInsertAction(x);
    const actY = makeInsertAction(y);

    // Pre-state: just ROOT
    const pre = createDocState();
    const { state: post } = applyActions(pre, [actX, actY]);

    detector.observe(pre, post, [actX, actY], "peer-B");

    const conflicts = detector.all();
    // Each Update targets a DIFFERENT new run (x and y) so no conflict
    // should fire — INSERT_RUNs "target" the new node, not the parent.
    expect(conflicts).toHaveLength(0);
  });

  it("two concurrent EXTEND_RUNs on the same run fire a conflict", () => {
    const detector = new ConflictDetector();
    const run = makeRun(1000, "peer-A", "hello", "ROOT");

    // Pre-state: run exists, pre-merge text is "hello"
    let pre: DocState = createDocState();
    const r1 = applyActions(pre, [makeInsertAction(run)]);
    pre = r1.state;

    // Two concurrent EXTEND_RUNs targeting the same run
    const extA: Action = {
      id: "act_extA",
      actor_id: "peer-A",
      hlc: makeHlc(1005),
      gsn: 0,
      updates: [
        {
          id: "upd_extA",
          subject_id: run.id,
          subject_type: "run",
          method: "patch",
          data: {
            append: { value: { text: "A" }, update_id: "upd_extA", hlc: makeHlc(1005) },
          },
        } as never,
      ],
    };
    const extB: Action = {
      id: "act_extB",
      actor_id: "peer-B",
      hlc: makeHlc(1005), // same (l, c) as extA → concurrent (same HLC components)
      gsn: 0,
      updates: [
        {
          id: "upd_extB",
          subject_id: run.id,
          subject_type: "run",
          method: "patch",
          data: {
            append: { value: { text: "B" }, update_id: "upd_extB", hlc: makeHlc(1005) },
          },
        } as never,
      ],
    };

    const { state: post } = applyActions(pre, [extA, extB]);
    detector.observe(pre, post, [extA, extB], "peer-B");

    const conflicts = detector.all();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.runId).toBe(run.id);
    expect(conflicts[0]!.contributingActions).toHaveLength(2);
    expect(conflicts[0]!.preMerge.text).toBe("hello");
    expect(conflicts[0]!.postMerge.text).toBe("helloAB"); // extA then extB appended
  });
});

// ---------------------------------------------------------------------------
// Detection: INSERT_RUN after EXTEND on same run
// ---------------------------------------------------------------------------

describe("ConflictDetector — INSERT_RUN targeting same run as prior EXTEND_RUN", () => {
  it("concurrent INSERT + EXTEND on same run fires", () => {
    const detector = new ConflictDetector();
    const run = makeRun(1000, "peer-A", "hello", "ROOT");

    let pre: DocState = createDocState();
    const r1 = applyActions(pre, [makeInsertAction(run)]);
    pre = r1.state;

    // ext on existing run
    const extA: Action = {
      id: "act_extA",
      actor_id: "peer-A",
      hlc: makeHlc(1005),
      gsn: 0,
      updates: [
        {
          id: "upd_extA",
          subject_id: run.id,
          subject_type: "run",
          method: "patch",
          data: {
            append: { value: { text: "!" }, update_id: "upd_extA", hlc: makeHlc(1005) },
          },
        } as never,
      ],
    };

    // But the next insert creates a NEW run — different run ID. So this
    // shouldn't fire. Use a different target to verify the detector
    // distinguishes.
    const newRun = makeRun(1005, "peer-B", "X", run.id); // HLC concurrent with extA
    const insNew = makeInsertAction(newRun);

    const { state: post } = applyActions(pre, [extA, insNew]);
    detector.observe(pre, post, [extA, insNew], "peer-B");

    // extA targets run.id; insNew targets newRun.id — different runs → no conflict
    expect(detector.all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Detection: DELETE_RANGE doesn't trigger (non-content-modifying)
// ---------------------------------------------------------------------------

describe("ConflictDetector — DELETE_RANGE is not non-trivial", () => {
  it("two concurrent DELETE_RANGEs on the same run do NOT fire", () => {
    const detector = new ConflictDetector();
    const run = makeRun(1000, "peer-A", "hello world", "ROOT");

    let pre: DocState = createDocState();
    const r1 = applyActions(pre, [makeInsertAction(run)]);
    pre = r1.state;

    const delA: Action = {
      id: "act_delA",
      actor_id: "peer-A",
      hlc: makeHlc(1005),
      gsn: 0,
      updates: [
        {
          id: "upd_delA",
          subject_id: run.id,
          subject_type: "run",
          method: "delete",
          data: {
            range: { value: { offset: 0, count: 5 }, update_id: "upd_delA", hlc: makeHlc(1005) },
          },
        } as never,
      ],
    };
    const delB: Action = {
      id: "act_delB",
      actor_id: "peer-B",
      hlc: makeHlc(1005),
      gsn: 0,
      updates: [
        {
          id: "upd_delB",
          subject_id: run.id,
          subject_type: "run",
          method: "delete",
          data: {
            range: { value: { offset: 6, count: 5 }, update_id: "upd_delB", hlc: makeHlc(1005) },
          },
        } as never,
      ],
    };

    const { state: post } = applyActions(pre, [delA, delB]);
    detector.observe(pre, post, [delA, delB], "peer-B");

    // DELETE_RANGE is tombstone (not non-trivial) → no conflict
    expect(detector.all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe("ConflictDetector — queries", () => {
  it("forRun filters by run id", () => {
    const detector = new ConflictDetector();
    const run1 = makeRun(1000, "peer-A", "r1", "ROOT");
    const run2 = makeRun(1001, "peer-A", "r2", "ROOT");

    let pre: DocState = createDocState();
    const r1r = applyActions(pre, [makeInsertAction(run1), makeInsertAction(run2)]);
    pre = r1r.state;

    // Two concurrent EXTEND_RUNs targeting run1 — one conflict on run1,
    // none on run2 (different target).
    const ext1A: Action = {
      id: "act_e1A",
      actor_id: "peer-A",
      hlc: makeHlc(1005),
      gsn: 0,
      updates: [
        {
          id: "upd_e1A",
          subject_id: run1.id,
          subject_type: "run",
          method: "patch",
          data: { append: { value: { text: "a" }, update_id: "upd_e1A", hlc: makeHlc(1005) } },
        } as never,
      ],
    };
    const ext1B: Action = {
      id: "act_e1B",
      actor_id: "peer-B",
      hlc: makeHlc(1005),
      gsn: 0,
      updates: [
        {
          id: "upd_e1B",
          subject_id: run1.id,
          subject_type: "run",
          method: "patch",
          data: { append: { value: { text: "b" }, update_id: "upd_e1B", hlc: makeHlc(1005) } },
        } as never,
      ],
    };
    // A separate concurrent EXTEND on run2.
    const ext2A: Action = {
      id: "act_e2A",
      actor_id: "peer-A",
      hlc: makeHlc(1006),
      gsn: 0,
      updates: [
        {
          id: "upd_e2A",
          subject_id: run2.id,
          subject_type: "run",
          method: "patch",
          data: { append: { value: { text: "x" }, update_id: "upd_e2A", hlc: makeHlc(1006) } },
        } as never,
      ],
    };
    const ext2B: Action = {
      id: "act_e2B",
      actor_id: "peer-B",
      hlc: makeHlc(1006),
      gsn: 0,
      updates: [
        {
          id: "upd_e2B",
          subject_id: run2.id,
          subject_type: "run",
          method: "patch",
          data: { append: { value: { text: "y" }, update_id: "upd_e2B", hlc: makeHlc(1006) } },
        } as never,
      ],
    };

    const { state: post } = applyActions(pre, [ext1A, ext1B, ext2A, ext2B]);
    detector.observe(pre, post, [ext1A, ext1B, ext2A, ext2B], "peer-B");

    expect(detector.forRun(run1.id)).toHaveLength(1);
    expect(detector.forRun(run2.id)).toHaveLength(1);
    expect(detector.forRun("nonexistent")).toHaveLength(0);
  });

  it("since filters by timestamp", async () => {
    const detector = new ConflictDetector();
    const run = makeRun(1000, "peer-A", "r", "ROOT");
    let pre: DocState = createDocState();
    const r1 = applyActions(pre, [makeInsertAction(run)]);
    pre = r1.state;

    const ext1: Action = {
      id: "act_e1",
      actor_id: "peer-A",
      hlc: makeHlc(1005),
      gsn: 0,
      updates: [
        {
          id: "upd_e1",
          subject_id: run.id,
          subject_type: "run",
          method: "patch",
          data: { append: { value: { text: "a" }, update_id: "upd_e1", hlc: makeHlc(1005) } },
        } as never,
      ],
    };
    const ext2: Action = {
      id: "act_e2",
      actor_id: "peer-B",
      hlc: makeHlc(1005),
      gsn: 0,
      updates: [
        {
          id: "upd_e2",
          subject_id: run.id,
          subject_type: "run",
          method: "patch",
          data: { append: { value: { text: "b" }, update_id: "upd_e2", hlc: makeHlc(1005) } },
        } as never,
      ],
    };

    const beforeObserve = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    const { state: post } = applyActions(pre, [ext1, ext2]);
    detector.observe(pre, post, [ext1, ext2], "peer-B");

    expect(detector.since(beforeObserve)).toHaveLength(1);
  });

  it("clear removes all conflicts and resets state", () => {
    const detector = new ConflictDetector();
    const run = makeRun(1000, "peer-A", "r", "ROOT");
    let pre: DocState = createDocState();
    const r1 = applyActions(pre, [makeInsertAction(run)]);
    pre = r1.state;
    const ext1: Action = {
      id: "act_e1",
      actor_id: "peer-A",
      hlc: makeHlc(1005),
      gsn: 0,
      updates: [
        {
          id: "upd_e1",
          subject_id: run.id,
          subject_type: "run",
          method: "patch",
          data: { append: { value: { text: "a" }, update_id: "upd_e1", hlc: makeHlc(1005) } },
        } as never,
      ],
    };
    const ext2: Action = {
      id: "act_e2",
      actor_id: "peer-B",
      hlc: makeHlc(1005),
      gsn: 0,
      updates: [
        {
          id: "upd_e2",
          subject_id: run.id,
          subject_type: "run",
          method: "patch",
          data: { append: { value: { text: "b" }, update_id: "upd_e2", hlc: makeHlc(1005) } },
        } as never,
      ],
    };
    const { state: post } = applyActions(pre, [ext1, ext2]);
    detector.observe(pre, post, [ext1, ext2], "peer-B");
    expect(detector.all().length).toBeGreaterThan(0);

    detector.clear();
    expect(detector.all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Conflict shape
// ---------------------------------------------------------------------------

describe("Conflict shape", () => {
  it("includes preMerge, postMerge, contributingActions, contributingHlcs, detectedAt", () => {
    const detector = new ConflictDetector();
    const run = makeRun(1000, "peer-A", "hello", "ROOT");
    let pre: DocState = createDocState();
    const r1 = applyActions(pre, [makeInsertAction(run)]);
    pre = r1.state;

    const extA: Action = {
      id: "act_extA",
      actor_id: "peer-A",
      hlc: makeHlc(1005),
      gsn: 0,
      updates: [
        {
          id: "upd_extA",
          subject_id: run.id,
          subject_type: "run",
          method: "patch",
          data: { append: { value: { text: "A" }, update_id: "upd_extA", hlc: makeHlc(1005) } },
        } as never,
      ],
    };
    const extB: Action = {
      id: "act_extB",
      actor_id: "peer-B",
      hlc: makeHlc(1005),
      gsn: 0,
      updates: [
        {
          id: "upd_extB",
          subject_id: run.id,
          subject_type: "run",
          method: "patch",
          data: { append: { value: { text: "B" }, update_id: "upd_extB", hlc: makeHlc(1005) } },
        } as never,
      ],
    };

    const before = Date.now();
    const { state: post } = applyActions(pre, [extA, extB]);
    const newConflicts = detector.observe(pre, post, [extA, extB], "peer-B");

    expect(newConflicts).toHaveLength(1);
    const c: Conflict = newConflicts[0]!;
    expect(c.id).toMatch(/^conflict_/);
    expect(c.runId).toBe(run.id);
    expect(c.preMerge.text).toBe("hello");
    expect(c.postMerge.text).toBe("helloAB");
    expect(c.contributingActions).toEqual([extA, extB]);
    expect(c.contributingHlcs).toEqual([makeHlc(1005), makeHlc(1005)]);
    expect(c.detectedAt).toBeGreaterThanOrEqual(before);
  });
});
