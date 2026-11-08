/**
 * Text module tests — immutable run cells, additive cut cells, one projection.
 *
 * The projection is deterministic by construction, so most assertions are
 * stated in cells and checked through `project()`: the same result in every
 * delivery order, exact text rather than replica equality, and deliberately
 * broken cell sets that show each property can actually fail.
 */

import { describe, expect, it } from "vitest";
import { format, pack, type HLCTimestamp } from "@ebbjs/core";
import {
  applyCellFields,
  compareRuns,
  createDocState,
  lookupPosition,
  makeCutId,
  makeRunId,
  parseRunId,
  project,
  reconstruct,
  ROOT_ID,
  runOffsetToPosition,
  type Anchor,
  type CellFieldValue,
  type CutCell,
  type DocState,
  type RunCell,
  type TextCell,
} from "@ebbjs/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a packed HLC string from synthetic (ts, count). */
const hlc = (ts: number, count = 0): HLCTimestamp => format(pack(BigInt(ts), BigInt(count)));

const run = (ts: number, actorId: string, text: string, anchor: Anchor, count = 0): RunCell => {
  const stamp = hlc(ts, count);
  return {
    kind: "run",
    id: makeRunId(stamp, actorId),
    text,
    author: actorId,
    stamp,
    anchor,
  };
};

const cut = (ts: number, actorId: string, runId: string, from: number, to: number): CutCell => {
  const stamp = hlc(ts);
  return {
    kind: "cut",
    id: makeCutId(stamp, actorId, runId, from, to),
    runId,
    from,
    to,
    author: actorId,
    stamp,
  };
};

const entry = (cell: TextCell): CellFieldValue => ({
  value: cell,
  update_id: `u_${cell.id}`,
  hlc: cell.stamp,
});

const cells = (...list: TextCell[]): Map<string, CellFieldValue> =>
  new Map(list.map((cell) => [cell.id, entry(cell)]));

const doc = (...list: TextCell[]): DocState => project(cells(...list));

const atRoot = (offset = 0): Anchor => ({ runId: ROOT_ID, offset });

// ---------------------------------------------------------------------------
// Cell ids and ordering
// ---------------------------------------------------------------------------

describe("cell ids", () => {
  it("encodes stamp and author for a run", () => {
    const stamp = hlc(1234, 5);
    expect(makeRunId(stamp, "peer-X")).toBe(`${stamp}:peer-X`);
  });

  it("round-trips a run id", () => {
    const stamp = hlc(9999);
    expect(parseRunId(makeRunId(stamp, "actor-42"))).toEqual({
      stamp,
      author: "actor-42",
    });
  });

  it("round-trips a run id that carries a per-write discriminator", () => {
    const stamp = hlc(1000);
    const id = makeRunId(stamp, "peer-A", "run_abc123");
    expect(parseRunId(id)).toEqual({ stamp, author: "peer-A" });
  });

  it("round-trips a cut id without confusing it for the author", () => {
    const stamp = hlc(1000);
    const id = makeCutId(stamp, "peer-A", "run_1", 1, 3);
    expect(parseRunId(id)).toEqual({ stamp, author: "peer-A" });
  });

  it("returns null for ROOT", () => {
    expect(parseRunId(ROOT_ID)).toBeNull();
  });
});

describe("compareRuns", () => {
  it("orders anchors by offset ascending", () => {
    const base = run(1, "a", "abcd", atRoot());
    const early = run(2, "a", "X", { runId: base.id, offset: 1 });
    const late = run(3, "a", "Y", { runId: base.id, offset: 3 });
    expect(compareRuns(early, late)).toBeLessThan(0);
    expect(compareRuns(late, early)).toBeGreaterThan(0);
  });

  it("places a newer insert before an older one at the same anchor", () => {
    const newer = run(2, "a", "X", atRoot());
    const older = run(1, "a", "Y", atRoot());
    expect(compareRuns(newer, older)).toBeLessThan(0);
  });

  it("never returns 0 for distinct cells, even with equal stamps and authors", () => {
    const a = run(1, "a", "X", atRoot());
    const b = { ...a, id: `${a.id}:second` };
    expect(compareRuns(a, b)).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

describe("project", () => {
  it("renders one root run", () => {
    const base = run(1, "a", "hello", atRoot());
    expect(doc(base).text).toBe("hello");
    expect(createDocState().text).toBe("");
  });

  it("renders a chain of inserts", () => {
    const base = run(1, "a", "hello", atRoot());
    const next = run(2, "a", " world", { runId: base.id, offset: 5 });
    expect(doc(base, next).text).toBe("hello world");
  });

  it("interleaves a mid-run insert at its anchor offset", () => {
    const base = run(1, "a", "I think I can", atRoot());
    const x = run(2, "b", "X", { runId: base.id, offset: 7 });
    expect(doc(base, x).text).toBe("I thinkX I can");
  });

  it("orders two inserts at different offsets by offset", () => {
    const base = run(1, "a", "I think I can", atRoot());
    const x = run(2, "a", "X", { runId: base.id, offset: 7 });
    const y = run(3, "b", "Y", { runId: base.id, offset: 9 });
    expect(doc(base, x, y).text).toBe("I thinkX IY can");
  });

  it("places the newer of two inserts at the same offset first", () => {
    const base = run(1, "a", "ab", atRoot());
    const first = run(2, "a", "X", { runId: base.id, offset: 1 });
    const second = run(3, "a", "Y", { runId: base.id, offset: 1 });
    expect(doc(base, first, second).text).toBe("aYXb");
  });

  it("orders root inserts newest first", () => {
    const first = run(1, "a", "a", atRoot());
    const second = run(2, "a", "b", atRoot());
    expect(doc(first, second).text).toBe("ba");
  });

  it("does not render a run whose anchor is missing, then renders it when attached", () => {
    const base = run(1, "a", "ab", atRoot());
    const orphan = run(2, "b", "X", { runId: "missing", offset: 0 });

    const before = doc(base, orphan);
    expect(before.text).toBe("ab");
    expect(before.runs.has(orphan.id)).toBe(true);

    const attached: RunCell = { ...orphan, anchor: { runId: base.id, offset: 1 } };
    expect(doc(base, attached).text).toBe("aXb");
  });

  it("does not loop forever on a self-anchored run", () => {
    const broken: RunCell = {
      kind: "run",
      id: "r1",
      text: "x",
      author: "a",
      stamp: hlc(1),
      anchor: { runId: "r1", offset: 0 },
    };
    expect(doc(broken).text).toBe("");
  });

  it("render order depends only on the cells, not on map insertion order", () => {
    const base = run(1, "a", "I think I can", atRoot());
    const x = run(2, "a", "X", { runId: base.id, offset: 7 });
    const y = run(3, "b", "Y", { runId: base.id, offset: 9 });
    const cuts = cut(4, "c", base.id, 0, 2);

    expect(project(cells(base, x, y, cuts)).text).toBe(project(cells(cuts, y, base, x)).text);
  });
});

// ---------------------------------------------------------------------------
// Cuts
// ---------------------------------------------------------------------------

describe("cuts", () => {
  it("hides a range of the owning run", () => {
    const base = run(1, "a", "I think I can", atRoot());
    const remove = cut(2, "a", base.id, 2, 7);
    expect(doc(base, remove).text).toBe("I  I can");
  });

  it("unions overlapping cuts", () => {
    const base = run(1, "a", "abcdef", atRoot());
    const first = cut(2, "a", base.id, 1, 3);
    const second = cut(3, "b", base.id, 2, 5);
    expect(doc(base, first, second).text).toBe("af");
  });

  it("is idempotent: the same cut twice hides the range once", () => {
    const base = run(1, "a", "abcdef", atRoot());
    const remove = cut(2, "a", base.id, 1, 3);
    expect(doc(base, remove).text).toBe(doc(base, remove, { ...remove }).text);
  });

  it("hides only the owning run's characters", () => {
    const base = run(1, "a", "abcd", atRoot());
    const inserted = run(2, "b", "XY", { runId: base.id, offset: 2 });
    const remove = cut(3, "a", base.id, 0, 4);
    expect(doc(base, inserted, remove).text).toBe("XY");
  });

  it("removes a whole run with [0, len)", () => {
    const base = run(1, "a", "abc", atRoot());
    expect(doc(base, cut(2, "a", base.id, 0, 3)).text).toBe("");
  });

  it("ignores a cut whose run is absent", () => {
    const orphan = cut(1, "a", "missing", 0, 2);
    expect(doc(orphan).text).toBe("");
  });

  it("stays cut against every delivery order, including a concurrent insert", () => {
    const base = run(1, "a", "I think I can", atRoot());
    const remove = cut(2, "a", base.id, 2, 7);
    const concurrent = run(3, "b", "X", { runId: base.id, offset: 7 });

    const forward = [base, remove, concurrent].reduce(
      (state, cell) => applyCellFields(state, cells(cell)),
      createDocState(),
    );
    const reverse = [concurrent, remove, base].reduce(
      (state, cell) => applyCellFields(state, cells(cell)),
      createDocState(),
    );

    expect(forward.text).toBe("I X I can");
    expect(reverse.text).toBe("I X I can");
  });
});

// ---------------------------------------------------------------------------
// Position index and spans
// ---------------------------------------------------------------------------

describe("position index", () => {
  it("has one span per run fragment, with run-relative offsets", () => {
    const base = run(1, "a", "abcd", atRoot());
    const x = run(2, "b", "X", { runId: base.id, offset: 2 });
    const state = doc(base, x);

    expect(state.index.spans).toEqual([
      { runId: base.id, offset: 0, length: 2 },
      { runId: x.id, offset: 0, length: 1 },
      { runId: base.id, offset: 2, length: 2 },
    ]);
    expect(state.index.totalLength).toBe(5);
  });

  it("looks up a document position as (run, run offset)", () => {
    const base = run(1, "a", "abcd", atRoot());
    const x = run(2, "b", "X", { runId: base.id, offset: 2 });
    const state = doc(base, x);

    expect(lookupPosition(state.index, 0)).toMatchObject({ runId: base.id, offset: 0 });
    expect(lookupPosition(state.index, 2)).toMatchObject({ runId: x.id, offset: 0 });
    expect(lookupPosition(state.index, 3)).toMatchObject({ runId: base.id, offset: 2 });
    expect(lookupPosition(state.index, 5)).toBeUndefined();
  });

  it("converts a run offset back to a document position across fragments", () => {
    const base = run(1, "a", "abcd", atRoot());
    const x = run(2, "b", "X", { runId: base.id, offset: 2 });
    const state = doc(base, x);

    expect(runOffsetToPosition(state.index, base.id, 0)).toBe(0);
    expect(runOffsetToPosition(state.index, base.id, 3)).toBe(4);
    expect(runOffsetToPosition(state.index, base.id, 4)).toBeUndefined();
    expect(runOffsetToPosition(state.index, x.id, 0)).toBe(2);
  });

  it("reconstruct returns the projection", () => {
    const base = run(1, "a", "abc", atRoot());
    expect(reconstruct(doc(base))).toBe("abc");
  });
});

// ---------------------------------------------------------------------------
// Applying cells
// ---------------------------------------------------------------------------

describe("applyCellFields", () => {
  it("is idempotent for a re-delivered cell", () => {
    const base = run(1, "a", "abc", atRoot());
    const state = doc(base);
    expect(applyCellFields(state, cells(base))).toBe(state);
  });

  it("converges on a cell set delivered in any order", () => {
    const base = run(1, "a", "I think I can", atRoot());
    const x = run(2, "a", "X", { runId: base.id, offset: 7 });
    const y = run(3, "b", "Y", { runId: base.id, offset: 9 });
    const remove = cut(4, "a", base.id, 2, 7);

    const forward = [base, x, y, remove].reduce(
      (state, cell) => applyCellFields(state, cells(cell)),
      createDocState(),
    );
    const reverse = [remove, y, x, base].reduce(
      (state, cell) => applyCellFields(state, cells(cell)),
      createDocState(),
    );

    expect(forward.text).toBe(reverse.text);
    expect(forward.text).toBe("I X IY can");
  });

  it("resolves a rewritten key deterministically under the wire's leaf rule", () => {
    const base = run(1, "a", "abc", atRoot());
    const other = { ...base, text: "xyz" };
    const older = { value: base, update_id: "u_a", hlc: hlc(1) };
    const newer = { value: other, update_id: "u_b", hlc: hlc(2) };

    const aThenB = applyCellFields(createDocState(), new Map([[base.id, older]]));
    const bThenA = applyCellFields(createDocState(), new Map([[base.id, newer]]));
    expect(applyCellFields(aThenB, new Map([[base.id, newer]])).text).toBe("xyz");
    expect(applyCellFields(bThenA, new Map([[base.id, older]])).text).toBe("xyz");
  });
});

// ---------------------------------------------------------------------------
// Deliberately broken cell sets
// ---------------------------------------------------------------------------
//
// Each property below is one the repaired model cannot fail. These cases make
// the failure visible, so the assertion is evidence rather than a tautology.

describe("deliberately broken cell sets", () => {
  it("a cut is what keeps deleted text from resurrecting", () => {
    const base = run(1, "a", "I think I can", atRoot());
    const remove = cut(2, "a", base.id, 2, 7);

    expect(doc(base, remove).text).toBe("I  I can");
    // Drop the cut from the same cell set: the text comes back, so the
    // no-resurrection assertion is not vacuous.
    expect(doc(base).text).toBe("I think I can");
  });

  it("an anchor is what places a run; a self-anchor loses it", () => {
    const base = run(1, "a", "ab", atRoot());
    const x = run(2, "b", "X", { runId: base.id, offset: 1 });
    expect(doc(base, x).text).toBe("aXb");

    const broken: RunCell = { ...x, anchor: { runId: x.id, offset: 0 } };
    expect(doc(base, broken).text).toBe("ab");
  });

  // The broken alternative is a comparator that returns 0 for these two
  // cells: their order would fall back to map insertion order and the two
  // permutations below would disagree.
  it("the id tiebreak is what orders cells that share a stamp and author", () => {
    const base = run(1, "a", "ab", atRoot());
    const a = { ...run(2, "a", "A", { runId: base.id, offset: 1 }), id: "tie_a" };
    const b = { ...run(2, "a", "B", { runId: base.id, offset: 1 }), id: "tie_b" };

    // Descending id: "tie_b" first. The same cells in either map order.
    expect(doc(base, a, b).text).toBe("aBAb");
    expect(doc(base, b, a).text).toBe("aBAb");
    expect(compareRuns(a, b)).toBeGreaterThan(0);
  });

  it("a rewritten cell loses one writer, which is why a write only adds keys", () => {
    const base = run(1, "a", "ab", atRoot());
    const first = { value: base, update_id: "u_first", hlc: base.stamp };
    const rewrite = {
      value: { ...base, text: "xy" },
      update_id: "u_rewrite",
      hlc: base.stamp,
    };
    const state = applyCellFields(
      applyCellFields(createDocState(), new Map([[base.id, first]])),
      new Map([[base.id, rewrite]]),
    );
    expect(state.text).toBe("xy");
    // The pre-rewrite text is unrecoverable from the cell set: a positional
    // write cannot express both, so the model makes every write additive.
    expect(state.cells.size).toBe(1);
  });

  it("a total order is what makes a permuted cell set project identically", () => {
    const base = run(1, "a", "ab", atRoot());
    const first = run(2, "a", "X", { runId: base.id, offset: 1 });
    const second = run(3, "a", "Y", { runId: base.id, offset: 1 });
    const set = [base, first, second];
    const permuted = [second, base, first];
    expect(doc(...set).text).toBe(doc(...permuted).text);
    expect(doc(...set).text).toBe("aYXb");
  });

  it("stamp provenance is per-cell, not inherited", () => {
    const base = run(1, "a", "ab", atRoot());
    const x = run(2, "b", "X", { runId: base.id, offset: 1 });
    expect(x.stamp).not.toBe(base.stamp);
    expect(x.id.startsWith(x.stamp)).toBe(true);
  });
});
