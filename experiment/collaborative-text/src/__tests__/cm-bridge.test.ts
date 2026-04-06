/**
 * CM Bridge tests (Run-Optimized)
 *
 * Tests the bridge's ability to sync CodeMirror ↔ Causal Tree by creating
 * a real CM EditorView in a happy-dom environment, typing into it,
 * and verifying that the Causal Tree state matches.
 *
 * Key differences from the per-character bridge tests:
 * - Actions are INSERT_RUN / DELETE_RANGE / SPLIT (not INSERT / DELETE)
 * - Multi-character paste produces a SINGLE INSERT_RUN
 * - Mid-run insertion produces SPLIT + INSERT_RUN
 *
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createHlc, type Hlc } from "../hlc.ts";
import {
  createDocState,
  docReducer,
  reconstruct,
  type DocAction,
  type DocState,
  type InsertRunAction,
} from "../causal-tree.ts";
import { createBridgeExtension, createIdMapField, type BridgeConfig } from "../cm-bridge.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a wired-up CM EditorView + Causal Tree for testing. */
const createTestEditor = () => {
  let docState: DocState = createDocState();
  let hlc: Hlc = createHlc("test-peer");
  const actions: DocAction[] = [];

  const idMapField = createIdMapField();

  const dispatch = (action: DocAction) => {
    docState = docReducer(docState, action);
    actions.push(action);
  };

  const config: BridgeConfig = {
    peerId: "test-peer",
    getHlc: () => hlc,
    setHlc: (h: Hlc) => {
      hlc = h;
    },
    dispatch,
    getDocState: () => docState,
  };

  const state = EditorState.create({
    doc: "",
    extensions: [createBridgeExtension(config, idMapField)],
  });

  const view = new EditorView({ state });

  return {
    view,
    getDocState: () => docState,
    getActions: () => actions,
    getHlc: () => hlc,
    idMapField,
  };
};

/** Type text into the editor by dispatching a CM transaction. */
const typeText = (view: EditorView, text: string, pos?: number) => {
  const from = pos ?? view.state.selection.main.head;
  view.dispatch({
    changes: { from, insert: text },
    selection: { anchor: from + text.length },
  });
};

/** Delete text from the editor. */
const deleteRange = (view: EditorView, from: number, to: number) => {
  view.dispatch({
    changes: { from, to },
    selection: { anchor: from },
  });
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CM Bridge — local insertions (run-level)", () => {
  it("typing a single character creates one INSERT_RUN action", () => {
    const { view, getActions, getDocState } = createTestEditor();
    typeText(view, "a");

    const actions = getActions();
    const insertRuns = actions.filter((a) => a.type === "INSERT_RUN");
    expect(insertRuns.length).toBe(1);
    expect((insertRuns[0] as InsertRunAction).node.text).toBe("a");

    expect(reconstruct(getDocState())).toBe("a");
    expect(view.state.doc.toString()).toBe("a");
  });

  it("pasting multi-character text creates a SINGLE INSERT_RUN", () => {
    const { view, getActions, getDocState } = createTestEditor();
    typeText(view, "hello");

    const actions = getActions();
    const insertRuns = actions.filter((a) => a.type === "INSERT_RUN");
    // A single paste produces one INSERT_RUN, not 5
    expect(insertRuns.length).toBe(1);
    expect((insertRuns[0] as InsertRunAction).node.text).toBe("hello");

    const treeText = reconstruct(getDocState());
    expect(treeText).toBe("hello");
    expect(view.state.doc.toString()).toBe("hello");
  });

  it("sequential single-char typing maintains consistency", () => {
    const { view, getDocState } = createTestEditor();

    typeText(view, "h");
    typeText(view, "e");
    typeText(view, "l");
    typeText(view, "l");
    typeText(view, "o");

    const treeText = reconstruct(getDocState());
    const cmText = view.state.doc.toString();
    expect(treeText).toBe("hello");
    expect(cmText).toBe("hello");
  });

  it("inserting at the beginning works", () => {
    const { view, getDocState } = createTestEditor();

    typeText(view, "bc");
    typeText(view, "a", 0); // insert at position 0

    const treeText = reconstruct(getDocState());
    expect(treeText).toBe("abc");
    expect(view.state.doc.toString()).toBe("abc");
  });

  it("inserting in the middle works", () => {
    const { view, getDocState } = createTestEditor();

    typeText(view, "ac");
    typeText(view, "b", 1); // insert between a and c

    const treeText = reconstruct(getDocState());
    expect(treeText).toBe("abc");
    expect(view.state.doc.toString()).toBe("abc");
  });

  it("inserting in the middle of a run triggers SPLIT + INSERT_RUN", () => {
    const { view, getActions, getDocState } = createTestEditor();

    // Paste "hello" — creates one run
    typeText(view, "hello");
    const actionsBefore = getActions().length;

    // Insert "X" at position 3 (between "hel" and "lo")
    typeText(view, "X", 3);

    const newActions = getActions().slice(actionsBefore);
    const splits = newActions.filter((a) => a.type === "SPLIT");
    const insertRuns = newActions.filter((a) => a.type === "INSERT_RUN");

    expect(splits.length).toBe(1);
    expect(insertRuns.length).toBe(1);
    expect((insertRuns[0] as InsertRunAction).node.text).toBe("X");

    expect(reconstruct(getDocState())).toBe("helXlo");
    expect(view.state.doc.toString()).toBe("helXlo");
  });
});

describe("CM Bridge — local deletions (run-level)", () => {
  it("deleting characters creates DELETE_RANGE actions", () => {
    const { view, getActions, getDocState } = createTestEditor();

    typeText(view, "ab");
    const actionsBefore = getActions().length;
    deleteRange(view, 1, 2); // delete "b"

    const newActions = getActions().slice(actionsBefore);
    const deletions = newActions.filter((a) => a.type === "DELETE_RANGE");
    expect(deletions.length).toBeGreaterThanOrEqual(1);

    expect(reconstruct(getDocState())).toBe("a");
    expect(view.state.doc.toString()).toBe("a");
  });

  it("deleting multiple characters works", () => {
    const { view, getDocState } = createTestEditor();

    typeText(view, "abcde");
    deleteRange(view, 1, 4); // delete "bcd"

    const treeText = reconstruct(getDocState());
    expect(treeText).toBe("ae");
    expect(view.state.doc.toString()).toBe("ae");
  });
});

describe("CM Bridge — span field consistency", () => {
  it("span field matches DocState.index.spans after inserts", () => {
    const { view, getDocState, idMapField } = createTestEditor();

    typeText(view, "hello");

    const spans = view.state.field(idMapField);
    const docSpans = getDocState().index.spans;

    expect(spans).toEqual(docSpans);
  });

  it("span field totalLength matches document length", () => {
    const { view, getDocState } = createTestEditor();

    typeText(view, "abc");

    expect(getDocState().index.totalLength).toBe(view.state.doc.length);
  });

  it("HLC advances monotonically with each insert", () => {
    const { view, getActions } = createTestEditor();

    typeText(view, "a");
    typeText(view, "b");
    typeText(view, "c");

    const inserts = getActions().filter((a): a is InsertRunAction => a.type === "INSERT_RUN");

    for (let i = 1; i < inserts.length; i++) {
      expect(inserts[i]!.node.id > inserts[i - 1]!.node.id).toBe(true);
    }
  });
});

describe("CM Bridge — replacement (select + type)", () => {
  it("replacing a selection dispatches DELETE_RANGE then INSERT_RUN", () => {
    const { view, getActions, getDocState } = createTestEditor();

    typeText(view, "abc");
    const actionsBefore = getActions().length;

    // Replace "b" with "X" (select pos 1-2, insert "X")
    view.dispatch({
      changes: { from: 1, to: 2, insert: "X" },
      selection: { anchor: 2 },
    });

    const newActions = getActions().slice(actionsBefore);
    const deletes = newActions.filter((a) => a.type === "DELETE_RANGE");
    const inserts = newActions.filter((a) => a.type === "INSERT_RUN");

    expect(deletes.length).toBeGreaterThanOrEqual(1);
    expect(inserts.length).toBe(1);

    expect(reconstruct(getDocState())).toBe("aXc");
    expect(view.state.doc.toString()).toBe("aXc");
  });
});

describe("CM Bridge — edge cases", () => {
  it("empty document: typing the first character works", () => {
    const { view, getDocState } = createTestEditor();

    typeText(view, "x");

    expect(reconstruct(getDocState())).toBe("x");
    expect(view.state.doc.toString()).toBe("x");
  });

  it("inserting at the end of a run does not trigger SPLIT", () => {
    const { view, getActions, getDocState } = createTestEditor();

    typeText(view, "abc");
    const actionsBefore = getActions().length;

    // Insert at position 3 (end of the "abc" run)
    typeText(view, "d");

    const newActions = getActions().slice(actionsBefore);
    const splits = newActions.filter((a) => a.type === "SPLIT");
    expect(splits.length).toBe(0);

    expect(reconstruct(getDocState())).toBe("abcd");
    expect(view.state.doc.toString()).toBe("abcd");
  });
});
