/**
 * Tests for the collaborative-text-editor bridge.
 *
 * Covers:
 * - Pure helpers (lookupPositionFromSpans, getRunAtPosition, getPositionOfRun),
 *   including runs that project to more than one span.
 * - Local CM edit → doc translation (insert / extend / cut)
 * - doc.onUpdate → CM application (insert / cut): CM must end up equal to
 *   `doc.text` after every event.
 *
 * The integration tests use a real CM6 EditorView (happy-dom provides
 * the DOM). The bridge wires both directions; we assert via
 * `view.state.doc.toString()` (CM's view of the text) and
 * `doc.text` (the document's view).
 */

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { TextDocument, type TextCell } from "@ebbjs/client";
import type { Action } from "@ebbjs/core";
import {
  createBridgeExtension,
  createIdMapField,
  ensureRootSpan,
  getPositionOfRun,
  getRunAtPosition,
  lookupPositionFromSpans,
  mountEditorBridge,
  ROOT_ID,
  ROOT_PLACEHOLDER_SPAN,
  setIdMapEffect,
  type RunSpan,
} from "./bridge";

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
 * A run split by a sibling anchored in the middle. Renders
 * "hello" + "XYZ" + "!!": run `a` yields two spans, `b` one.
 */
const SPLIT_SPANS: RunSpan[] = [
  { runId: "a", offset: 0, length: 5 },
  { runId: "b", offset: 0, length: 3 },
  { runId: "a", offset: 5, length: 2 },
];

/** Build a run cell. */
function runCell(opts: {
  id: string;
  text: string;
  author: string;
  stamp: string;
  parentId: string;
  offset: number;
}): TextCell {
  return {
    kind: "run",
    id: opts.id,
    text: opts.text,
    author: opts.author,
    stamp: opts.stamp,
    anchor: { runId: opts.parentId, offset: opts.offset },
  };
}

/** Build a cut cell retracting `[from, to)` of one run. */
function cutCell(opts: {
  id: string;
  runId: string;
  from: number;
  to: number;
  author: string;
  stamp: string;
}): TextCell {
  return {
    kind: "cut",
    id: opts.id,
    runId: opts.runId,
    from: opts.from,
    to: opts.to,
    author: opts.author,
    stamp: opts.stamp,
  };
}

/** Wrap cells in the wire's Action shape. */
function wireAction(actionId: string, cells: readonly TextCell[]): Action {
  const hlc = cells[0]!.stamp;
  return {
    id: actionId,
    actor_id: cells[0]!.author,
    hlc,
    gsn: 0,
    updates: [
      {
        id: `${actionId}_update`,
        subject_id: "doc_test",
        component: "text_document/content",
        method: "merge",
        data: {
          map: Object.fromEntries(
            cells.map((cell) => [
              cell.id,
              { value: cell, update_id: `${actionId}_update`, hlc: cell.stamp },
            ]),
          ),
        },
      },
      {
        id: `${actionId}_version`,
        subject_id: "doc_test",
        component: "text_document/version",
        method: "merge",
        data: { value: 1, update_id: `${actionId}_version`, hlc },
      },
    ],
  };
}

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
  it("lookupPositionFromSpans reports run-text offsets, per fragment", () => {
    expect(lookupPositionFromSpans(SPLIT_SPANS, 0)).toEqual({
      runId: "a",
      runOffset: 0,
      spanIndex: 0,
      spanLength: 5,
    });
    expect(lookupPositionFromSpans(SPLIT_SPANS, 4)).toEqual({
      runId: "a",
      runOffset: 4,
      spanIndex: 0,
      spanLength: 5,
    });
    expect(lookupPositionFromSpans(SPLIT_SPANS, 5)).toEqual({
      runId: "b",
      runOffset: 0,
      spanIndex: 1,
      spanLength: 3,
    });
    // Second fragment of run "a": offset is relative to the run's text.
    expect(lookupPositionFromSpans(SPLIT_SPANS, 8)).toEqual({
      runId: "a",
      runOffset: 5,
      spanIndex: 2,
      spanLength: 2,
    });
    expect(lookupPositionFromSpans(SPLIT_SPANS, 9)).toEqual({
      runId: "a",
      runOffset: 6,
      spanIndex: 2,
      spanLength: 2,
    });
    expect(lookupPositionFromSpans(SPLIT_SPANS, 10)).toBeUndefined();
  });

  it("getRunAtPosition resolves run-text offsets across fragments", () => {
    const idMapField = createIdMapField();
    const seeded = EditorState.create({
      doc: "",
      extensions: [idMapField],
    }).update({
      effects: setIdMapEffect.of(SPLIT_SPANS),
    }).state;

    expect(getRunAtPosition(seeded, 0, idMapField)).toEqual({
      runId: "a",
      offset: 0,
      spanIndex: 0,
    });
    expect(getRunAtPosition(seeded, 6, idMapField)).toEqual({
      runId: "b",
      offset: 1,
      spanIndex: 1,
    });
    // Second fragment of run "a".
    expect(getRunAtPosition(seeded, 8, idMapField)).toEqual({
      runId: "a",
      offset: 5,
      spanIndex: 2,
    });
    // End of the last fragment.
    expect(getRunAtPosition(seeded, 10, idMapField)).toEqual({
      runId: "a",
      offset: 7,
      spanIndex: 2,
    });
    expect(getRunAtPosition(seeded, 11, idMapField)).toBeUndefined();
  });

  it("getPositionOfRun resolves the offset inside each fragment", () => {
    const idMapField = createIdMapField();
    const seeded = EditorState.create({
      doc: "",
      extensions: [idMapField],
    }).update({
      effects: setIdMapEffect.of(SPLIT_SPANS),
    }).state;

    expect(getPositionOfRun(seeded, "a", 0, idMapField)).toBe(0);
    expect(getPositionOfRun(seeded, "a", 4, idMapField)).toBe(4);
    expect(getPositionOfRun(seeded, "b", 2, idMapField)).toBe(7);
    // Second fragment of run "a".
    expect(getPositionOfRun(seeded, "a", 6, idMapField)).toBe(9);
    // Inclusive end of the last fragment.
    expect(getPositionOfRun(seeded, "a", 7, idMapField)).toBe(10);
    // Beyond the run's visible offsets.
    expect(getPositionOfRun(seeded, "a", 8, idMapField)).toBeUndefined();
    expect(getPositionOfRun(seeded, "missing", 0, idMapField)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Local CM edit → doc
// ---------------------------------------------------------------------------

describe("local CM edit → doc", () => {
  it("typing at position 0 anchors a new run at ROOT", () => {
    const { view, doc } = setup();
    localInsert(view, 0, "hi");

    expect(doc.text).toBe("hi");
    expect(view.state.doc.toString()).toBe("hi");
    const runs = [...doc.docState.runs.values()];
    expect(runs).toHaveLength(1);
    expect(runs[0]!.anchor).toEqual({ runId: ROOT_ID, offset: 0 });
    expect(doc.pendingActions()).toHaveLength(1);
  });

  it("typing at the end of our leaf run appends an anchored run", () => {
    const { view, doc } = setup();
    localInsert(view, 0, "hello");
    const rootRun = [...doc.docState.runs.values()][0]!;

    localInsert(view, 5, "!");

    expect(doc.text).toBe("hello!");
    expect(view.state.doc.toString()).toBe("hello!");
    // The parent keeps its text; the extension is a new run at its end.
    expect(doc.docState.runs.get(rootRun.id)!.text).toBe("hello");
    const appended = [...doc.docState.runs.values()].find((run) => run.text === "!");
    expect(appended?.anchor).toEqual({ runId: rootRun.id, offset: 5 });
  });

  it("typing mid-run anchors a new run without splitting the parent", () => {
    const { view, doc } = setup();
    localInsert(view, 0, "abcdef");
    const parentId = doc.docState.index.spans[0]!.runId;

    localInsert(view, 3, "X");

    expect(doc.text).toBe("abcXdef");
    expect(view.state.doc.toString()).toBe("abcXdef");
    // Runs are immutable: the parent keeps its full text and id.
    expect(doc.docState.runs.get(parentId)!.text).toBe("abcdef");
    const inserted = [...doc.docState.runs.values()].find((run) => run.text === "X");
    expect(inserted?.anchor).toEqual({ runId: parentId, offset: 3 });
    // The parent now projects to two spans.
    const parentSpans = doc.docState.index.spans.filter((span) => span.runId === parentId);
    expect(parentSpans).toEqual([
      { runId: parentId, offset: 0, length: 3 },
      { runId: parentId, offset: 3, length: 3 },
    ]);
  });

  it("deleting across two runs adds one cut per run", () => {
    const { view, doc } = setup();
    localInsert(view, 0, "hello");
    localInsert(view, 0, ">> ");
    expect(doc.text).toBe(">> hello");

    // Delete " he": the tail of the second run plus the head of the first.
    localDelete(view, 2, 5);

    expect(doc.text).toBe(">>llo");
    expect(view.state.doc.toString()).toBe(">>llo");
    expect(doc.docState.cuts.size).toBe(2);
    for (const intervals of doc.docState.cuts.values()) {
      expect(intervals).toHaveLength(1);
    }
  });

  it("typing at the end of another peer's run anchors a new run", () => {
    const { view, doc } = setup();
    doc.applyActions([
      wireAction("act_seed", [
        runCell({
          id: "1000:peer-B",
          text: "hello",
          author: "peer-B",
          stamp: "1000",
          parentId: ROOT_ID,
          offset: 0,
        }),
      ]),
    ]);
    expect(doc.text).toBe("hello");
    expect(view.state.doc.toString()).toBe("hello");

    localInsert(view, 5, "X");

    expect(doc.text).toBe("helloX");
    expect(view.state.doc.toString()).toBe("helloX");
    expect(doc.docState.runs.size).toBe(2);
    const inserted = [...doc.docState.runs.values()].find((run) => run.text === "X");
    expect(inserted?.anchor).toEqual({ runId: "1000:peer-B", offset: 5 });
  });
});

// ---------------------------------------------------------------------------
// Regression: local CM edits must not double-apply to CM
// ---------------------------------------------------------------------------
//
// For local edits, CM already has the new text from the user input.
// The bridge's doc.onUpdate listener used to dispatch a text change
// anyway, which inserted the same characters a second time on top of
// what CM already had (and pushed mid-run inserts to the wrong side
// of the parent because the spans StateField hadn't caught up yet).
//
// This test would have caught the bug originally reported via the demo:
// typing 'h' repeatedly produced 'hhhh...'.

describe("regression: local CM edits do not double-apply", () => {
  it("extending a run repeatedly does not double characters", () => {
    const { view, doc } = setup();
    localInsert(view, 0, "h");
    for (let i = 0; i < 4; i++) {
      localInsert(view, i + 1, "h");
    }
    expect(doc.text).toBe("hhhhh");
    expect(view.state.doc.toString()).toBe("hhhhh");
  });
});

// ---------------------------------------------------------------------------
// doc.onUpdate → CM
// ---------------------------------------------------------------------------

describe("doc.onUpdate → CM", () => {
  it("remote insert at ROOT: CM text equals doc.text", () => {
    const { view, doc } = setup();

    doc.applyActions([
      wireAction("act_remote", [
        runCell({
          id: "2000:peer-B",
          text: "world",
          author: "peer-B",
          stamp: "2000",
          parentId: ROOT_ID,
          offset: 0,
        }),
      ]),
    ]);

    expect(doc.text).toBe("world");
    expect(view.state.doc.toString()).toBe("world");
  });

  it("remote insert anchored mid-run lands at the anchor", () => {
    const { view, doc } = setup();
    localInsert(view, 0, "hello world");
    const parentId = doc.docState.index.spans[0]!.runId;

    doc.applyActions([
      wireAction("act_mid", [
        runCell({
          id: "2000:peer-B",
          text: "X",
          author: "peer-B",
          stamp: "2000",
          parentId,
          offset: 5,
        }),
      ]),
    ]);

    expect(doc.text).toBe("helloX world");
    expect(view.state.doc.toString()).toBe("helloX world");
  });

  it("remote cut removes only the cut run's characters", () => {
    const { view, doc } = setup();
    const parentId = "1000:peer-B";

    doc.applyActions([
      wireAction("act_runs", [
        runCell({
          id: parentId,
          text: "abcdef",
          author: "peer-B",
          stamp: "1000",
          parentId: ROOT_ID,
          offset: 0,
        }),
        runCell({
          id: "2000:peer-C",
          text: "XY",
          author: "peer-C",
          stamp: "2000",
          parentId,
          offset: 3,
        }),
      ]),
    ]);
    expect(doc.text).toBe("abcXYdef");
    expect(view.state.doc.toString()).toBe("abcXYdef");

    doc.applyActions([
      wireAction("act_cut", [
        cutCell({
          id: "3000:peer-B:cut",
          runId: parentId,
          from: 2,
          to: 5,
          author: "peer-B",
          stamp: "3000",
        }),
      ]),
    ]);

    // "c", "d", "e" of the parent are hidden; the nested "XY" survives.
    expect(doc.text).toBe("abXYf");
    expect(view.state.doc.toString()).toBe("abXYf");
  });

  it("every remote event leaves CM equal to doc.text", () => {
    const { view, doc } = setup();
    const parentId = "1000:peer-B";

    const steps: readonly (readonly TextCell[])[] = [
      [
        runCell({
          id: parentId,
          text: "iam",
          author: "peer-B",
          stamp: "1000",
          parentId: ROOT_ID,
          offset: 0,
        }),
      ],
      [
        runCell({
          id: "2000:peer-C",
          text: "X",
          author: "peer-C",
          stamp: "2000",
          parentId,
          offset: 1,
        }),
      ],
      [
        runCell({
          id: "2001:peer-D",
          text: "Y",
          author: "peer-D",
          stamp: "2001",
          parentId,
          offset: 1,
        }),
      ],
      [
        cutCell({
          id: "3000:peer-B:cut",
          runId: parentId,
          from: 2,
          to: 3,
          author: "peer-B",
          stamp: "3000",
        }),
      ],
    ];

    for (let i = 0; i < steps.length; i++) {
      doc.applyActions([wireAction(`act_step_${i}`, steps[i]!)]);
      expect(view.state.doc.toString()).toBe(doc.text);
    }
    expect(doc.text).toBe("iYXa");
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
    expect(v.state.field(idMapField)).toEqual(d.docState.index.spans);
    bridge.detach();
    v.destroy();
  });
});

describe("empty-doc ROOT placeholder", () => {
  it("createIdMapField seeds with the ROOT placeholder", () => {
    const idMapField = createIdMapField();
    const state = EditorState.create({
      doc: "",
      extensions: [idMapField],
    });
    expect(state.field(idMapField)).toEqual([{ runId: ROOT_ID, offset: 0, length: 0 }]);
  });

  it("ensureRootSpan returns the placeholder for an empty array", () => {
    expect(ensureRootSpan([])).toEqual([ROOT_PLACEHOLDER_SPAN]);
  });

  it("setIdMapEffect.of([]) still leaves the placeholder in the field", () => {
    const idMapField = createIdMapField();
    const seeded = EditorState.create({
      doc: "",
      extensions: [idMapField],
    }).update({
      effects: setIdMapEffect.of([]),
    }).state;
    expect(seeded.field(idMapField)).toEqual([ROOT_PLACEHOLDER_SPAN]);
  });

  it("end-to-end: empty-doc local click resolves to (ROOT_ID, 0)", () => {
    const { view, idMapField } = setup();
    expect(getRunAtPosition(view.state, 0, idMapField)).toEqual({
      runId: ROOT_ID,
      offset: 0,
      spanIndex: 0,
    });
  });

  it("first local edit replaces the placeholder with the real run", () => {
    const { view, doc, idMapField } = setup();
    expect(view.state.field(idMapField)).toEqual([ROOT_PLACEHOLDER_SPAN]);

    localInsert(view, 0, "h");

    expect(doc.text).toBe("h");
    const spans = view.state.field(idMapField);
    expect(spans).not.toEqual([ROOT_PLACEHOLDER_SPAN]);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.runId).not.toBe(ROOT_ID);
    expect(spans[0]!.offset).toBe(0);
    expect(spans[0]!.length).toBe(1);
  });

  it("a remote cut of the only run re-seeds the placeholder", () => {
    const { view, doc, idMapField } = setup();
    doc.localInsert("x");
    expect(view.state.field(idMapField)).toHaveLength(1);
    const runId = doc.docState.index.spans[0]!.runId;

    doc.applyActions([
      wireAction("act_cut", [
        cutCell({
          id: "5000:peer-B:cut",
          runId,
          from: 0,
          to: 1,
          author: "peer-B",
          stamp: "5000",
        }),
      ]),
    ]);

    expect(doc.text).toBe("");
    expect(view.state.doc.toString()).toBe("");
    expect(view.state.field(idMapField)).toEqual([ROOT_PLACEHOLDER_SPAN]);
  });
});
