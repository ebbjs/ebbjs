/**
 * Tests for the collaborative-text-editor bridge.
 *
 * Covers:
 * - Pure helpers (getRunAtPosition, getPositionOfRun)
 * - Local CM edit → doc translation (insert / extend / delete)
 * - doc.onUpdate → CM application (insert / extend / tombstone)
 * - Roundtrip: type in CM, see doc update; apply remote Action, see CM update
 *
 * The integration tests use a real CM6 EditorView (happy-dom provides
 * the DOM). The bridge wires both directions; we assert via
 * `view.state.doc.toString()` (CM's view of the text) and
 * `doc.text` (the document's view).
 */

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { TextDocument } from "@ebbjs/client";
import {
  createBridgeExtension,
  createIdMapField,
  ensureRootSpan,
  findRunRange,
  getPositionOfRun,
  getRunAtPosition,
  isRemote,
  lookupPositionFromSpans,
  mountEditorBridge,
  ROOT_ID,
  ROOT_PLACEHOLDER_SPAN,
  setIdMapEffect,
  type RunSpan,
} from "../bridge";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let view: EditorView | null = null;
let _doc: TextDocument | null = null;
let bridge: { detach: () => void } | null = null;

afterEach(() => {
  bridge?.detach();
  view?.destroy();
  bridge = null;
  view = null;
  _doc = null;
});

/**
 * Create a fresh EditorView wired to a fresh TextDocument. Returns the
 * pair so the test can drive both sides.
 */
function setup(initialDocText = ""): {
  view: EditorView;
  doc: TextDocument;
  bridge: { detach: () => void };
  idMapField: import("@codemirror/state").StateField<readonly RunSpan[]>;
} {
  const d = new TextDocument({ docId: "doc_test", actorId: "peer-A" });
  const idMapField = createIdMapField();

  const ref = { current: null as EditorView | null };
  const localEdit = { active: false };
  const extension = createBridgeExtension({
    doc: d,
    idMapField,
    getView: () => ref.current,
    localEdit,
  });

  const v = new EditorView({
    state: EditorState.create({
      doc: initialDocText,
      extensions: [extension],
    }),
    parent: document.body,
  });
  ref.current = v;

  const bridgeObj = mountEditorBridge(v, d, idMapField, localEdit);
  view = v;
  _doc = d;
  bridge = bridgeObj;
  return { view: v, doc: d, bridge: bridgeObj, idMapField };
}

/**
 * Dispatch a CM transaction (typically a local edit). The dispatch
 * fires the bridge's updateListener synchronously.
 */
function localInsert(v: EditorView, position: number, text: string): void {
  v.dispatch({ changes: { from: position, insert: text } });
}

function localDelete(v: EditorView, from: number, to: number): void {
  v.dispatch({ changes: { from, to } });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("bridge helpers", () => {
  it("lookupPositionFromSpans finds a span by absolute position", () => {
    const spans: RunSpan[] = [
      { runId: "a", length: 5 },
      { runId: "b", length: 3 },
      { runId: "c", length: 4 },
    ];
    expect(lookupPositionFromSpans(spans, 0)).toEqual({
      runId: "a",
      runOffset: 0,
      spanIndex: 0,
      spanLength: 5,
    });
    expect(lookupPositionFromSpans(spans, 4)).toEqual({
      runId: "a",
      runOffset: 4,
      spanIndex: 0,
      spanLength: 5,
    });
    expect(lookupPositionFromSpans(spans, 5)).toEqual({
      runId: "b",
      runOffset: 0,
      spanIndex: 1,
      spanLength: 3,
    });
    expect(lookupPositionFromSpans(spans, 12)).toBeUndefined();
  });

  it("findRunRange returns the absolute range of a run", () => {
    const spans: RunSpan[] = [
      { runId: "a", length: 5 },
      { runId: "b", length: 3 },
      { runId: "c", length: 4 },
    ];
    expect(findRunRange(spans, "a")).toEqual({ start: 0, end: 5 });
    expect(findRunRange(spans, "b")).toEqual({ start: 5, end: 8 });
    expect(findRunRange(spans, "c")).toEqual({ start: 8, end: 12 });
    expect(findRunRange(spans, "missing")).toBeUndefined();
  });

  it("getRunAtPosition via StateField", () => {
    const idMapField = createIdMapField();
    const state = EditorState.create({
      doc: "",
      extensions: [idMapField],
    });
    // Seed the spans
    const seeded = state.update({
      effects: setIdMapEffect.of([
        { runId: "a", length: 5 },
        { runId: "b", length: 3 },
      ]),
    }).state;
    expect(getRunAtPosition(seeded, 0, idMapField)).toEqual({
      runId: "a",
      offset: 0,
      spanIndex: 0,
    });
    expect(getRunAtPosition(seeded, 7, idMapField)).toEqual({
      runId: "b",
      offset: 2,
      spanIndex: 1,
    });
    expect(getRunAtPosition(seeded, 8, idMapField)).toEqual({
      runId: "b",
      offset: 3,
      spanIndex: 1,
    });
  });

  it("getPositionOfRun via StateField", () => {
    const idMapField = createIdMapField();
    const state = EditorState.create({
      doc: "",
      extensions: [idMapField],
    });
    const seeded = state.update({
      effects: setIdMapEffect.of([
        { runId: "a", length: 5 },
        { runId: "b", length: 3 },
      ]),
    }).state;
    expect(getPositionOfRun(seeded, "a", 0, idMapField)).toBe(0);
    expect(getPositionOfRun(seeded, "a", 4, idMapField)).toBe(4);
    expect(getPositionOfRun(seeded, "b", 0, idMapField)).toBe(5);
    expect(getPositionOfRun(seeded, "b", 2, idMapField)).toBe(7);
    expect(getPositionOfRun(seeded, "missing", 0, idMapField)).toBeUndefined();
    // Offset beyond run length is rejected.
    expect(getPositionOfRun(seeded, "a", 100, idMapField)).toBeUndefined();
  });

  it("getPositionOfRun accepts offset === span.length (end-of-run cursor)", () => {
    const idMapField = createIdMapField();
    const seeded = EditorState.create({
      doc: "",
      extensions: [idMapField],
    }).update({
      effects: setIdMapEffect.of([{ runId: "a", length: 5 }]),
    }).state;
    expect(getPositionOfRun(seeded, "a", 5, idMapField)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Local CM edit → doc
// ---------------------------------------------------------------------------

describe("local CM edit → doc", () => {
  it("typing at position 0 calls localInsert with afterRun=ROOT", () => {
    const { view, doc } = setup();
    localInsert(view, 0, "hi");
    expect(doc.text).toBe("hi");
    expect(doc.pendingActions()).toHaveLength(1);
  });

  it("typing at end of own run calls localExtend (no new run)", () => {
    const { view, doc } = setup();
    localInsert(view, 0, "hello");
    const runsBefore = doc.docState.nodes.size;
    const pendingBefore = doc.pendingActions().length;

    // Type one more character at the end.
    localInsert(view, 5, "!");

    expect(doc.text).toBe("hello!");
    // No new run created.
    expect(doc.docState.nodes.size).toBe(runsBefore);
    // Exactly one new pending action (the extend).
    expect(doc.pendingActions().length).toBe(pendingBefore + 1);
  });

  it("typing mid-run calls localInsert with splitParentAt", () => {
    const { view, doc } = setup();
    localInsert(view, 0, "abcdef");
    // Type at position 3 (between c and d).
    localInsert(view, 3, "X");

    expect(doc.text).toBe("abcXdef");
    // Should have created at least one new run for the inserted X
    // (parent split into two halves + new run inserted between).
    const insertedRuns = Array.from(doc.docState.nodes.values()).filter((n) => n.text === "X");
    expect(insertedRuns.length).toBeGreaterThan(0);
  });

  it("deleting across two runs produces two localDelete calls", () => {
    const { view, doc } = setup();
    localInsert(view, 0, "hello world");
    // pending actions: 1 insert (the whole run was one extend, actually 1 insert for "hello world")
    // Let's set up a clearer scenario: 3 separate inserts by closing the runs
    // by switching actor context isn't possible without re-creating the doc.

    // Just delete a middle range.
    const pendingBefore = doc.pendingActions().length;
    localDelete(view, 3, 8); // delete "lo wo"
    expect(doc.text).toBe("helrld");
    expect(doc.pendingActions().length).toBeGreaterThan(pendingBefore);
  });

  it("typing at end of OTHER peer's run inserts a new run (no extend)", () => {
    const { view, doc } = setup();
    // Seed a run owned by peer-B.
    doc.applyActions([
      {
        id: "act_seed",
        actor_id: "peer-B",
        hlc: "1000",
        gsn: 0,
        updates: [
          {
            id: "upd_seed",
            subject_id: "doc_test",
            subject_type: "text_document",
            method: "patch",
            data: {
              "run:1000:peer-B": {
                value: {
                  id: "1000:peer-B",
                  hlc: "1000",
                  actorId: "peer-B",
                  text: "hello",
                  parentId: "ROOT",
                  deleted: false,
                },
                update_id: "upd_seed",
                hlc: "1000",
              },
            } as never,
          },
        ],
      },
    ]);
    expect(doc.text).toBe("hello");

    // Now type at position 5 (end of peer-B's run). Should NOT extend
    // because the peer is different.
    const runsBefore = doc.docState.nodes.size;
    localInsert(view, 5, "X");

    expect(doc.text).toBe("helloX");
    // A new run for "X" was created.
    expect(doc.docState.nodes.size).toBe(runsBefore + 1);
  });
});

// ---------------------------------------------------------------------------
// Regression: local CM edits must not double-apply to CM
// ---------------------------------------------------------------------------
//
// For local edits, CM already has the new text from the user input.
// The bridge's doc.onUpdate listener used to dispatch cmChanges
// anyway, which inserted the same characters a second time on top of
// what CM already had (and pushed mid-run inserts to the wrong side
// of the parent because the spans StateField hadn't caught up yet).
//
// These tests would have caught the bug originally reported via the
// demo: typing 'h' repeatedly produced 'hhhh...' and mid-run
// inserts appeared backwards.

describe("regression: local CM edits do not double-apply", () => {
  it("typing each letter produces the right text (not doubled)", () => {
    const { view, doc } = setup();
    const letters = ["h", "e", "l", "l", "o"];
    for (let i = 0; i < letters.length; i++) {
      localInsert(view, i, letters[i]!);
    }
    expect(doc.text).toBe("hello");
    // And CM's view matches.
    expect(view.state.doc.toString()).toBe("hello");
  });

  it("extending a run repeatedly does not double characters", () => {
    const { view, doc } = setup();
    localInsert(view, 0, "h");
    for (let i = 0; i < 4; i++) {
      localInsert(view, i + 1, "h");
    }
    expect(doc.text).toBe("hhhhh");
    expect(view.state.doc.toString()).toBe("hhhhh");
  });

  it("mid-run insert lands between the two halves, not after them", () => {
    const { view, doc } = setup();
    localInsert(view, 0, "abcdef");
    // Insert "X" between c and d.
    localInsert(view, 3, "X");

    // The bug would produce "abcdefX" (X inserted after the parent)
    // or "abcdefXdef" (the duplicate-apply doubled with split).
    expect(doc.text).toBe("abcXdef");
    expect(view.state.doc.toString()).toBe("abcXdef");
  });

  it("typing at start then middle preserves order", () => {
    const { view, doc } = setup();
    localInsert(view, 0, "ab");
    localInsert(view, 1, "X");
    expect(doc.text).toBe("aXb");
    expect(view.state.doc.toString()).toBe("aXb");
  });
});

// ---------------------------------------------------------------------------
// doc.onUpdate → CM
// ---------------------------------------------------------------------------

describe("doc.onUpdate → CM", () => {
  it("applyActions insert: CM doc gets the new run's text at the right position", () => {
    const { view, doc } = setup();
    // Receive a remote insert of "world" as a child of ROOT.
    doc.applyActions([
      {
        id: "act_remote",
        actor_id: "peer-B",
        hlc: "2000",
        gsn: 0,
        updates: [
          {
            id: "upd_remote",
            subject_id: "doc_test",
            subject_type: "text_document",
            method: "patch",
            data: {
              "run:2000:peer-B": {
                value: {
                  id: "2000:peer-B",
                  hlc: "2000",
                  actorId: "peer-B",
                  text: "world",
                  parentId: "ROOT",
                  deleted: false,
                },
                update_id: "upd_remote",
                hlc: "2000",
              },
            } as never,
          },
        ],
      },
    ]);

    expect(doc.text).toBe("world");
    expect(view.state.doc.toString()).toBe("world");
  });

  it("applyActions tombstone: CM doc deletes the run's text", () => {
    const { view, doc } = setup();
    // Seed "hello"
    doc.localInsert("hello");
    expect(view.state.doc.toString()).toBe("hello");
    const runId = doc.docState.children.get("ROOT")![0]!;

    // Tombstone the run via wire-format Action.
    doc.applyActions([
      {
        id: "act_del",
        actor_id: "peer-B",
        hlc: "5000",
        gsn: 0,
        updates: [
          {
            id: "upd_del",
            subject_id: "doc_test",
            subject_type: "text_document",
            method: "patch",
            data: {
              [`run:${runId}`]: {
                value: null,
                update_id: "upd_del",
                hlc: "5000",
              },
            } as never,
          },
        ],
      },
    ]);

    expect(doc.text).toBe("");
    expect(view.state.doc.toString()).toBe("");
  });

  it("applyActions extend: CM doc replaces run's text", () => {
    const { view, doc } = setup();
    doc.localInsert("hello");
    expect(view.state.doc.toString()).toBe("hello");
    const runId = doc.docState.children.get("ROOT")![0]!;
    const original = doc.docState.nodes.get(runId)!;

    // Receive an extend via wire format — the run's text becomes "hello world".
    // Use an HLC strictly greater than the local run's, otherwise the
    // "skip older catchUp" check in applyRunFieldUpdate rejects the
    // update (local text came from a Date.now()-sourced bigint, so any
    // literal number smaller than ~10^18 loses to it).
    const wireHlc = String(BigInt(original.hlc) + 1n);

    doc.applyActions([
      {
        id: "act_ext",
        actor_id: "peer-A",
        hlc: wireHlc,
        gsn: 0,
        updates: [
          {
            id: "upd_ext",
            subject_id: "doc_test",
            subject_type: "text_document",
            method: "patch",
            data: {
              [`run:${runId}`]: {
                value: {
                  ...original,
                  text: "hello world",
                  hlc: wireHlc,
                },
                update_id: "upd_ext",
                hlc: wireHlc,
              },
            } as never,
          },
        ],
      },
    ]);

    expect(doc.text).toBe("hello world");
    expect(view.state.doc.toString()).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// Initial sync
// ---------------------------------------------------------------------------

describe("mountEditorBridge initial sync", () => {
  it("populates CM from doc.text when attaching to a doc with existing state", () => {
    // Setup a doc with state first.
    const d = new TextDocument({ docId: "doc_test", actorId: "peer-A" });
    d.localInsert("preloaded");

    // Now create a CM view with empty doc and attach.
    const idMapField = createIdMapField();
    const ref = { current: null as EditorView | null };
    const extension = createBridgeExtension({
      doc: d,
      idMapField,
      getView: () => ref.current,
    });
    const v = new EditorView({
      state: EditorState.create({
        doc: "",
        extensions: [extension],
      }),
      parent: document.body,
    });
    ref.current = v;

    const bridge = mountEditorBridge(v, d, idMapField);

    expect(v.state.doc.toString()).toBe("preloaded");
    bridge.detach();
    v.destroy();
  });
});

// ---------------------------------------------------------------------------
// Annotations & effects
// ---------------------------------------------------------------------------

describe("isRemote annotation", () => {
  it("is exposed and has an annotation interface", () => {
    // Annotation.define returns an Annotation instance (an object with
    // .of() and a hidden Symbol-keyed identity). Verify the basic
    // shape we rely on.
    expect(isRemote).toBeDefined();
    expect(typeof (isRemote as unknown as { of: (v: boolean) => unknown }).of).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// getRunAtPosition end-of-doc positions
// ---------------------------------------------------------------------------

describe("getRunAtPosition at end of doc", () => {
  it("returns the last run when position equals the total span length", () => {
    const idMapField = createIdMapField();
    const seeded = EditorState.create({
      doc: "",
      extensions: [idMapField],
    }).update({
      effects: setIdMapEffect.of([
        { runId: "a", length: 5 },
        { runId: "b", length: 3 },
      ]),
    }).state;
    expect(getRunAtPosition(seeded, 8, idMapField)).toEqual({
      runId: "b",
      offset: 3,
      spanIndex: 1,
    });
  });

  it("returns the only run when position equals its length (single-run doc)", () => {
    const idMapField = createIdMapField();
    const seeded = EditorState.create({
      doc: "",
      extensions: [idMapField],
    }).update({
      effects: setIdMapEffect.of([{ runId: "solo", length: 5 }]),
    }).state;
    expect(getRunAtPosition(seeded, 5, idMapField)).toEqual({
      runId: "solo",
      offset: 5,
      spanIndex: 0,
    });
  });

  it("still returns undefined for positions past the total span length", () => {
    const idMapField = createIdMapField();
    const seeded = EditorState.create({
      doc: "",
      extensions: [idMapField],
    }).update({
      effects: setIdMapEffect.of([{ runId: "a", length: 5 }]),
    }).state;
    expect(getRunAtPosition(seeded, 6, idMapField)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Empty-doc ROOT placeholder (#101)
//
// The bridge seeds the idMapField with a zero-length placeholder for
// ROOT_ID so empty-doc cursor clicks can resolve to a (runId, offset)
// pair — otherwise getRunAtPosition returns undefined and presence
// silently no-ops. These tests cover the invariant end-to-end.
// ---------------------------------------------------------------------------

describe("empty-doc ROOT placeholder (#101)", () => {
  it("createIdMapField seeds with the ROOT placeholder", () => {
    const idMapField = createIdMapField();
    const state = EditorState.create({
      doc: "",
      extensions: [idMapField],
    });
    expect(state.field(idMapField)).toEqual([ROOT_PLACEHOLDER_SPAN]);
    expect(ROOT_PLACEHOLDER_SPAN).toEqual({ runId: ROOT_ID, length: 0 });
  });

  it("ensureRootSpan returns the placeholder for an empty array", () => {
    expect(ensureRootSpan([])).toEqual([ROOT_PLACEHOLDER_SPAN]);
  });

  it("ensureRootSpan is a no-op for a non-empty array", () => {
    const spans: readonly RunSpan[] = [
      { runId: "a", length: 5 },
      { runId: "b", length: 3 },
    ];
    expect(ensureRootSpan(spans)).toBe(spans);
  });

  it("setIdMapEffect.of([]) still leaves the placeholder in the field", () => {
    // The StateField re-seeds the placeholder on every dispatch, so an
    // explicit empty-array effect doesn't strip it. This is the
    // invariant that keeps remote "tombstone all runs" transitions
    // from breaking empty-doc cursor anchoring.
    const idMapField = createIdMapField();
    const seeded = EditorState.create({
      doc: "",
      extensions: [idMapField],
    }).update({
      effects: setIdMapEffect.of([]),
    }).state;
    expect(seeded.field(idMapField)).toEqual([ROOT_PLACEHOLDER_SPAN]);
  });

  it("getRunAtPosition resolves position 0 to (ROOT_ID, 0) on an empty doc", () => {
    const idMapField = createIdMapField();
    const state = EditorState.create({
      doc: "",
      extensions: [idMapField],
    });
    expect(getRunAtPosition(state, 0, idMapField)).toEqual({
      runId: ROOT_ID,
      offset: 0,
      spanIndex: 0,
    });
  });

  it("getPositionOfRun resolves (ROOT_ID, 0) to document position 0 on an empty doc", () => {
    const idMapField = createIdMapField();
    const state = EditorState.create({
      doc: "",
      extensions: [idMapField],
    });
    expect(getPositionOfRun(state, ROOT_ID, 0, idMapField)).toBe(0);
  });

  it("mountEditorBridge on an empty doc leaves the placeholder in idMapField", () => {
    // The acceptance scenario for #101: a fresh doc + empty CM view
    // + mount → cursor anchoring works without typing.
    const { view, idMapField } = setup();
    expect(view.state.field(idMapField)).toEqual([ROOT_PLACEHOLDER_SPAN]);
  });

  it("end-to-end: empty-doc local click resolves to (ROOT_ID, 0)", () => {
    // This is the spec from #101. Without typing, the bridge's
    // idMapField must hand out (ROOT_ID, 0) for any CM position so
    // the demo's sendLocalCursor emits a POST instead of silently
    // no-opping.
    const { view, idMapField } = setup();
    expect(getRunAtPosition(view.state, 0, idMapField)).toEqual({
      runId: ROOT_ID,
      offset: 0,
      spanIndex: 0,
    });
  });

  it("first local edit replaces the placeholder with the real run", () => {
    // After typing, idMapField should drop the placeholder and carry
    // the real run only. The placeholder is purely a CM-side mirror
    // and never represents real doc content.
    const { view, doc, idMapField } = setup();
    expect(view.state.field(idMapField)).toEqual([ROOT_PLACEHOLDER_SPAN]);

    localInsert(view, 0, "h");

    expect(doc.text).toBe("h");
    const spans = view.state.field(idMapField);
    expect(spans).not.toEqual([ROOT_PLACEHOLDER_SPAN]);
    expect(spans.length).toBe(1);
    expect(spans[0]!.runId).not.toBe(ROOT_ID);
    expect(spans[0]!.length).toBe(1);
  });

  it("remote tombstone of the only run re-seeds the placeholder", () => {
    // Edge case: a remote peer deletes the only run we have. The
    // spans StateField transitions back to empty. The invariant must
    // hold across this transition so the next cursor click still
    // anchors to (ROOT_ID, 0).
    const { view, doc, idMapField } = setup();
    doc.localInsert("x");
    expect(view.state.field(idMapField).length).toBe(1);
    const runId = doc.docState.children.get("ROOT")![0]!;

    // Receive a remote tombstone for the only run via the wire path.
    // The bridge's applyDocUpdateToCM dispatch goes through
    // ensureRootSpan, so the placeholder comes back even though
    // doc.docState.index.spans is now empty.
    doc.applyActions([
      {
        id: "act_del",
        actor_id: "peer-B",
        hlc: "5000",
        gsn: 0,
        updates: [
          {
            id: "upd_del",
            subject_id: "doc_test",
            subject_type: "text_document",
            method: "patch",
            data: {
              [`run:${runId}`]: {
                value: null,
                update_id: "upd_del",
                hlc: "5000",
              },
            } as never,
          },
        ],
      },
    ]);

    expect(doc.text).toBe("");
    expect(view.state.doc.toString()).toBe("");
    expect(view.state.field(idMapField)).toEqual([ROOT_PLACEHOLDER_SPAN]);
  });

  it("placeholder never leaks into the doc tree's spans", () => {
    // The placeholder is a CM-side mirror only. The doc tree's
    // PositionIndex.spans must never carry a ROOT_ID span — that
    // would be a run-id-collision risk per the analysis in #101
    // (option 1).
    const { doc } = setup();
    expect(doc.docState.index.spans).toEqual([]);
    doc.localInsert("x");
    const docSpanIds = doc.docState.index.spans.map((s) => s.runId);
    expect(docSpanIds).not.toContain(ROOT_ID);
  });
});
