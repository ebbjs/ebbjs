/**
 * Conflict detection tests.
 *
 * Per Decision 4 in the design doc:
 * - Happens-before: a → b iff a.l < b.l OR (a.l == b.l AND a.c < b.c)
 * - Conflict fires when two non-trivial field updates target the same run
 *   with concurrent HLCs.
 * - Non-trivial = field update with a non-null RunNode value (insert or
 *   extend). Tombstones (value: null) are NOT non-trivial.
 */

import { describe, expect, it } from "vitest";
import { pack, format, type Action, type HLCTimestamp } from "@ebbjs/core";
import { ConflictDetector, happensBefore, type Conflict } from "../conflict";
import { createDocState, makeRunId, type DocState, type RunNode } from "../tree";
import { applyActions, DEFAULT_DOC_SUBJECT_TYPE, formatRunFieldName } from "../wire";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeHlc = (ts: number, count = 0): HLCTimestamp => format(pack(BigInt(ts), BigInt(count)));

const makeRun = (ts: number, actorId: string, text: string, parentId: string): RunNode => {
  const hlc = makeHlc(ts);
  return { id: makeRunId(hlc, actorId), hlc, actorId, text, parentId, deleted: false };
};

/** Build a field-update Action for one run (insert or extend). */
const makeFieldAction = (run: RunNode, hlc: HLCTimestamp, actionIdSuffix = ""): Action => ({
  id: `act_${run.id}${actionIdSuffix}`,
  actor_id: run.actorId,
  hlc,
  gsn: 0,
  updates: [
    {
      id: `upd_${run.id}${actionIdSuffix}`,
      subject_id: "doc_xxx",
      subject_type: DEFAULT_DOC_SUBJECT_TYPE,
      method: "patch",
      data: {
        [formatRunFieldName(run.id)]: {
          value: run,
          update_id: `upd_${run.id}${actionIdSuffix}`,
          hlc,
        },
      },
    } as never,
  ],
});

/** Build a tombstone field-update Action. */
const makeTombstoneAction = (runId: string, hlc: HLCTimestamp): Action => ({
  id: `act_del_${runId}`,
  actor_id: "peer-A",
  hlc,
  gsn: 0,
  updates: [
    {
      id: `upd_del_${runId}`,
      subject_id: "doc_xxx",
      subject_type: DEFAULT_DOC_SUBJECT_TYPE,
      method: "patch",
      data: {
        [formatRunFieldName(runId)]: {
          value: null,
          update_id: `upd_del_${runId}`,
          hlc,
        },
      },
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
    const action = makeFieldAction(run, run.hlc);
    const pre = createDocState();
    const { state } = applyActions(pre, [action]);
    detector.observe(pre, state, [action], "peer-A");

    expect(detector.all()).toHaveLength(0);
  });

  it("sequential non-trivial field updates to the same run do not fire", () => {
    const detector = new ConflictDetector();
    const run = makeRun(1000, "peer-A", "hello", "ROOT");
    let pre: DocState = createDocState();

    // Insert first
    const insertAction = makeFieldAction(run, run.hlc);
    const r1 = applyActions(pre, [insertAction]);
    pre = r1.state;
    detector.observe(createDocState(), pre, [insertAction], "peer-A");

    // Then extend with a higher HLC — happens-before relation, no conflict
    const extended: RunNode = { ...run, text: "hello world", hlc: makeHlc(1005) };
    const extendAction = makeFieldAction(extended, makeHlc(1005));
    const r2 = applyActions(pre, [extendAction]);
    detector.observe(pre, r2.state, [extendAction], "peer-A");

    expect(detector.all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Detection: concurrent inserts to same parent
// ---------------------------------------------------------------------------

describe("ConflictDetector — concurrent inserts to same parent", () => {
  it("two concurrent field inserts with different run ids do NOT fire", () => {
    const detector = new ConflictDetector();
    const parent = makeRun(1000, "peer-A", "p", "ROOT");

    const x = makeRun(1001, "peer-A", "X", parent.id);
    const y = makeRun(1001, "peer-B", "Y", parent.id);
    const actX = makeFieldAction(x, x.hlc);
    const actY = makeFieldAction(y, y.hlc);

    const pre = createDocState();
    const { state: post } = applyActions(pre, [actX, actY]);
    detector.observe(pre, post, [actX, actY], "peer-B");

    // Different run ids → different fields → no conflict
    expect(detector.all()).toHaveLength(0);
  });

  it("two concurrent field updates to the same run fire a conflict", () => {
    const detector = new ConflictDetector();
    const run = makeRun(1000, "peer-A", "hello", "ROOT");

    let pre: DocState = createDocState();
    const r1 = applyActions(pre, [makeFieldAction(run, run.hlc)]);
    pre = r1.state;
    detector.observe(createDocState(), pre, [makeFieldAction(run, run.hlc)], "peer-A");

    // Two concurrent field updates to the same run with same HLC components
    const extA: RunNode = { ...run, text: "helloA", hlc: makeHlc(1005) };
    const extB: RunNode = { ...run, text: "helloB", hlc: makeHlc(1005) };
    const actA = makeFieldAction(extA, makeHlc(1005), "_A");
    const actB = makeFieldAction(extB, makeHlc(1005), "_B");

    const { state: post } = applyActions(pre, [actA, actB]);
    const newConflicts = detector.observe(pre, post, [actA, actB], "peer-B");

    expect(newConflicts).toHaveLength(1);
    expect(newConflicts[0]!.runId).toBe(run.id);
    expect(newConflicts[0]!.contributingActions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Detection: DELETE_RANGE doesn't trigger (tombstones are non-content-modifying)
// ---------------------------------------------------------------------------

describe("ConflictDetector — tombstone is not non-trivial", () => {
  it("two concurrent tombstones on the same run do NOT fire", () => {
    const detector = new ConflictDetector();
    const run = makeRun(1000, "peer-A", "hello world", "ROOT");

    let pre: DocState = createDocState();
    const r1 = applyActions(pre, [makeFieldAction(run, run.hlc)]);
    pre = r1.state;

    const delA = makeTombstoneAction(run.id, makeHlc(1005));
    const delB = makeTombstoneAction(run.id, makeHlc(1005));

    const { state: post } = applyActions(pre, [delA, delB]);
    detector.observe(pre, post, [delA, delB], "peer-B");

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
    const r1r = applyActions(pre, [
      makeFieldAction(run1, run1.hlc),
      makeFieldAction(run2, run2.hlc),
    ]);
    pre = r1r.state;
    detector.observe(
      createDocState(),
      pre,
      [makeFieldAction(run1, run1.hlc), makeFieldAction(run2, run2.hlc)],
      "peer-A",
    );

    // Two concurrent updates on run1 — one conflict
    const extA1: RunNode = { ...run1, text: "r1A", hlc: makeHlc(1005) };
    const extB1: RunNode = { ...run1, text: "r1B", hlc: makeHlc(1005) };
    const a1 = makeFieldAction(extA1, makeHlc(1005), "_a");
    const b1 = makeFieldAction(extB1, makeHlc(1005), "_b");

    // Two concurrent updates on run2 — one conflict
    const extA2: RunNode = { ...run2, text: "r2A", hlc: makeHlc(1006) };
    const extB2: RunNode = { ...run2, text: "r2B", hlc: makeHlc(1006) };
    const a2 = makeFieldAction(extA2, makeHlc(1006), "_a");
    const b2 = makeFieldAction(extB2, makeHlc(1006), "_b");

    const { state: post } = applyActions(pre, [a1, b1, a2, b2]);
    detector.observe(pre, post, [a1, b1, a2, b2], "peer-B");

    expect(detector.forRun(run1.id)).toHaveLength(1);
    expect(detector.forRun(run2.id)).toHaveLength(1);
    expect(detector.forRun("nonexistent")).toHaveLength(0);
  });

  it("since filters by timestamp", async () => {
    const detector = new ConflictDetector();
    const run = makeRun(1000, "peer-A", "r", "ROOT");
    let pre: DocState = createDocState();
    const r1 = applyActions(pre, [makeFieldAction(run, run.hlc)]);
    pre = r1.state;

    const ext1: RunNode = { ...run, text: "a", hlc: makeHlc(1005) };
    const ext2: RunNode = { ...run, text: "b", hlc: makeHlc(1005) };
    const a1 = makeFieldAction(ext1, makeHlc(1005), "_1");
    const a2 = makeFieldAction(ext2, makeHlc(1005), "_2");

    const beforeObserve = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    const { state: post } = applyActions(pre, [a1, a2]);
    detector.observe(pre, post, [a1, a2], "peer-B");

    expect(detector.since(beforeObserve)).toHaveLength(1);
  });

  it("clear removes all conflicts and resets state", () => {
    const detector = new ConflictDetector();
    const run = makeRun(1000, "peer-A", "r", "ROOT");
    let pre: DocState = createDocState();
    const r1 = applyActions(pre, [makeFieldAction(run, run.hlc)]);
    pre = r1.state;

    const ext1: RunNode = { ...run, text: "a", hlc: makeHlc(1005) };
    const ext2: RunNode = { ...run, text: "b", hlc: makeHlc(1005) };
    const a1 = makeFieldAction(ext1, makeHlc(1005), "_1");
    const a2 = makeFieldAction(ext2, makeHlc(1005), "_2");

    const { state: post } = applyActions(pre, [a1, a2]);
    detector.observe(pre, post, [a1, a2], "peer-B");
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
    const r1 = applyActions(pre, [makeFieldAction(run, run.hlc)]);
    pre = r1.state;

    const extA: RunNode = { ...run, text: "helloA", hlc: makeHlc(1005) };
    const extB: RunNode = { ...run, text: "helloB", hlc: makeHlc(1005) };
    const actA = makeFieldAction(extA, makeHlc(1005), "_A");
    const actB = makeFieldAction(extB, makeHlc(1005), "_B");

    const before = Date.now();
    const { state: post } = applyActions(pre, [actA, actB]);
    const newConflicts = detector.observe(pre, post, [actA, actB], "peer-B");

    expect(newConflicts).toHaveLength(1);
    const c: Conflict = newConflicts[0]!;
    expect(c.id).toMatch(/^conflict_/);
    expect(c.runId).toBe(run.id);
    expect(c.preMerge.text).toBe("hello");
    expect(c.contributingActions).toHaveLength(2);
    expect(c.contributingHlcs).toEqual([makeHlc(1005), makeHlc(1005)]);
    expect(c.detectedAt).toBeGreaterThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Self-replay (redelivered SSE action) must not fire a conflict against itself
// ---------------------------------------------------------------------------

describe("ConflictDetector — self-replay", () => {
  it("does not fire when the same Action is observed twice", () => {
    const detector = new ConflictDetector();
    const run = makeRun(1000, "peer-A", "hello", "ROOT");
    const action = makeFieldAction(run, run.hlc);

    const pre = createDocState();
    const r1 = applyActions(pre, [action]);
    const post = r1.state;

    // First receipt — no conflict.
    const first = detector.observe(pre, post, [action], "peer-A");
    expect(first).toHaveLength(0);

    // SSE can redeliver an action across reconnect / replay boundaries.
    // The lastAppliedByRun map remembers the HLC; happensBefore returns
    // 0 for equal HLCs, which without an action.id check would fire a
    // spurious "conflict against itself".
    const replayed = detector.observe(pre, post, [action], "peer-A");
    expect(replayed).toHaveLength(0);
    expect(detector.all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Wire format: the server nests user-entity fields under `data.fields`,
// not at the top level of `data`. The detector used to walk
// `update.data` directly, which missed the wrapper key and silently
// dropped every conflict. These tests lock the wrapped-shape behavior.
// ---------------------------------------------------------------------------

/** Build a wrapped-shape field-update Action (matches server wire format). */
const makeWrappedFieldAction = (run: RunNode, hlc: HLCTimestamp, actionIdSuffix = ""): Action => ({
  id: `act_w_${run.id}${actionIdSuffix}`,
  actor_id: run.actorId,
  hlc,
  gsn: 0,
  updates: [
    {
      id: `upd_w_${run.id}${actionIdSuffix}`,
      subject_id: "doc_xxx",
      subject_type: DEFAULT_DOC_SUBJECT_TYPE,
      method: "patch",
      data: {
        // NOTE: nested under `fields`, the shape the SSE connection
        // actually produces (see conflict.ts / wire.ts readRunFields).
        fields: {
          [formatRunFieldName(run.id)]: {
            value: run,
            update_id: `upd_w_${run.id}${actionIdSuffix}`,
            hlc,
          },
        },
      },
    } as never,
  ],
});

describe("ConflictDetector — server wire format (data.fields wrapped)", () => {
  it("two concurrent wrapped-shape field updates to the same run fire a conflict", () => {
    const detector = new ConflictDetector();
    const run = makeRun(1000, "peer-A", "hello", "ROOT");

    // Seed: first wrapped-shape insert.
    let pre: DocState = createDocState();
    const insertAction = makeWrappedFieldAction(run, run.hlc);
    const r1 = applyActions(pre, [insertAction]);
    pre = r1.state;
    detector.observe(createDocState(), pre, [insertAction], "peer-A");

    // Two concurrent wrapped-shape extensions to the same run.
    const extA: RunNode = { ...run, text: "helloA", hlc: makeHlc(1005) };
    const extB: RunNode = { ...run, text: "helloB", hlc: makeHlc(1005) };
    const actA = makeWrappedFieldAction(extA, makeHlc(1005), "_A");
    const actB = makeWrappedFieldAction(extB, makeHlc(1005), "_B");

    const { state: post } = applyActions(pre, [actA, actB]);
    const newConflicts = detector.observe(pre, post, [actA, actB], "peer-B");

    expect(newConflicts).toHaveLength(1);
    expect(newConflicts[0]!.runId).toBe(run.id);
  });

  it("sequential wrapped-shape field updates do not fire", () => {
    const detector = new ConflictDetector();
    const run = makeRun(1000, "peer-A", "hello", "ROOT");

    let pre: DocState = createDocState();
    const insertAction = makeWrappedFieldAction(run, run.hlc);
    const r1 = applyActions(pre, [insertAction]);
    pre = r1.state;
    detector.observe(createDocState(), pre, [insertAction], "peer-A");

    // Subsequent extension with a strictly later HLC → happens-before,
    // not concurrent, no conflict.
    const extended: RunNode = { ...run, text: "hello world", hlc: makeHlc(1010) };
    const extendAction = makeWrappedFieldAction(extended, makeHlc(1010));
    const { state: post } = applyActions(pre, [extendAction]);
    const newConflicts = detector.observe(pre, post, [extendAction], "peer-A");

    expect(newConflicts).toHaveLength(0);
  });
});
