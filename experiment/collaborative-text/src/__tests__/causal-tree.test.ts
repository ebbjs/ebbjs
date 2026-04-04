import { describe, expect, it } from "vitest";
import { toString } from "../hlc.ts";
import {
  createDocState,
  docReducer,
  findInsertPosition,
  lookupPosition,
  makeSplitId,
  reconstruct,
  ROOT_ID,
  runOffsetToPosition,
  type DocState,
  type RunNode,
} from "../causal-tree.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a RunNode with a synthetic HLC-derived ID. */
const makeRun = (
  ts: number,
  count: number,
  peerId: string,
  text: string,
  parentId: string,
): RunNode => ({
  id: toString({ ts, count, peerId }),
  text,
  parentId,
  peerId,
  deleted: false,
});

/** Insert a single run and return updated state + the run's ID. */
const insertRun = (
  state: DocState,
  ts: number,
  count: number,
  peerId: string,
  text: string,
  parentId: string,
): { state: DocState; id: string } => {
  const node = makeRun(ts, count, peerId, text, parentId);
  return {
    state: docReducer(state, { type: "INSERT_RUN", node }),
    id: node.id,
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("makeSplitId", () => {
  it("produces deterministic IDs", () => {
    const id = "000000000001000:00000:peer-A";
    expect(makeSplitId(id, 3)).toBe(`${id}:s:3`);
  });

  it("same inputs always produce the same output", () => {
    const id = "000000000001000:00000:peer-A";
    expect(makeSplitId(id, 5)).toBe(makeSplitId(id, 5));
  });

  it("different offsets produce different IDs", () => {
    const id = "000000000001000:00000:peer-A";
    expect(makeSplitId(id, 3)).not.toBe(makeSplitId(id, 4));
  });
});

describe("createDocState", () => {
  it("creates a state with only the ROOT node", () => {
    const state = createDocState();
    expect(state.nodes.size).toBe(1);
    expect(state.nodes.has(ROOT_ID)).toBe(true);
    expect(state.children.get(ROOT_ID)).toEqual([]);
  });

  it("has an empty index", () => {
    const state = createDocState();
    expect(state.index.spans).toEqual([]);
    expect(state.index.totalLength).toBe(0);
  });

  it("reconstructs to an empty string", () => {
    expect(reconstruct(createDocState())).toBe("");
  });
});

describe("docReducer — INSERT_RUN", () => {
  it("inserts a single run", () => {
    const { state, id } = insertRun(createDocState(), 1000, 0, "peer-A", "hello", ROOT_ID);

    expect(state.nodes.size).toBe(2); // ROOT + hello
    expect(state.nodes.get(id)?.text).toBe("hello");
    expect(reconstruct(state)).toBe("hello");
  });

  it("updates index correctly for a single run", () => {
    const { state } = insertRun(createDocState(), 1000, 0, "peer-A", "hello", ROOT_ID);

    expect(state.index.spans).toHaveLength(1);
    expect(state.index.spans[0]?.length).toBe(5);
    expect(state.index.totalLength).toBe(5);
  });

  it("inserts sequential runs (each parented to previous)", () => {
    let state = createDocState();
    const r1 = insertRun(state, 1000, 0, "peer-A", "hello", ROOT_ID);
    state = r1.state;
    const r2 = insertRun(state, 1001, 0, "peer-A", "world", r1.id);
    state = r2.state;

    expect(reconstruct(state)).toBe("helloworld");
    expect(state.index.spans).toHaveLength(2);
    expect(state.index.spans[0]?.length).toBe(5);
    expect(state.index.spans[1]?.length).toBe(5);
    expect(state.index.totalLength).toBe(10);
  });

  it("orders sibling runs by descending HLC (higher first)", () => {
    let state = createDocState();

    // Insert "abc" as child of ROOT (ts=1000, lower HLC)
    const r1 = insertRun(state, 1000, 0, "peer-A", "abc", ROOT_ID);
    state = r1.state;

    // Insert "xyz" as child of ROOT (ts=1002, higher HLC)
    const r2 = insertRun(state, 1002, 0, "peer-A", "xyz", ROOT_ID);
    state = r2.state;

    // Higher HLC first: "xyzabc"
    expect(reconstruct(state)).toBe("xyzabc");
  });

  it("is idempotent — duplicate INSERT_RUN is a no-op", () => {
    let state = createDocState();
    const node = makeRun(1000, 0, "peer-A", "hello", ROOT_ID);
    state = docReducer(state, { type: "INSERT_RUN", node });
    const stateBefore = state;
    state = docReducer(state, { type: "INSERT_RUN", node });
    expect(state).toBe(stateBefore); // reference equality
    expect(reconstruct(state)).toBe("hello");
  });

  it("inserts at the beginning (child of ROOT with higher HLC)", () => {
    let state = createDocState();

    // Insert "world" first
    const r1 = insertRun(state, 1000, 0, "peer-A", "world", ROOT_ID);
    state = r1.state;

    // Insert "hello" as child of ROOT with higher HLC → comes first
    const r2 = insertRun(state, 1002, 0, "peer-A", "hello", ROOT_ID);
    state = r2.state;

    expect(reconstruct(state)).toBe("helloworld");
  });

  it("inserts in the middle (between parent and existing child)", () => {
    let state = createDocState();

    // "a" → ROOT
    const r1 = insertRun(state, 1000, 0, "peer-A", "a", ROOT_ID);
    state = r1.state;
    // "c" → child of "a"
    const r2 = insertRun(state, 1001, 0, "peer-A", "c", r1.id);
    state = r2.state;
    expect(reconstruct(state)).toBe("ac");

    // "b" → child of "a" with higher HLC than "c" → comes first among a's children
    const r3 = insertRun(state, 1002, 0, "peer-A", "b", r1.id);
    state = r3.state;

    expect(reconstruct(state)).toBe("abc");
  });
});

describe("docReducer — SPLIT", () => {
  it("splits a run at a given offset", () => {
    const { state: s1, id: helloId } = insertRun(
      createDocState(),
      1000,
      0,
      "peer-A",
      "hello",
      ROOT_ID,
    );

    const s2 = docReducer(s1, { type: "SPLIT", runId: helloId, offset: 3 });

    // Left half keeps original ID with text "hel"
    expect(s2.nodes.get(helloId)?.text).toBe("hel");

    // Right half gets split ID with text "lo"
    const splitId = makeSplitId(helloId, 3);
    expect(s2.nodes.get(splitId)?.text).toBe("lo");

    // Reconstruct unchanged
    expect(reconstruct(s2)).toBe("hello");
  });

  it("updates index correctly after split", () => {
    const { state: s1, id: helloId } = insertRun(
      createDocState(),
      1000,
      0,
      "peer-A",
      "hello",
      ROOT_ID,
    );

    const s2 = docReducer(s1, { type: "SPLIT", runId: helloId, offset: 3 });

    expect(s2.index.spans).toHaveLength(2);
    expect(s2.index.spans[0]?.length).toBe(3); // "hel"
    expect(s2.index.spans[1]?.length).toBe(2); // "lo"
    expect(s2.index.totalLength).toBe(5); // unchanged
  });

  it("right half is a child of left half", () => {
    const { state: s1, id: helloId } = insertRun(
      createDocState(),
      1000,
      0,
      "peer-A",
      "hello",
      ROOT_ID,
    );

    const s2 = docReducer(s1, { type: "SPLIT", runId: helloId, offset: 3 });
    const splitId = makeSplitId(helloId, 3);

    // Right half's parentId is the left half
    expect(s2.nodes.get(splitId)?.parentId).toBe(helloId);

    // Left half's children includes the right half
    const leftChildren = s2.children.get(helloId);
    expect(leftChildren).toContain(splitId);
  });

  it("split then insert between halves", () => {
    const { state: s1, id: helloId } = insertRun(
      createDocState(),
      1000,
      0,
      "peer-A",
      "hello",
      ROOT_ID,
    );

    // Split "hello" at offset 3: "hel" | "lo"
    const s2 = docReducer(s1, { type: "SPLIT", runId: helloId, offset: 3 });

    // Insert "XY" as child of "hel" (left half) with higher HLC than the split
    // The split right half "lo" has ID makeSplitId(helloId, 3).
    // A new insert with a higher HLC should come before "lo" among hel's children
    const r = insertRun(s2, 2000, 0, "peer-A", "XY", helloId);

    expect(reconstruct(r.state)).toBe("helXYlo");
  });

  it("is idempotent — splitting the same run twice is a no-op", () => {
    const { state: s1, id: helloId } = insertRun(
      createDocState(),
      1000,
      0,
      "peer-A",
      "hello",
      ROOT_ID,
    );

    const s2 = docReducer(s1, { type: "SPLIT", runId: helloId, offset: 3 });
    const s3 = docReducer(s2, { type: "SPLIT", runId: helloId, offset: 3 });

    // Second split should be a no-op because the split ID already exists
    expect(s3).toBe(s2);
  });

  it("preserves children of the original run", () => {
    let state = createDocState();

    // "hello" → ROOT
    const r1 = insertRun(state, 1000, 0, "peer-A", "hello", ROOT_ID);
    state = r1.state;

    // "world" → child of "hello"
    const r2 = insertRun(state, 1001, 0, "peer-A", "world", r1.id);
    state = r2.state;

    expect(reconstruct(state)).toBe("helloworld");

    // Split "hello" at offset 3: "hel" | "lo"
    // "world" was a child of "hello", should be re-parented to "lo" (right half)
    state = docReducer(state, { type: "SPLIT", runId: r1.id, offset: 3 });

    // Reconstruct should still be "helloworld"
    expect(reconstruct(state)).toBe("helloworld");

    // "world" should now be a child of the right half "lo"
    const splitId = makeSplitId(r1.id, 3);
    const rightChildren = state.children.get(splitId);
    expect(rightChildren).toContain(r2.id);
  });
});

describe("docReducer — DELETE_RANGE", () => {
  it("deletes an entire run (tombstone)", () => {
    const { state: s1, id: helloId } = insertRun(
      createDocState(),
      1000,
      0,
      "peer-A",
      "hello",
      ROOT_ID,
    );

    const s2 = docReducer(s1, {
      type: "DELETE_RANGE",
      runId: helloId,
      offset: 0,
      count: 5,
    });

    expect(reconstruct(s2)).toBe("");
    expect(s2.nodes.get(helloId)?.deleted).toBe(true);
    expect(s2.index.spans).toHaveLength(0);
    expect(s2.index.totalLength).toBe(0);
  });

  it("deletes from the beginning of a run", () => {
    const { state: s1, id: helloId } = insertRun(
      createDocState(),
      1000,
      0,
      "peer-A",
      "hello",
      ROOT_ID,
    );

    // Delete "hel" (offset 0, count 3)
    const s2 = docReducer(s1, {
      type: "DELETE_RANGE",
      runId: helloId,
      offset: 0,
      count: 3,
    });

    expect(reconstruct(s2)).toBe("lo");
    expect(s2.index.totalLength).toBe(2);
  });

  it("deletes from the end of a run", () => {
    const { state: s1, id: helloId } = insertRun(
      createDocState(),
      1000,
      0,
      "peer-A",
      "hello",
      ROOT_ID,
    );

    // Delete "lo" (offset 3, count 2)
    const s2 = docReducer(s1, {
      type: "DELETE_RANGE",
      runId: helloId,
      offset: 3,
      count: 2,
    });

    expect(reconstruct(s2)).toBe("hel");
    expect(s2.index.totalLength).toBe(3);
  });

  it("deletes from the middle of a run", () => {
    const { state: s1, id: helloId } = insertRun(
      createDocState(),
      1000,
      0,
      "peer-A",
      "hello",
      ROOT_ID,
    );

    // Delete "ell" (offset 1, count 3)
    const s2 = docReducer(s1, {
      type: "DELETE_RANGE",
      runId: helloId,
      offset: 1,
      count: 3,
    });

    expect(reconstruct(s2)).toBe("ho");
    expect(s2.index.totalLength).toBe(2);
  });

  it("deleting a run does not delete its children", () => {
    let state = createDocState();

    const r1 = insertRun(state, 1000, 0, "peer-A", "hello", ROOT_ID);
    state = r1.state;
    const r2 = insertRun(state, 1001, 0, "peer-A", "world", r1.id);
    state = r2.state;

    expect(reconstruct(state)).toBe("helloworld");

    // Delete "hello" entirely
    state = docReducer(state, {
      type: "DELETE_RANGE",
      runId: r1.id,
      offset: 0,
      count: 5,
    });

    // "world" should still be visible
    expect(reconstruct(state)).toBe("world");
  });

  it("deleting a non-existent run is a no-op", () => {
    const state = createDocState();
    const s2 = docReducer(state, {
      type: "DELETE_RANGE",
      runId: "nonexistent",
      offset: 0,
      count: 1,
    });
    expect(s2).toBe(state);
  });

  it("deleting an already-deleted run is a no-op", () => {
    const { state: s1, id } = insertRun(createDocState(), 1000, 0, "peer-A", "hello", ROOT_ID);
    const s2 = docReducer(s1, {
      type: "DELETE_RANGE",
      runId: id,
      offset: 0,
      count: 5,
    });
    const s3 = docReducer(s2, {
      type: "DELETE_RANGE",
      runId: id,
      offset: 0,
      count: 5,
    });
    expect(s3).toBe(s2);
  });
});

describe("reconstruct", () => {
  it("handles interleaved inserts correctly", () => {
    let state = createDocState();

    // ROOT → "abc" → "def" → "ghi" (sequential)
    const r1 = insertRun(state, 1000, 0, "peer-A", "abc", ROOT_ID);
    state = r1.state;
    const r2 = insertRun(state, 1001, 0, "peer-A", "def", r1.id);
    state = r2.state;
    const r3 = insertRun(state, 1002, 0, "peer-A", "ghi", r2.id);
    state = r3.state;

    expect(reconstruct(state)).toBe("abcdefghi");
  });

  it("handles mix of inserts and deletes", () => {
    let state = createDocState();

    const r1 = insertRun(state, 1000, 0, "peer-A", "abc", ROOT_ID);
    state = r1.state;
    const r2 = insertRun(state, 1001, 0, "peer-A", "def", r1.id);
    state = r2.state;
    const r3 = insertRun(state, 1002, 0, "peer-A", "ghi", r2.id);
    state = r3.state;

    // Delete the middle run
    state = docReducer(state, {
      type: "DELETE_RANGE",
      runId: r2.id,
      offset: 0,
      count: 3,
    });

    expect(reconstruct(state)).toBe("abcghi");
  });
});

describe("lookupPosition", () => {
  it("returns undefined for empty document", () => {
    const state = createDocState();
    expect(lookupPosition(state.index, 0)).toBeUndefined();
  });

  it("returns undefined for out-of-bounds position", () => {
    const { state } = insertRun(createDocState(), 1000, 0, "peer-A", "hello", ROOT_ID);
    expect(lookupPosition(state.index, -1)).toBeUndefined();
    expect(lookupPosition(state.index, 5)).toBeUndefined();
  });

  it("resolves positions within a single run", () => {
    const { state, id } = insertRun(createDocState(), 1000, 0, "peer-A", "hello", ROOT_ID);

    const pos0 = lookupPosition(state.index, 0);
    expect(pos0?.runId).toBe(id);
    expect(pos0?.offset).toBe(0);

    const pos4 = lookupPosition(state.index, 4);
    expect(pos4?.runId).toBe(id);
    expect(pos4?.offset).toBe(4);
  });

  it("resolves positions across multiple runs", () => {
    let state = createDocState();
    const r1 = insertRun(state, 1000, 0, "peer-A", "abc", ROOT_ID);
    state = r1.state;
    const r2 = insertRun(state, 1001, 0, "peer-A", "de", r1.id);
    state = r2.state;

    // Position 2 is in first run, offset 2 ('c')
    const pos2 = lookupPosition(state.index, 2);
    expect(pos2?.runId).toBe(r1.id);
    expect(pos2?.offset).toBe(2);

    // Position 3 is in second run, offset 0 ('d')
    const pos3 = lookupPosition(state.index, 3);
    expect(pos3?.runId).toBe(r2.id);
    expect(pos3?.offset).toBe(0);
  });
});

describe("runOffsetToPosition", () => {
  it("returns undefined for run not in index", () => {
    const state = createDocState();
    expect(runOffsetToPosition(state.index, "nonexistent", 0)).toBeUndefined();
  });

  it("returns absolute position for run + offset", () => {
    let state = createDocState();
    const r1 = insertRun(state, 1000, 0, "peer-A", "abc", ROOT_ID);
    state = r1.state;
    const r2 = insertRun(state, 1001, 0, "peer-A", "de", r1.id);
    state = r2.state;

    expect(runOffsetToPosition(state.index, r1.id, 0)).toBe(0);
    expect(runOffsetToPosition(state.index, r1.id, 2)).toBe(2);
    expect(runOffsetToPosition(state.index, r2.id, 0)).toBe(3);
    expect(runOffsetToPosition(state.index, r2.id, 1)).toBe(4);
  });
});

describe("findInsertPosition", () => {
  it("returns 0 for insert as child of ROOT in empty document", () => {
    const state = createDocState();
    const newId = toString({ ts: 1000, count: 0, peerId: "peer-A" });
    expect(findInsertPosition(state, ROOT_ID, newId)).toBe(0);
  });

  it("returns correct position for insert after last run", () => {
    let state = createDocState();
    const r1 = insertRun(state, 1000, 0, "peer-A", "abc", ROOT_ID);
    state = r1.state;
    const r2 = insertRun(state, 1001, 0, "peer-A", "de", r1.id);
    state = r2.state;

    const newId = toString({ ts: 1002, count: 0, peerId: "peer-A" });
    const pos = findInsertPosition(state, r2.id, newId);
    expect(pos).toBe(5); // after "abcde"
  });

  it("returns correct position for insert at the beginning", () => {
    let state = createDocState();
    const r1 = insertRun(state, 1000, 0, "peer-A", "abc", ROOT_ID);
    state = r1.state;

    const newId = toString({ ts: 1002, count: 0, peerId: "peer-A" });
    const pos = findInsertPosition(state, ROOT_ID, newId);
    expect(pos).toBe(0); // before everything (higher HLC among ROOT's children)
  });

  it("returns correct position for sibling tie-break", () => {
    let state = createDocState();
    const r1 = insertRun(state, 1000, 0, "peer-A", "a", ROOT_ID);
    state = r1.state;
    const r2 = insertRun(state, 1001, 0, "peer-A", "x", r1.id);
    state = r2.state;
    // State: "ax"

    // New node as child of "a" with ts=1002 (higher than x's 1001)
    const newId = toString({ ts: 1002, count: 0, peerId: "peer-A" });
    const pos = findInsertPosition(state, r1.id, newId);
    // Higher HLC first among a's children → position right after "a"
    expect(pos).toBe(1);
  });
});

describe("sibling ordering with runs", () => {
  it("orders siblings by descending HLC (higher first)", () => {
    let state = createDocState();

    const r1 = insertRun(state, 1000, 0, "peer-A", "ccc", ROOT_ID);
    state = r1.state;
    const r2 = insertRun(state, 1002, 0, "peer-A", "aaa", ROOT_ID);
    state = r2.state;
    const r3 = insertRun(state, 1001, 0, "peer-A", "bbb", ROOT_ID);
    state = r3.state;

    // Higher HLC first: aaa (1002), bbb (1001), ccc (1000)
    expect(reconstruct(state)).toBe("aaabbbccc");
  });

  it("tie-breaks on peerId when ts and count are equal", () => {
    let state = createDocState();

    const r1 = insertRun(state, 1000, 0, "peer-A", "xxx", ROOT_ID);
    state = r1.state;
    const r2 = insertRun(state, 1000, 0, "peer-B", "yyy", ROOT_ID);
    state = r2.state;

    // peer-B > peer-A lexicographically → yyy first
    expect(reconstruct(state)).toBe("yyyxxx");
  });
});

// ---------------------------------------------------------------------------
// Convergence & Commutativity (ported from per-char tests)
// ---------------------------------------------------------------------------

describe("convergence — same ops in different orders produce identical results", () => {
  it("two concurrent inserts with the same parent converge regardless of apply order", () => {
    const a = makeRun(1000, 0, "peer-A", "aa", ROOT_ID);
    const b = makeRun(1001, 0, "peer-A", "bb", a.id);
    const x = makeRun(1002, 0, "peer-A", "XX", a.id); // Peer A's concurrent insert
    const y = makeRun(1002, 0, "peer-B", "YY", a.id); // Peer B's concurrent insert

    // Order 1: base → X → Y
    let state1 = createDocState();
    state1 = docReducer(state1, { type: "INSERT_RUN", node: a });
    state1 = docReducer(state1, { type: "INSERT_RUN", node: b });
    state1 = docReducer(state1, { type: "INSERT_RUN", node: x });
    state1 = docReducer(state1, { type: "INSERT_RUN", node: y });

    // Order 2: base → Y → X
    let state2 = createDocState();
    state2 = docReducer(state2, { type: "INSERT_RUN", node: a });
    state2 = docReducer(state2, { type: "INSERT_RUN", node: b });
    state2 = docReducer(state2, { type: "INSERT_RUN", node: y });
    state2 = docReducer(state2, { type: "INSERT_RUN", node: x });

    const text1 = reconstruct(state1);
    const text2 = reconstruct(state2);
    expect(text1).toBe(text2);

    // Y has higher HLC (peer-B > peer-A), b has lower HLC than X and Y
    // So: aa, then YY (highest), then XX, then bb (lowest)
    expect(text1).toBe("aaYYXXbb");
  });

  it("three concurrent inserts at the same parent converge in all 6 orderings", () => {
    const parent = makeRun(1000, 0, "peer-A", "p", ROOT_ID);
    const n1 = makeRun(1001, 0, "peer-A", "111", parent.id);
    const n2 = makeRun(1001, 0, "peer-B", "222", parent.id);
    const n3 = makeRun(1001, 0, "peer-C", "333", parent.id);

    const nodes = [n1, n2, n3];
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];

    const results: string[] = [];
    for (const perm of permutations) {
      let state = createDocState();
      state = docReducer(state, { type: "INSERT_RUN", node: parent });
      for (const idx of perm) {
        state = docReducer(state, { type: "INSERT_RUN", node: nodes[idx]! });
      }
      results.push(reconstruct(state));
    }

    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(results[0]);
    }

    // Descending peerId: C > B > A → "p333222111"
    expect(results[0]).toBe("p333222111");
  });

  it("concurrent inserts with different timestamps converge", () => {
    const a = makeRun(1000, 0, "peer-A", "a", ROOT_ID);
    const x = makeRun(1005, 0, "peer-A", "XX", a.id); // higher ts
    const y = makeRun(1003, 0, "peer-B", "YY", a.id); // lower ts

    // Order 1
    let s1 = createDocState();
    s1 = docReducer(s1, { type: "INSERT_RUN", node: a });
    s1 = docReducer(s1, { type: "INSERT_RUN", node: x });
    s1 = docReducer(s1, { type: "INSERT_RUN", node: y });

    // Order 2
    let s2 = createDocState();
    s2 = docReducer(s2, { type: "INSERT_RUN", node: a });
    s2 = docReducer(s2, { type: "INSERT_RUN", node: y });
    s2 = docReducer(s2, { type: "INSERT_RUN", node: x });

    expect(reconstruct(s1)).toBe(reconstruct(s2));
    expect(reconstruct(s1)).toBe("aXXYY");
  });
});

describe("commutativity — ops in forward and reverse order produce same result", () => {
  it("full sequence of inserts is commutative", () => {
    const aId = toString({ ts: 1000, count: 0, peerId: "peer-A" });
    const nodes: RunNode[] = [
      makeRun(1000, 0, "peer-A", "aaa", ROOT_ID),
      makeRun(1001, 0, "peer-A", "bbb", aId),
      makeRun(1002, 0, "peer-B", "ccc", aId),
      makeRun(1003, 0, "peer-A", "ddd", toString({ ts: 1001, count: 0, peerId: "peer-A" })),
    ];

    // Forward order
    let forward = createDocState();
    for (const node of nodes) {
      forward = docReducer(forward, { type: "INSERT_RUN", node });
    }

    // Reverse order
    let reverse = createDocState();
    for (let i = nodes.length - 1; i >= 0; i--) {
      reverse = docReducer(reverse, { type: "INSERT_RUN", node: nodes[i]! });
    }

    expect(reconstruct(forward)).toBe(reconstruct(reverse));
  });

  it("interleaved inserts and deletes are commutative for inserts", () => {
    const a = makeRun(1000, 0, "peer-A", "aaa", ROOT_ID);
    const b = makeRun(1001, 0, "peer-A", "bbb", a.id);
    const c = makeRun(1002, 0, "peer-B", "ccc", a.id); // sibling of b

    // Order 1: insert a, b, c, then delete b
    let s1 = createDocState();
    s1 = docReducer(s1, { type: "INSERT_RUN", node: a });
    s1 = docReducer(s1, { type: "INSERT_RUN", node: b });
    s1 = docReducer(s1, { type: "INSERT_RUN", node: c });
    s1 = docReducer(s1, {
      type: "DELETE_RANGE",
      runId: b.id,
      offset: 0,
      count: 3,
    });

    // Order 2: insert a, c, delete b (noop), then insert b, delete b
    let s2 = createDocState();
    s2 = docReducer(s2, { type: "INSERT_RUN", node: a });
    s2 = docReducer(s2, { type: "INSERT_RUN", node: c });
    s2 = docReducer(s2, {
      type: "DELETE_RANGE",
      runId: b.id,
      offset: 0,
      count: 3,
    }); // noop — b not yet inserted
    s2 = docReducer(s2, { type: "INSERT_RUN", node: b });
    s2 = docReducer(s2, {
      type: "DELETE_RANGE",
      runId: b.id,
      offset: 0,
      count: 3,
    });

    expect(reconstruct(s1)).toBe(reconstruct(s2));
    // c has higher HLC (ts=1002) than b (ts=1001), b is deleted
    expect(reconstruct(s1)).toBe("aaaccc");
  });
});

describe("idempotency — duplicate INSERT_RUNs are no-ops", () => {
  it("inserting the same run twice does not duplicate it", () => {
    let state = createDocState();
    const node = makeRun(1000, 0, "peer-A", "hello", ROOT_ID);

    state = docReducer(state, { type: "INSERT_RUN", node });
    const afterFirst = reconstruct(state);

    state = docReducer(state, { type: "INSERT_RUN", node });
    const afterSecond = reconstruct(state);

    expect(afterFirst).toBe("hello");
    expect(afterSecond).toBe("hello");
    expect(state.nodes.size).toBe(2); // ROOT + hello
  });

  it("concurrent inserts replayed are idempotent", () => {
    const a = makeRun(1000, 0, "peer-A", "aaa", ROOT_ID);
    const x = makeRun(1001, 0, "peer-A", "XXX", a.id);
    const y = makeRun(1001, 0, "peer-B", "YYY", a.id);

    let state = createDocState();
    state = docReducer(state, { type: "INSERT_RUN", node: a });
    state = docReducer(state, { type: "INSERT_RUN", node: x });
    state = docReducer(state, { type: "INSERT_RUN", node: y });

    const textBefore = reconstruct(state);
    const sizeBefore = state.nodes.size;

    // Replay all inserts
    state = docReducer(state, { type: "INSERT_RUN", node: a });
    state = docReducer(state, { type: "INSERT_RUN", node: x });
    state = docReducer(state, { type: "INSERT_RUN", node: y });

    expect(reconstruct(state)).toBe(textBefore);
    expect(state.nodes.size).toBe(sizeBefore);
  });
});

describe("index.totalLength invariant", () => {
  it("totalLength equals reconstruct(state).length after inserts", () => {
    let state = createDocState();
    const r1 = insertRun(state, 1000, 0, "peer-A", "hello", ROOT_ID);
    state = r1.state;
    const r2 = insertRun(state, 1001, 0, "peer-A", " world", r1.id);
    state = r2.state;

    expect(state.index.totalLength).toBe(reconstruct(state).length);
  });

  it("totalLength equals reconstruct(state).length after splits", () => {
    let state = createDocState();
    const r1 = insertRun(state, 1000, 0, "peer-A", "hello", ROOT_ID);
    state = r1.state;
    state = docReducer(state, { type: "SPLIT", runId: r1.id, offset: 3 });

    expect(state.index.totalLength).toBe(reconstruct(state).length);
  });

  it("totalLength equals reconstruct(state).length after deletes", () => {
    let state = createDocState();
    const r1 = insertRun(state, 1000, 0, "peer-A", "hello", ROOT_ID);
    state = r1.state;
    state = docReducer(state, {
      type: "DELETE_RANGE",
      runId: r1.id,
      offset: 1,
      count: 3,
    });

    expect(state.index.totalLength).toBe(reconstruct(state).length);
  });

  it("totalLength equals reconstruct(state).length after mixed operations", () => {
    let state = createDocState();

    // Insert several runs
    const r1 = insertRun(state, 1000, 0, "peer-A", "abcdef", ROOT_ID);
    state = r1.state;
    const r2 = insertRun(state, 1001, 0, "peer-A", "ghij", r1.id);
    state = r2.state;
    const r3 = insertRun(state, 1002, 0, "peer-B", "klm", ROOT_ID);
    state = r3.state;

    // Split one
    state = docReducer(state, { type: "SPLIT", runId: r1.id, offset: 3 });

    // Delete part of another
    state = docReducer(state, {
      type: "DELETE_RANGE",
      runId: r2.id,
      offset: 1,
      count: 2,
    });

    expect(state.index.totalLength).toBe(reconstruct(state).length);
  });
});

// ---------------------------------------------------------------------------
// Slice 2: Position Index Consistency Oracle
// ---------------------------------------------------------------------------

/**
 * Oracle helper: for every position in [0, totalLength), verify that
 * lookupPosition returns the correct (runId, offset) matching the character
 * at reconstruct(state)[p].
 */
const verifyPositionIndex = (state: DocState): void => {
  const text = reconstruct(state);
  expect(state.index.totalLength).toBe(text.length);

  for (let p = 0; p < text.length; p++) {
    const lookup = lookupPosition(state.index, p);
    expect(lookup).toBeDefined();

    const node = state.nodes.get(lookup!.runId);
    expect(node).toBeDefined();
    expect(node!.deleted).toBe(false);
    expect(lookup!.offset).toBeLessThan(node!.text.length);

    const charFromIndex = node!.text[lookup!.offset];
    const charFromReconstruct = text[p];
    expect(charFromIndex).toBe(charFromReconstruct);
  }

  // Out of bounds should return undefined
  expect(lookupPosition(state.index, -1)).toBeUndefined();
  expect(lookupPosition(state.index, text.length)).toBeUndefined();
};

describe("position index consistency oracle", () => {
  it("simple: three sequential runs", () => {
    let state = createDocState();
    const r1 = insertRun(state, 1000, 0, "peer-A", "abc", ROOT_ID);
    state = r1.state;
    const r2 = insertRun(state, 1001, 0, "peer-A", "def", r1.id);
    state = r2.state;
    const r3 = insertRun(state, 1002, 0, "peer-A", "ghi", r2.id);
    state = r3.state;

    verifyPositionIndex(state);
  });

  it("after splits: insert, split, insert between halves", () => {
    let state = createDocState();
    const r1 = insertRun(state, 1000, 0, "peer-A", "abcdef", ROOT_ID);
    state = r1.state;

    // Split "abcdef" at offset 3 → "abc" | "def"
    state = docReducer(state, { type: "SPLIT", runId: r1.id, offset: 3 });

    // Insert "XY" between the halves (child of left half "abc", higher HLC than split)
    const r2 = insertRun(state, 2000, 0, "peer-A", "XY", r1.id);
    state = r2.state;

    // Should be "abcXYdef"
    expect(reconstruct(state)).toBe("abcXYdef");
    verifyPositionIndex(state);
  });

  it("after partial deletes: multiple runs with deletions", () => {
    let state = createDocState();
    const r1 = insertRun(state, 1000, 0, "peer-A", "hello", ROOT_ID);
    state = r1.state;
    const r2 = insertRun(state, 1001, 0, "peer-A", " world", r1.id);
    state = r2.state;
    const r3 = insertRun(state, 1002, 0, "peer-A", "!!!", r2.id);
    state = r3.state;

    // Delete "ell" from "hello" (offset 1, count 3)
    state = docReducer(state, {
      type: "DELETE_RANGE",
      runId: r1.id,
      offset: 1,
      count: 3,
    });

    // Delete "rl" from " world" (offset 3, count 2)
    state = docReducer(state, {
      type: "DELETE_RANGE",
      runId: r2.id,
      offset: 3,
      count: 2,
    });

    verifyPositionIndex(state);
  });

  it("mixed: inserts + splits + deletes + sibling ordering", () => {
    let state = createDocState();

    // Insert three sibling runs under ROOT with different HLCs
    const r1 = insertRun(state, 1000, 0, "peer-A", "ccc", ROOT_ID);
    state = r1.state;
    const r2 = insertRun(state, 1002, 0, "peer-A", "aaa", ROOT_ID);
    state = r2.state;
    const r3 = insertRun(state, 1001, 0, "peer-B", "bbb", ROOT_ID);
    state = r3.state;

    // Insert a child of "aaa"
    const r4 = insertRun(state, 1003, 0, "peer-A", "ddd", r2.id);
    state = r4.state;

    // Split "bbb" at offset 1 → "b" | "bb"
    state = docReducer(state, { type: "SPLIT", runId: r3.id, offset: 1 });

    // Delete all of "ccc"
    state = docReducer(state, {
      type: "DELETE_RANGE",
      runId: r1.id,
      offset: 0,
      count: 3,
    });

    // Delete first char of "ddd"
    state = docReducer(state, {
      type: "DELETE_RANGE",
      runId: r4.id,
      offset: 0,
      count: 1,
    });

    verifyPositionIndex(state);
  });
});

// ---------------------------------------------------------------------------
// Slice 2: findInsertPosition — between-siblings case
// ---------------------------------------------------------------------------

describe("findInsertPosition — between siblings", () => {
  it("returns correct position for insert between two ROOT children", () => {
    let state = createDocState();

    // Insert "abc" (ts=1000) and "xyz" (ts=1002) as ROOT children
    const r1 = insertRun(state, 1000, 0, "peer-A", "abc", ROOT_ID);
    state = r1.state;
    const r2 = insertRun(state, 1002, 0, "peer-A", "xyz", ROOT_ID);
    state = r2.state;

    // reconstruct = "xyzabc" (higher HLC first)
    expect(reconstruct(state)).toBe("xyzabc");

    // New run with ts=1001 should go between xyz and abc
    const newId = toString({ ts: 1001, count: 0, peerId: "peer-A" });
    const pos = findInsertPosition(state, ROOT_ID, newId);
    expect(pos).toBe(3); // after "xyz", before "abc"
  });

  it("returns correct position between siblings with subtrees", () => {
    let state = createDocState();

    // "aaa" (ts=1000, lower) with child "ddd"
    const r1 = insertRun(state, 1000, 0, "peer-A", "aaa", ROOT_ID);
    state = r1.state;
    const r4 = insertRun(state, 1003, 0, "peer-A", "ddd", r1.id);
    state = r4.state;

    // "ccc" (ts=1002, higher) with child "eee"
    const r3 = insertRun(state, 1002, 0, "peer-A", "ccc", ROOT_ID);
    state = r3.state;
    const r5 = insertRun(state, 1004, 0, "peer-A", "eee", r3.id);
    state = r5.state;

    // reconstruct = "ccceeeaaaddd" (ccc first because higher HLC, then its child eee, then aaa, then ddd)
    expect(reconstruct(state)).toBe("ccceeeaaaddd");

    // New run with ts=1001 should go between ccc-subtree and aaa-subtree
    const newId = toString({ ts: 1001, count: 0, peerId: "peer-A" });
    const pos = findInsertPosition(state, ROOT_ID, newId);
    expect(pos).toBe(6); // after "ccceee" (6 chars), before "aaaddd"
  });
});

// ---------------------------------------------------------------------------
// Slice 2: Step-by-step span structure verification
// ---------------------------------------------------------------------------

describe("span structure after mutations", () => {
  it("tracks spans through insert → insert → split → delete sequence", () => {
    let state = createDocState();

    // Step 1: Insert "hello" → one span
    const r1 = insertRun(state, 1000, 0, "peer-A", "hello", ROOT_ID);
    state = r1.state;
    expect(state.index.spans).toEqual([{ runId: r1.id, length: 5 }]);
    expect(state.index.totalLength).toBe(5);

    // Step 2: Insert "world" after "hello" → two spans
    const r2 = insertRun(state, 1001, 0, "peer-A", "world", r1.id);
    state = r2.state;
    expect(state.index.spans).toEqual([
      { runId: r1.id, length: 5 },
      { runId: r2.id, length: 5 },
    ]);
    expect(state.index.totalLength).toBe(10);

    // Step 3: Split "hello" at offset 3 → three spans
    const splitId = makeSplitId(r1.id, 3);
    state = docReducer(state, { type: "SPLIT", runId: r1.id, offset: 3 });
    expect(state.index.spans).toEqual([
      { runId: r1.id, length: 3 },
      { runId: splitId, length: 2 },
      { runId: r2.id, length: 5 },
    ]);
    expect(state.index.totalLength).toBe(10);

    // Step 4: Delete range in "world" (offset 1, count 3) — deletes "orl"
    // This will split "world" into "w" | "orl" | "d", tombstone "orl"
    state = docReducer(state, {
      type: "DELETE_RANGE",
      runId: r2.id,
      offset: 1,
      count: 3,
    });
    expect(state.index.totalLength).toBe(7);

    // Verify consistency with reconstruct
    expect(state.index.totalLength).toBe(reconstruct(state).length);
    verifyPositionIndex(state);
  });

  it("sibling inserts produce correct span ordering", () => {
    let state = createDocState();

    // Insert "bbb" (ts=1000) as ROOT child
    const r1 = insertRun(state, 1000, 0, "peer-A", "bbb", ROOT_ID);
    state = r1.state;

    // Insert "aaa" (ts=1002) as ROOT child — higher HLC, should come first
    const r2 = insertRun(state, 1002, 0, "peer-A", "aaa", ROOT_ID);
    state = r2.state;
    expect(state.index.spans).toEqual([
      { runId: r2.id, length: 3 }, // "aaa" first (higher HLC)
      { runId: r1.id, length: 3 }, // "bbb" second
    ]);

    // Insert "ccc" (ts=1001) as ROOT child — between aaa and bbb
    const r3 = insertRun(state, 1001, 0, "peer-A", "ccc", ROOT_ID);
    state = r3.state;
    expect(state.index.spans).toEqual([
      { runId: r2.id, length: 3 }, // "aaa" (ts=1002)
      { runId: r3.id, length: 3 }, // "ccc" (ts=1001)
      { runId: r1.id, length: 3 }, // "bbb" (ts=1000)
    ]);

    expect(reconstruct(state)).toBe("aaacccbbb");
    verifyPositionIndex(state);
  });
});

// ---------------------------------------------------------------------------
// EXTEND_RUN tests (run-length coalescing)
// ---------------------------------------------------------------------------

describe("docReducer — EXTEND_RUN", () => {
  it("appends text to an existing run", () => {
    let state = createDocState();
    const r = insertRun(state, 1000, 0, "peer-A", "hel", ROOT_ID);
    state = r.state;

    state = docReducer(state, {
      type: "EXTEND_RUN",
      runId: r.id,
      appendText: "lo",
    });

    expect(reconstruct(state)).toBe("hello");
    expect(state.nodes.get(r.id)!.text).toBe("hello");
  });

  it("grows the span length and totalLength", () => {
    let state = createDocState();
    const r = insertRun(state, 1000, 0, "peer-A", "ab", ROOT_ID);
    state = r.state;

    expect(state.index.totalLength).toBe(2);
    expect(state.index.spans).toEqual([{ runId: r.id, length: 2 }]);

    state = docReducer(state, {
      type: "EXTEND_RUN",
      runId: r.id,
      appendText: "cd",
    });

    expect(state.index.totalLength).toBe(4);
    expect(state.index.spans).toEqual([{ runId: r.id, length: 4 }]);
    expect(reconstruct(state)).toBe("abcd");
  });

  it("does not change node count", () => {
    let state = createDocState();
    const r = insertRun(state, 1000, 0, "peer-A", "a", ROOT_ID);
    state = r.state;

    const nodeCountBefore = state.nodes.size;

    state = docReducer(state, {
      type: "EXTEND_RUN",
      runId: r.id,
      appendText: "bcdef",
    });

    expect(state.nodes.size).toBe(nodeCountBefore);
    expect(reconstruct(state)).toBe("abcdef");
  });

  it("preserves children ordering after extension", () => {
    let state = createDocState();
    // Create "ab" as root child
    const r1 = insertRun(state, 1000, 0, "peer-A", "ab", ROOT_ID);
    state = r1.state;

    // Create "cd" as child of "ab" (typed after "ab")
    const r2 = insertRun(state, 1001, 0, "peer-A", "cd", r1.id);
    state = r2.state;
    expect(reconstruct(state)).toBe("abcd");

    // Extend "cd" (the leaf run)
    state = docReducer(state, {
      type: "EXTEND_RUN",
      runId: r2.id,
      appendText: "ef",
    });

    expect(reconstruct(state)).toBe("abcdef");
    expect(state.nodes.get(r2.id)!.text).toBe("cdef");
  });

  it("is a no-op for a deleted run", () => {
    let state = createDocState();
    const r = insertRun(state, 1000, 0, "peer-A", "abc", ROOT_ID);
    state = r.state;

    // Delete the entire run
    state = docReducer(state, {
      type: "DELETE_RANGE",
      runId: r.id,
      offset: 0,
      count: 3,
    });
    expect(reconstruct(state)).toBe("");

    // Try to extend the deleted run — should be no-op
    state = docReducer(state, {
      type: "EXTEND_RUN",
      runId: r.id,
      appendText: "xyz",
    });

    expect(reconstruct(state)).toBe("");
  });

  it("is a no-op for a nonexistent run", () => {
    const state = createDocState();

    const newState = docReducer(state, {
      type: "EXTEND_RUN",
      runId: "nonexistent",
      appendText: "xyz",
    });

    expect(newState).toBe(state);
  });

  it("multiple sequential extensions produce the correct text", () => {
    let state = createDocState();
    const r = insertRun(state, 1000, 0, "peer-A", "h", ROOT_ID);
    state = r.state;

    // Simulate typing "hello" one character at a time
    for (const char of "ello") {
      state = docReducer(state, {
        type: "EXTEND_RUN",
        runId: r.id,
        appendText: char,
      });
    }

    expect(reconstruct(state)).toBe("hello");
    expect(state.nodes.get(r.id)!.text).toBe("hello");
    expect(state.nodes.size).toBe(2); // ROOT + 1 run (not 5)
    expect(state.index.spans).toEqual([{ runId: r.id, length: 5 }]);
  });

  it("works correctly alongside other runs", () => {
    let state = createDocState();

    // Peer-A inserts "abc"
    const r1 = insertRun(state, 1000, 0, "peer-A", "a", ROOT_ID);
    state = r1.state;
    state = docReducer(state, { type: "EXTEND_RUN", runId: r1.id, appendText: "bc" });
    expect(reconstruct(state)).toBe("abc");

    // Peer-B inserts "xyz" after "abc" (child of r1)
    const r2 = insertRun(state, 1001, 0, "peer-B", "xyz", r1.id);
    state = r2.state;
    expect(reconstruct(state)).toBe("abcxyz");

    // Both runs have correct text
    expect(state.nodes.get(r1.id)!.text).toBe("abc");
    expect(state.nodes.get(r2.id)!.text).toBe("xyz");
    expect(state.nodes.size).toBe(3); // ROOT + 2 runs
  });

  it("position index is consistent after extension", () => {
    let state = createDocState();
    const r = insertRun(state, 1000, 0, "peer-A", "h", ROOT_ID);
    state = r.state;

    for (const char of "ello world") {
      state = docReducer(state, {
        type: "EXTEND_RUN",
        runId: r.id,
        appendText: char,
      });
    }

    verifyPositionIndex(state);
  });
});
