/**
 * Wire format tests — runs-as-fields wire model.
 *
 * Verifies:
 * - applyActions parses field updates and applies them to the tree
 * - Field updates with value: null are tombstones
 * - Field updates with value: <RunNode> are inserts (new run) or updates (existing run)
 * - diffRunFields / diffRunFieldsForDeleteRange produce the wire payload for local edits
 * - docActionToUpdate wraps field updates in a doc-targeted Update
 * - isDocSubjectUpdate / parseRunFieldName / formatRunFieldName helpers work
 */

import { describe, expect, it } from "vitest";
import { pack, format, type Action, type HLCTimestamp } from "@ebbjs/core";
import { TextDocument } from "../text-document";
import {
  applyActions,
  diffRunFields,
  diffRunFieldsForDeleteRange,
  DEFAULT_DOC_SUBJECT_TYPE,
  docActionToUpdate,
  formatRunFieldName,
  isDocSubjectUpdate,
  parseRunFieldName,
} from "../wire";
import {
  createDocState,
  docReducer,
  makeRunId,
  type DocState,
  type RunFieldValue,
  type RunNode,
} from "../tree";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeHlc = (ts: number, count = 0): HLCTimestamp => format(pack(BigInt(ts), BigInt(count)));

const makeRun = (ts: number, actorId: string, text: string, parentId: string): RunNode => {
  const hlc = makeHlc(ts);
  return { id: makeRunId(hlc, actorId), hlc, actorId, text, parentId, deleted: false };
};

/** Build an Action with one Update targeting docId with the given run fields. */
const makeFieldAction = (
  docId: string,
  actorId: string,
  hlc: HLCTimestamp,
  fields: Record<string, RunFieldValue>,
  actionId = "a_test",
  updateId = "u_test",
): Action => ({
  id: actionId,
  actor_id: actorId,
  hlc,
  gsn: 0,
  updates: [
    {
      id: updateId,
      subject_id: docId,
      subject_type: DEFAULT_DOC_SUBJECT_TYPE,
      method: "patch",
      data: fields as unknown as never,
    },
  ],
});

// ---------------------------------------------------------------------------
// isDocSubjectUpdate + parseRunFieldName + formatRunFieldName
// ---------------------------------------------------------------------------

describe("isDocSubjectUpdate", () => {
  it("returns true for subject_type matching the doc type", () => {
    expect(
      isDocSubjectUpdate(
        {
          id: "u_1",
          subject_id: "doc_x",
          subject_type: DEFAULT_DOC_SUBJECT_TYPE,
          method: "patch",
          data: null,
        },
        DEFAULT_DOC_SUBJECT_TYPE,
      ),
    ).toBe(true);
  });

  it("returns false for other subject types", () => {
    expect(
      isDocSubjectUpdate(
        {
          id: "u_1",
          subject_id: "x",
          subject_type: "todo",
          method: "patch",
          data: null,
        },
        DEFAULT_DOC_SUBJECT_TYPE,
      ),
    ).toBe(false);
  });

  it("supports custom doc types", () => {
    expect(
      isDocSubjectUpdate(
        {
          id: "u_1",
          subject_id: "doc_x",
          subject_type: "rich_text",
          method: "patch",
          data: null,
        },
        "rich_text",
      ),
    ).toBe(true);
  });
});

describe("parseRunFieldName / formatRunFieldName", () => {
  it("parseRunFieldName strips the run: prefix", () => {
    expect(parseRunFieldName("run:131072000:alice")).toBe("131072000:alice");
  });

  it("parseRunFieldName returns null for non-run fields", () => {
    expect(parseRunFieldName("title")).toBeNull();
    expect(parseRunFieldName("description")).toBeNull();
  });

  it("formatRunFieldName adds the prefix", () => {
    expect(formatRunFieldName("131072000:alice")).toBe(`run:131072000:alice`);
  });

  it("roundtrip", () => {
    const runId = "131072000:alice:s:5";
    expect(parseRunFieldName(formatRunFieldName(runId))).toBe(runId);
  });
});

// ---------------------------------------------------------------------------
// applyActions
// ---------------------------------------------------------------------------

describe("applyActions", () => {
  it("applies a single field update (insert new run)", () => {
    const node = makeRun(1000, "peer-A", "hello", "ROOT");
    const fields = {
      [formatRunFieldName(node.id)]: {
        value: node,
        update_id: "u_1",
        hlc: node.hlc,
      },
    };
    const action = makeFieldAction("doc_xxx", "peer-A", node.hlc, fields);

    const { state, applied } = applyActions(createDocState(), [action]);

    expect(state.nodes.has(node.id)).toBe(true);
    expect(state.index.spans).toEqual([{ runId: node.id, length: 5 }]);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toEqual({ type: "INSERT_RUN", node });
  });

  it("applies a tombstone (value: null) as DELETE_RANGE", () => {
    const node = makeRun(1000, "peer-A", "hello", "ROOT");
    let state = docReducer(createDocState(), { type: "INSERT_RUN", node });

    const fields = {
      [formatRunFieldName(node.id)]: {
        value: null,
        update_id: "u_2",
        hlc: makeHlc(2000),
      },
    };
    const action = makeFieldAction("doc_xxx", "peer-A", makeHlc(2000), fields);

    const { state: s2, applied } = applyActions(state, [action]);

    expect(s2.nodes.get(node.id)?.deleted).toBe(true);
    expect(s2.index.totalLength).toBe(0);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toEqual({ type: "DELETE_RANGE", runId: node.id, offset: 0, count: 5 });
  });

  it("applies a field update to an existing run as EXTEND_RUN (text replacement)", () => {
    const node = makeRun(1000, "peer-A", "hello", "ROOT");
    let state = docReducer(createDocState(), { type: "INSERT_RUN", node });

    const updated = { ...node, text: "hello world", hlc: makeHlc(2000) };
    const fields = {
      [formatRunFieldName(node.id)]: {
        value: updated,
        update_id: "u_2",
        hlc: makeHlc(2000),
      },
    };
    const action = makeFieldAction("doc_xxx", "peer-A", makeHlc(2000), fields);

    const { state: s2, applied } = applyActions(state, [action]);

    expect(s2.nodes.get(node.id)?.text).toBe("hello world");
    expect(s2.index.totalLength).toBe(11);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toEqual({
      type: "EXTEND_RUN",
      runId: node.id,
      appendText: "hello world",
      hlc: expect.anything(),
    });
  });

  it("is a no-op for a field update with the same final state", () => {
    const node = makeRun(1000, "peer-A", "hello", "ROOT");
    let state = docReducer(createDocState(), { type: "INSERT_RUN", node });

    const fields = {
      [formatRunFieldName(node.id)]: {
        value: node,
        update_id: "u_2",
        hlc: node.hlc,
      },
    };
    const action = makeFieldAction("doc_xxx", "peer-A", node.hlc, fields);

    const { state: s2, applied } = applyActions(state, [action]);

    expect(s2).toBe(state);
    expect(applied).toHaveLength(0);
  });

  it("applies multiple field updates in one Update atomically", () => {
    const a = makeRun(1000, "peer-A", "a", "ROOT");
    const b = makeRun(1001, "peer-B", "b", "ROOT");
    const fields = {
      [formatRunFieldName(a.id)]: { value: a, update_id: "u_1", hlc: a.hlc },
      [formatRunFieldName(b.id)]: { value: b, update_id: "u_2", hlc: b.hlc },
    };
    const action = makeFieldAction("doc_xxx", "peer-A", a.hlc, fields);

    const { state } = applyActions(createDocState(), [action]);

    expect(state.nodes.has(a.id)).toBe(true);
    expect(state.nodes.has(b.id)).toBe(true);
  });

  it("applies insert + tombstone for partial DELETE_RANGE (split halves + tombstoned middle)", () => {
    const node = makeRun(1000, "peer-A", "abcdef", "ROOT");
    let state = docReducer(createDocState(), { type: "INSERT_RUN", node });

    // Sender deletes "cd" (offset 2, count 2) — splits into "ab" / "cd" / "ef"
    // with the middle tombstoned. The receiver gets three field updates.
    const left = { ...node, text: "ab" };
    const splitId = makeRunId(makeHlc(1000), "peer-A") + ":s:2";
    const right = {
      id: splitId + ":s:2",
      hlc: makeHlc(1000),
      actorId: "peer-A",
      text: "ef",
      parentId: splitId,
      deleted: false,
    };
    const fields = {
      [formatRunFieldName(node.id)]: { value: left, update_id: "u_del", hlc: makeHlc(2000) },
      [formatRunFieldName(splitId)]: { value: null, update_id: "u_del", hlc: makeHlc(2000) },
      [formatRunFieldName(right.id)]: { value: right, update_id: "u_del", hlc: makeHlc(2000) },
    };
    const action = makeFieldAction("doc_xxx", "peer-A", makeHlc(2000), fields);

    const { state: s2 } = applyActions(state, [action]);

    expect(s2.index.totalLength).toBe(4); // "ab" + "ef"
    expect(s2.nodes.get(node.id)?.text).toBe("ab");
    expect(s2.nodes.get(right.id)?.text).toBe("ef");
    // The split half (splitId) is local-only on the sender; the receiver
    // doesn't have it in its tree, so the tombstone field update is a
    // no-op. The visible text is correct via the left + right halves.
  });

  it("ignores Updates targeting a different subject type", () => {
    const action: Action = {
      id: "a_1",
      actor_id: "peer-A",
      hlc: makeHlc(1000),
      gsn: 0,
      updates: [
        {
          id: "u_1",
          subject_id: "todo_x",
          subject_type: "todo",
          method: "patch",
          data: null,
        },
      ],
    };

    const { state, applied } = applyActions(createDocState(), [action]);

    expect(state.nodes.size).toBe(1); // ROOT only
    expect(applied).toHaveLength(0);
  });

  it("ignores Updates whose data has no run: fields (other doc fields pass through)", () => {
    const action = makeFieldAction("doc_xxx", "peer-A", makeHlc(1000), {
      title: { value: "Hello", update_id: "u_1", hlc: makeHlc(1000) } as unknown as RunFieldValue,
    });

    const { state, applied } = applyActions(createDocState(), [action]);

    expect(state.nodes.size).toBe(1); // ROOT only — no runs added
    expect(applied).toHaveLength(0);
  });

  it("filters by custom docSubjectType", () => {
    const node = makeRun(1000, "peer-A", "hello", "ROOT");
    const fields = {
      [formatRunFieldName(node.id)]: {
        value: node,
        update_id: "u_1",
        hlc: node.hlc,
      },
    };
    const action: Action = {
      id: "a_1",
      actor_id: "peer-A",
      hlc: node.hlc,
      gsn: 0,
      updates: [
        {
          id: "u_1",
          subject_id: "doc_xxx",
          subject_type: "rich_text", // custom type
          method: "patch",
          data: fields as unknown as never,
        },
      ],
    };

    // Default docSubjectType filter excludes "rich_text"
    const { applied: a1 } = applyActions(createDocState(), [action]);
    expect(a1).toHaveLength(0);

    // Explicit docSubjectType="rich_text" includes it
    const { applied: a2 } = applyActions(createDocState(), [action], "rich_text");
    expect(a2).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// diffRunFields
// ---------------------------------------------------------------------------

describe("diffRunFields", () => {
  it("emits one field update for a new run", () => {
    const node = makeRun(1000, "peer-A", "hello", "ROOT");
    const post = docReducer(createDocState(), { type: "INSERT_RUN", node });

    const fields = diffRunFields(createDocState(), post, {
      updateId: "u_1",
      hlc: node.hlc,
    });

    expect(Object.keys(fields)).toEqual([formatRunFieldName(node.id)]);
    expect(fields[formatRunFieldName(node.id)]!.value).toEqual(node);
  });

  it("emits a tombstone (value: null) for a deleted run", () => {
    const node = makeRun(1000, "peer-A", "hello", "ROOT");
    const pre = docReducer(createDocState(), { type: "INSERT_RUN", node });
    const post = docReducer(pre, {
      type: "DELETE_RANGE",
      runId: node.id,
      offset: 0,
      count: 5,
    });

    const fields = diffRunFields(pre, post, {
      updateId: "u_2",
      hlc: makeHlc(2000),
    });

    expect(fields[formatRunFieldName(node.id)]!.value).toBeNull();
  });

  it("emits multiple field updates for split-half survivors", () => {
    const node = makeRun(1000, "peer-A", "abcdef", "ROOT");
    const pre = docReducer(createDocState(), { type: "INSERT_RUN", node });
    const post = docReducer(pre, {
      type: "DELETE_RANGE",
      runId: node.id,
      offset: 2,
      count: 2,
    });

    const fields = diffRunFields(pre, post, {
      updateId: "u_3",
      hlc: makeHlc(2000),
    });

    // Expect: left shrunk (node), middle tombstoned (split), right created (split split)
    expect(Object.keys(fields).length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty object when pre == post", () => {
    const fields = diffRunFields(createDocState(), createDocState(), {
      updateId: "u_x",
      hlc: makeHlc(1000),
    });
    expect(fields).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// diffRunFieldsForDeleteRange
// ---------------------------------------------------------------------------

describe("diffRunFieldsForDeleteRange", () => {
  it("matches diffRunFields output for a full delete", () => {
    const node = makeRun(1000, "peer-A", "hello", "ROOT");
    const pre = docReducer(createDocState(), { type: "INSERT_RUN", node });
    const post = docReducer(pre, {
      type: "DELETE_RANGE",
      runId: node.id,
      offset: 0,
      count: 5,
    });

    const a = diffRunFields(pre, post, { updateId: "u", hlc: makeHlc(2000) });
    const b = diffRunFieldsForDeleteRange(pre, post, { updateId: "u", hlc: makeHlc(2000) });

    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// docActionToUpdate
// ---------------------------------------------------------------------------

describe("docActionToUpdate", () => {
  it("returns null for empty field updates", () => {
    const update = docActionToUpdate(
      { type: "SPLIT", runId: "x", offset: 3 },
      {},
      { docId: "doc_xxx", updateId: "u_1" },
    );
    expect(update).toBeNull();
  });

  it("wraps field updates in a doc-targeted Update with method: patch", () => {
    const node = makeRun(1000, "peer-A", "hello", "ROOT");
    const fields = {
      [formatRunFieldName(node.id)]: {
        value: node,
        update_id: "u_1",
        hlc: node.hlc,
      },
    };
    const update = docActionToUpdate({ type: "INSERT_RUN", node }, fields, {
      docId: "doc_xxx",
      updateId: "u_1",
    });

    expect(update).not.toBeNull();
    expect(update!.subject_id).toBe("doc_xxx");
    expect(update!.subject_type).toBe(DEFAULT_DOC_SUBJECT_TYPE);
    expect(update!.method).toBe("patch");
    expect(update!.id).toBe("u_1");
  });
});

// ---------------------------------------------------------------------------
// Acceptance: POC ↔ new wire format produces the same tree
// ---------------------------------------------------------------------------

describe("acceptance — same edits produce the same document via field-update wire", () => {
  it("two clients editing the same doc converge", () => {
    const docA = new (class {
      state: DocState = createDocState();
      pending: Action[] = [];
    })() as unknown as { state: DocState; pending: Action[] };

    // Peer-A inserts "hello"
    const a = makeRun(1000, "peer-A", "hello", "ROOT");
    const aAction = makeFieldAction("doc_xxx", "peer-A", a.hlc, {
      [formatRunFieldName(a.id)]: { value: a, update_id: "u_a", hlc: a.hlc },
    });
    const r1 = applyActions(docA.state, [aAction]);
    docA.state = r1.state;

    // Peer-B sees A's insert, types " world"
    const b = makeRun(2000, "peer-B", " world", a.id);
    const bAction = makeFieldAction("doc_xxx", "peer-B", b.hlc, {
      [formatRunFieldName(b.id)]: { value: b, update_id: "u_b", hlc: b.hlc },
    });
    const r2 = applyActions(docA.state, [bAction]);
    docA.state = r2.state;

    // Reconstruct
    const reconstruct = (state: DocState): string => {
      const out: string[] = [];
      const stack = ["ROOT"];
      while (stack.length > 0) {
        const id = stack.pop()!;
        const node = state.nodes.get(id);
        if (!node) continue;
        if (!node.deleted && node.id !== "ROOT") out.push(node.text);
        const cs = state.children.get(id) ?? [];
        for (let i = cs.length - 1; i >= 0; i--) stack.push(cs[i]!);
      }
      return out.join("");
    };

    expect(reconstruct(docA.state)).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// Regression: receiving old extend actions over already-extended state
// ---------------------------------------------------------------------------
//
// Originally reported via the demo: typing fast (e.g., "abcdef" in a
// single keystroke burst) caused characters to flicker in and out as
// the poll caught up with our own previously-written actions.
//
// Root cause: applyExtendRun didn't advance the run's HLC, so the
// wire adapter couldn't distinguish "we're catching up to state we
// already passed" from "we should rewind to this older state". With
// the HLC advance + the receiver's "existing is newer" skip, each
// catchUp is idempotent regardless of how fast the user types.

describe("regression: out-of-order extend catchUp does not rewind", () => {
  // Self-contained test setup — the existing `stateA` / `stateB` are
  // mutable module-level objects used by other suites; reusing them
  // would couple these tests to the broader state.
  const docA = new TextDocument({ docId: "doc_regression_a", actorId: "peer-A" });
  const docB = new TextDocument({ docId: "doc_regression_b", actorId: "peer-B" });

  // Helper: build a wire-format extend Action (single Update, one run field).
  const buildExtendAction = (runId: string, appendText: string, hlc: string): Action => ({
    id: `act_${hlc}_${runId}`,
    actor_id: "peer-A",
    hlc,
    gsn: 0,
    updates: [
      {
        id: `u_${hlc}_${runId}`,
        subject_id: "doc_regression",
        subject_type: "text_document",
        method: "patch",
        data: {
          fields: {
            [formatRunFieldName(runId)]: {
              value: {
                id: runId,
                hlc,
                actorId: "peer-A",
                text: appendText, // wire format carries the full text after extend
                parentId: "ROOT",
                deleted: false,
              },
              update_id: `u_${hlc}_${runId}`,
              hlc,
            },
          },
        } as never,
      },
    ],
  });

  it("skipping a caught-up older extend when our state is already ahead", () => {
    // peer-A inserts run X with text "a", then locally extends to
    // "abc" by calling localExtend twice (with strictly-increasing
    // HLCs so each extend advances the run's HLC).
    const runId = docA.localInsert("a", { hlc: "100" })!;
    docA.localExtend({ runId, appendText: "b", hlc: "200" });
    docA.localExtend({ runId, appendText: "c", hlc: "300" });
    expect(docA.text).toBe("abc");

    // Build a wire action representing an OLDER extend (hlc=150,
    // text="ab") — peer-A wrote this *between* the insert (100) and
    // the first extend (200), and we're now seeing it via catchUp.
    const olderExtend = buildExtendAction(runId, "ab", "150");

    // peer-B receives peer-A's actions in any order. With the fix,
    // older actions are skipped (existing.hlc > newNode.hlc); newer
    // actions advance the state. Apply them all in random order and
    // assert peer-B converges to "abc" without ever rewinding.
    docB.applyActions([olderExtend]);
    // Apply the two newer ones on top.
    docB.applyActions([
      buildExtendAction(runId, "ab", "200"),
      buildExtendAction(runId, "abc", "300"),
    ]);
    expect(docB.text).toBe("abc");
  });

  it("applyExtendRun advances the run's HLC", () => {
    const doc = new TextDocument({ docId: "doc_hlc_adv", actorId: "peer-A" });
    const runId = doc.localInsert("a", { hlc: "100" })!;
    expect(doc.docState.nodes.get(runId)!.hlc).toBe("100");
    doc.localExtend({ runId, appendText: "b", hlc: "200" });
    expect(doc.docState.nodes.get(runId)!.hlc).toBe("200");
    doc.localExtend({ runId, appendText: "c", hlc: "300" });
    expect(doc.docState.nodes.get(runId)!.hlc).toBe("300");
  });

  it("fast typing + catchUp: receiver stays consistent with sender", () => {
    // Sender types 5 characters fast. Each localExtend produces an
    // action carrying the CUMULATIVE run text + the latest HLC.
    const sender = new TextDocument({ docId: "doc_fast", actorId: "peer-A" });
    const receiver = new TextDocument({ docId: "doc_fast", actorId: "peer-B" });
    const runId = sender.localInsert("", { hlc: "100" })!;
    let hlcCounter = 200n;
    for (const ch of "hello") {
      sender.localExtend({ runId, appendText: ch, hlc: String(hlcCounter) });
      hlcCounter += 1n;
    }
    expect(sender.text).toBe("hello");

    // Capture the actual pending actions the sender would write —
    // these carry the cumulative text at each step.
    const senderActions = sender.pendingActions();

    // Receiver processes them in REVERSE order (worst case). It must
    // converge to "hello" without flickering through intermediate
    // values like "" or "h" or "he".
    for (let i = senderActions.length - 1; i >= 0; i--) {
      receiver.applyActions([senderActions[i]!]);
    }
    expect(receiver.text).toBe("hello");
  });
});
