/**
 * CM Bridge tests
 *
 * Tests the bridge's ability to sync CodeMirror ↔ Causal Tree by creating
 * a real CM EditorView in a jsdom/happy-dom environment, typing into it,
 * and verifying that the Causal Tree state matches.
 *
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { createHlc, type Hlc } from "../hlc.ts"
import {
  createDocState,
  docReducer,
  reconstruct,
  buildPositionMap,
  type DocAction,
  type DocState,
} from "../causal-tree.ts"
import {
  createBridgeExtension,
  createIdMapField,
  isRemote,
  setIdMapEffect,
  type BridgeConfig,
} from "../cm-bridge.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a wired-up CM EditorView + Causal Tree for testing. */
const createTestEditor = () => {
  let docState: DocState = createDocState()
  let hlc: Hlc = createHlc("test-peer")
  const actions: DocAction[] = []

  const idMapField = createIdMapField()

  const dispatch = (action: DocAction) => {
    docState = docReducer(docState, action)
    actions.push(action)
  }

  const config: BridgeConfig = {
    peerId: "test-peer",
    getHlc: () => hlc,
    setHlc: (h: Hlc) => {
      hlc = h
    },
    dispatch,
    getDocState: () => docState,
  }

  const state = EditorState.create({
    doc: "",
    extensions: [createBridgeExtension(config, idMapField)],
  })

  const view = new EditorView({ state })

  return {
    view,
    getDocState: () => docState,
    getActions: () => actions,
    getHlc: () => hlc,
    idMapField,
  }
}

/** Type text into the editor by dispatching a CM transaction. */
const typeText = (view: EditorView, text: string, pos?: number) => {
  const from = pos ?? view.state.selection.main.head
  view.dispatch({
    changes: { from, insert: text },
    selection: { anchor: from + text.length },
  })
}

/** Delete text from the editor. */
const deleteRange = (view: EditorView, from: number, to: number) => {
  view.dispatch({
    changes: { from, to },
    selection: { anchor: from },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CM Bridge — local insertions", () => {
  it("typing a single character creates one INSERT action", () => {
    const { view, getActions, getDocState } = createTestEditor()
    typeText(view, "a")

    const actions = getActions()
    expect(actions.length).toBe(1)
    expect(actions[0]!.type).toBe("INSERT")

    expect(reconstruct(getDocState())).toBe("a")
    expect(view.state.doc.toString()).toBe("a")
  })

  it("typing multiple characters creates an INSERT per character", () => {
    const { view, getActions, getDocState } = createTestEditor()
    typeText(view, "hello")

    const actions = getActions()
    const inserts = actions.filter((a) => a.type === "INSERT")
    expect(inserts.length).toBe(5)

    const treeText = reconstruct(getDocState())
    expect(treeText).toBe("hello")
    expect(view.state.doc.toString()).toBe("hello")
  })

  it("sequential single-char typing maintains consistency", () => {
    const { view, getDocState } = createTestEditor()

    typeText(view, "h")
    typeText(view, "e")
    typeText(view, "l")
    typeText(view, "l")
    typeText(view, "o")

    const treeText = reconstruct(getDocState())
    const cmText = view.state.doc.toString()
    expect(treeText).toBe("hello")
    expect(cmText).toBe("hello")
  })

  it("inserting at the beginning works", () => {
    const { view, getDocState } = createTestEditor()

    typeText(view, "bc")
    typeText(view, "a", 0) // insert at position 0

    const treeText = reconstruct(getDocState())
    expect(treeText).toBe("abc")
    expect(view.state.doc.toString()).toBe("abc")
  })

  it("inserting in the middle works", () => {
    const { view, getDocState } = createTestEditor()

    typeText(view, "ac")
    typeText(view, "b", 1) // insert between a and c

    const treeText = reconstruct(getDocState())
    expect(treeText).toBe("abc")
    expect(view.state.doc.toString()).toBe("abc")
  })
})

describe("CM Bridge — local deletions", () => {
  it("deleting a character creates a DELETE action", () => {
    const { view, getActions, getDocState } = createTestEditor()

    typeText(view, "ab")
    const actionsBefore = getActions().length
    deleteRange(view, 1, 2) // delete "b"

    const deletions = getActions().slice(actionsBefore).filter((a) => a.type === "DELETE")
    expect(deletions.length).toBe(1)

    expect(reconstruct(getDocState())).toBe("a")
    expect(view.state.doc.toString()).toBe("a")
  })

  it("deleting multiple characters works", () => {
    const { view, getDocState } = createTestEditor()

    typeText(view, "abcde")
    deleteRange(view, 1, 4) // delete "bcd"

    const treeText = reconstruct(getDocState())
    expect(treeText).toBe("ae")
    expect(view.state.doc.toString()).toBe("ae")
  })
})

describe("CM Bridge — ID map consistency", () => {
  it("ID map has same length as document after inserts", () => {
    const { view, getDocState, idMapField } = createTestEditor()

    typeText(view, "hello")

    // After the bridge listener runs, it dispatches an idMap update
    const idMap = view.state.field(idMapField)
    const docLen = view.state.doc.length

    expect(idMap.length).toBe(docLen)
  })

  it("ID map is consistent with buildPositionMap", () => {
    const { view, getDocState, idMapField } = createTestEditor()

    typeText(view, "abc")

    const idMap = view.state.field(idMapField)
    const posMap = buildPositionMap(getDocState())

    expect(idMap).toEqual(posMap.idAtPosition)
  })

  it("HLC advances monotonically with each insert", () => {
    const { view, getActions } = createTestEditor()

    typeText(view, "abc")

    const inserts = getActions().filter(
      (a): a is Extract<DocAction, { type: "INSERT" }> => a.type === "INSERT",
    )

    for (let i = 1; i < inserts.length; i++) {
      expect(inserts[i]!.node.id > inserts[i - 1]!.node.id).toBe(true)
    }
  })
})

describe("CM Bridge — replacement (select + type)", () => {
  it("replacing a selection dispatches DELETE then INSERT", () => {
    const { view, getActions, getDocState } = createTestEditor()

    typeText(view, "abc")
    const actionsBefore = getActions().length

    // Replace "b" with "X" (select pos 1-2, insert "X")
    view.dispatch({
      changes: { from: 1, to: 2, insert: "X" },
      selection: { anchor: 2 },
    })

    const newActions = getActions().slice(actionsBefore)
    const deletes = newActions.filter((a) => a.type === "DELETE")
    const inserts = newActions.filter((a) => a.type === "INSERT")

    expect(deletes.length).toBe(1)
    expect(inserts.length).toBe(1)

    expect(reconstruct(getDocState())).toBe("aXc")
    expect(view.state.doc.toString()).toBe("aXc")
  })
})
