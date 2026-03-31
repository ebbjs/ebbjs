/**
 * Editor App — Slice 4
 *
 * Renders two side-by-side CodeMirror editor instances, each with its own
 * peer identity, Causal Tree, and HLC. A BroadcastChannel relay syncs
 * operations between them. Remote peer cursors and selections are rendered
 * as colored decorations via the Presence module.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react"
import { EditorState } from "@codemirror/state"
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
} from "@codemirror/view"
import { defaultKeymap } from "@codemirror/commands"
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
} from "@codemirror/language"
import { createHlc, type Hlc } from "./hlc.ts"
import {
  createDocState,
  docReducer,
  reconstruct,
  type DocAction,
  type DocState,
} from "./causal-tree.ts"
import {
  createBridgeExtension,
  createIdMapField,
  setIdMapEffect,
  type BridgeConfig,
} from "./cm-bridge.ts"
import {
  useRelay,
  type RelayMessage,
  type InsertMessage,
  type DeleteMessage,
} from "./relay.ts"
import {
  usePresence,
  createPresenceExtension,
} from "./presence.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANNEL_NAME = "collab-text"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a DocAction + current HLC + peerId into a RelayMessage for broadcast.
 * Only INSERT and DELETE actions produce messages.
 */
const actionToMessage = (
  action: DocAction,
  hlc: Hlc,
  peerId: string,
): InsertMessage | DeleteMessage => {
  switch (action.type) {
    case "INSERT":
      return { type: "INSERT", peerId, node: action.node, hlc }
    case "DELETE":
      return { type: "DELETE", peerId, nodeId: action.nodeId, hlc }
  }
}

// ---------------------------------------------------------------------------
// PeerEditor component
// ---------------------------------------------------------------------------

const PeerEditor = ({ peerId }: { peerId: string }) => {
  const editorRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const hlcRef = useRef<Hlc>(createHlc(peerId))

  // Causal Tree state via useReducer
  const [docState, treeDispatch] = useReducer(docReducer, undefined, createDocState)

  // Stable ref to latest docState (so callbacks can read it without stale closures)
  const docStateRef = useRef<DocState>(docState)
  docStateRef.current = docState

  // Create the ID map StateField once
  const idMapField = useMemo(() => createIdMapField(), [])

  // Presence tracking
  const presence = usePresence(peerId, idMapField)
  const getLocalPresenceIdsRef = useRef(presence.getLocalPresenceIds)
  getLocalPresenceIdsRef.current = presence.getLocalPresenceIds

  // Ref to hold the relay broadcast function (avoids circular dep with useRelay)
  const broadcastRef = useRef<((message: RelayMessage) => void) | null>(null)

  // Dispatch used by the CM Bridge (local edits): updates tree AND broadcasts.
  // We update docStateRef synchronously so that any subsequent reads of
  // getDocState() within the same event-loop tick see the latest state
  // (React's useReducer batches updates and won't flush until the next render).
  const localDispatch = useCallback(
    (action: DocAction) => {
      docStateRef.current = docReducer(docStateRef.current, action)
      treeDispatch(action)
      const message = actionToMessage(action, hlcRef.current, peerId)
      broadcastRef.current?.(message)
    },
    [peerId],
  )

  // Dispatch used by the Relay (remote edits): updates tree only, no re-broadcast.
  // Same synchronous ref update so rapid sequential BroadcastChannel messages
  // each see the tree state left by the previous message.
  const remoteDispatch = useCallback(
    (action: DocAction) => {
      docStateRef.current = docReducer(docStateRef.current, action)
      treeDispatch(action)
    },
    [],
  )

  // Set up the relay
  const relay = useRelay({
    channelName: CHANNEL_NAME,
    peerId,
    hlcRef,
    dispatch: remoteDispatch,
    getDocState: () => docStateRef.current,
    viewRef,
    idMapField,
    updatePresence: presence.updatePresence,
  })

  // Wire broadcast ref once relay is available
  broadcastRef.current = relay.broadcast

  // Initialize CodeMirror
  useEffect(() => {
    if (!editorRef.current) return

    const bridgeConfig: BridgeConfig = {
      peerId,
      getHlc: () => hlcRef.current,
      setHlc: (hlc: Hlc) => {
        hlcRef.current = hlc
      },
      dispatch: localDispatch,
      getDocState: () => docStateRef.current,
    }

    const state = EditorState.create({
      doc: "",
      extensions: [
        // Minimal setup (no undo — conflicts with Causal Tree)
        keymap.of([...defaultKeymap]),
        drawSelection(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle),
        bracketMatching(),
        // Bridge extension — connects CM to the Causal Tree
        createBridgeExtension(bridgeConfig, idMapField),
        // Presence extension — renders remote cursors and selections
        createPresenceExtension({
          localPeerId: peerId,
          getPresenceMap: () => presence.presenceMapRef.current,
          idMapField,
          getDocState: () => docStateRef.current,
        }),
        // Selection change listener — broadcasts local cursor position.
        //
        // When the doc changes (local edit), the bridge dispatches a
        // follow-up transaction with setIdMapEffect after updating the
        // causal tree. We broadcast presence when we see that effect,
        // because the ID map is then guaranteed to be fresh.
        //
        // For pure selection changes (cursor move, no edit), the ID
        // map is already correct, so we broadcast immediately.
        EditorView.updateListener.of((update) => {
          const hasIdMapUpdate = update.transactions.some((tr) =>
            tr.effects.some((e) => e.is(setIdMapEffect)),
          )
          const pureSelectionChange =
            update.selectionSet && !update.docChanged

          if (hasIdMapUpdate || pureSelectionChange) {
            const ids = getLocalPresenceIdsRef.current(update.state)
            broadcastRef.current?.({
              type: "PRESENCE",
              peerId,
              anchorId: ids.anchorId,
              headId: ids.headId,
            })
          }
        }),
        // Basic styling
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { overflow: "auto" },
          ".cm-content": { fontFamily: "monospace", fontSize: "14px" },
        }),
      ],
    })

    const view = new EditorView({
      state,
      parent: editorRef.current,
    })

    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // intentionally empty — CM view is created once

  // Debug: log consistency check on every docState change
  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    const treeText = reconstruct(docState)
    const cmText = view.state.doc.toString()

    if (treeText !== cmText) {
      console.error(
        `[${peerId}] INCONSISTENCY DETECTED!\n` +
          `  Causal Tree: "${treeText}"\n` +
          `  CodeMirror:  "${cmText}"`,
      )
    }
  }, [docState, peerId])

  // Reconstruct text from the Causal Tree for the debug panel
  const treeText = reconstruct(docState)

  return (
    <div className="flex flex-col gap-2 flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-gray-600">{peerId}</span>
        <span className="text-xs text-gray-400">
          ({docState.nodes.size - 1} nodes)
        </span>
      </div>
      <div
        ref={editorRef}
        className="border border-gray-300 rounded-lg overflow-hidden h-64"
      />
      <details className="text-xs">
        <summary className="cursor-pointer text-gray-400 hover:text-gray-600">
          Debug: Causal Tree state
        </summary>
        <pre className="mt-1 p-2 bg-gray-100 rounded text-gray-600 overflow-x-auto whitespace-pre-wrap break-all">
          {treeText.length > 0 ? `"${treeText}"` : "(empty)"}
        </pre>
      </details>
    </div>
  )
}

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------

export const App = () => {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center p-8 gap-6">
      <h1 className="text-2xl font-bold text-gray-800">
        Collaborative Text Editor
      </h1>
      <p className="text-sm text-gray-500">
        Two-peer sync via BroadcastChannel. Type in one editor, see it in the
        other. Remote cursors and selections are shown as colored decorations.
      </p>
      <div className="flex gap-6 w-full max-w-5xl">
        <PeerEditor peerId="peer-A" />
        <PeerEditor peerId="peer-B" />
      </div>
      <div className="text-xs text-gray-400">
        Open the browser console to see consistency checks.
      </div>
    </div>
  )
}
