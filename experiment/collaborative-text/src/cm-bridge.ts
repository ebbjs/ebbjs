/**
 * CodeMirror Bridge
 *
 * Bidirectional translation layer between CodeMirror 6's text document model
 * and the Causal Tree. Maintains a StateField that maps every character
 * position to its CharNode.id, and provides an updateListener that intercepts
 * local edits and translates them into Causal Tree actions.
 *
 * Strategy: Option B — rebuild the ID map from the Causal Tree on every
 * transaction. Simpler than incremental updates, O(n) per keystroke but fine
 * for a prototype.
 */

import {
  Annotation,
  StateField,
  type Extension,
  type Transaction,
} from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { increment, toString, type Hlc } from "./hlc.ts"
import {
  buildPositionMap,
  findInsertPosition,
  ROOT_ID,
  type DocAction,
  type DocState,
} from "./causal-tree.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BridgeConfig = {
  readonly peerId: string
  readonly getHlc: () => Hlc
  readonly setHlc: (hlc: Hlc) => void
  readonly dispatch: (action: DocAction) => void // Dispatch to Causal Tree reducer
  readonly getDocState: () => DocState // Read current Causal Tree state
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

/**
 * Annotation to mark transactions as remote, so the updateListener skips them.
 * This breaks the infinite loop: remote edits → CM → listener → skip.
 */
export const isRemote = Annotation.define<boolean>()

// ---------------------------------------------------------------------------
// StateField: ID map
// ---------------------------------------------------------------------------

/**
 * Creates the CM6 StateField that holds an array of node IDs parallel to the
 * document text. Index i in the array = node ID of the character at document
 * position i.
 *
 * Updated via the `setIdMapEffect`. The bridge's updateListener dispatches
 * this effect after processing each local or remote edit, ensuring the ID
 * map is rebuilt from the Causal Tree.
 */
export const createIdMapField = (): StateField<readonly string[]> =>
  StateField.define<readonly string[]>({
    create: () => [],
    update: (value, tr) => {
      for (const effect of tr.effects) {
        if (effect.is(setIdMapEffect)) {
          return effect.value
        }
      }
      return value
    },
  })

import { StateEffect } from "@codemirror/state"

/** Effect to replace the entire ID map in the StateField. */
export const setIdMapEffect = StateEffect.define<readonly string[]>()

// ---------------------------------------------------------------------------
// Bridge Extension
// ---------------------------------------------------------------------------

/**
 * Returns a CM6 Extension that bundles the ID map StateField + an updateListener
 * that intercepts local edits and translates them into Causal Tree actions.
 */
export const createBridgeExtension = (
  config: BridgeConfig,
  idMapField: StateField<readonly string[]>,
): Extension => {
  return [
    idMapField,
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return

      // Skip remote transactions
      for (const tr of update.transactions) {
        if (tr.annotation(isRemote)) return
      }

      // Process local changes
      const view = update.view

      // Collect the current ID map before changes
      // We need to iterate through changes and process them
      for (const tr of update.transactions) {
        if (!tr.docChanged || tr.annotation(isRemote)) continue

        tr.changes.iterChanges(
          (fromA, toA, _fromB, _toB, inserted) => {
            const currentIdMap = [...tr.startState.field(idMapField)]

            // Handle deletions first (fromA to toA in the old doc)
            for (let pos = toA - 1; pos >= fromA; pos--) {
              const nodeId = currentIdMap[pos]
              if (nodeId) {
                config.dispatch({ type: "DELETE", nodeId })
              }
            }

            // Handle insertions (inserted text)
            const insertedText = inserted.toString()
            if (insertedText.length > 0) {
              // Parent is the character just before the insert position,
              // or ROOT if inserting at position 0.
              // In the old doc positions, fromA is where the insertion goes.
              // After deletions, the parent is the char at fromA - 1 in the old doc.
              let parentId: string
              if (fromA === 0) {
                parentId = ROOT_ID
              } else {
                parentId = currentIdMap[fromA - 1] ?? ROOT_ID
              }

              // Insert each character sequentially, each parented to the previous
              for (let i = 0; i < insertedText.length; i++) {
                const newHlc = increment(config.getHlc())
                config.setHlc(newHlc)
                const nodeId = toString(newHlc)

                config.dispatch({
                  type: "INSERT",
                  node: {
                    id: nodeId,
                    value: insertedText[i]!,
                    parentId,
                    deleted: false,
                  },
                })

                parentId = nodeId // next char is parented to this one
              }
            }
          },
        )
      }

      // Rebuild the ID map from the Causal Tree and dispatch it as a
      // follow-up transaction. The presence listener watches for this
      // effect to know the ID map is fresh before broadcasting.
      const posMap = buildPositionMap(config.getDocState())
      view.dispatch({
        effects: setIdMapEffect.of(posMap.idAtPosition),
        annotations: isRemote.of(true),
      })
    }),
  ]
}

// ---------------------------------------------------------------------------
// Remote operation helpers (for Slice 2, stubbed here for completeness)
// ---------------------------------------------------------------------------

/**
 * Dispatch a CM transaction that inserts a character at the given position.
 * Marks the transaction as remote so the updateListener ignores it.
 *
 * Combines the text change and the ID map rebuild into a single dispatch
 * so the ID map is always consistent with the document in the same
 * transaction — no transient inconsistency window.
 */
export const applyRemoteInsert = (
  view: EditorView,
  position: number,
  char: string,
  _nodeId: string,
  idMapField: StateField<readonly string[]>,
  getDocState: () => DocState,
): void => {
  const posMap = buildPositionMap(getDocState())
  view.dispatch({
    changes: { from: position, insert: char },
    effects: setIdMapEffect.of(posMap.idAtPosition),
    annotations: isRemote.of(true),
  })
}

/**
 * Dispatch a CM transaction that deletes the character at the given position.
 * Marks as remote via annotation.
 *
 * Same as applyRemoteInsert — combines text change and ID map in one dispatch.
 */
export const applyRemoteDelete = (
  view: EditorView,
  position: number,
  idMapField: StateField<readonly string[]>,
  getDocState: () => DocState,
): void => {
  const posMap = buildPositionMap(getDocState())
  view.dispatch({
    changes: { from: position, to: position + 1 },
    effects: setIdMapEffect.of(posMap.idAtPosition),
    annotations: isRemote.of(true),
  })
}

// ---------------------------------------------------------------------------
// Position ↔ ID helpers
// ---------------------------------------------------------------------------

/** Read the node ID at a given document position from the StateField. */
export const getIdAtPosition = (
  state: { field: <T>(f: StateField<T>) => T },
  position: number,
  idMapField: StateField<readonly string[]>,
): string | undefined => {
  const idMap = state.field(idMapField)
  return idMap[position]
}

/** Find the document position of a given node ID. Linear scan. */
export const getPositionOfId = (
  state: { field: <T>(f: StateField<T>) => T },
  nodeId: string,
  idMapField: StateField<readonly string[]>,
): number | undefined => {
  const idMap = state.field(idMapField)
  const idx = idMap.indexOf(nodeId)
  return idx === -1 ? undefined : idx
}
