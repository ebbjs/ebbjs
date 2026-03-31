/**
 * Editor App — Ebb-Native Wire Protocol
 *
 * Renders two side-by-side CodeMirror editor instances, each with its own
 * peer identity, Causal Tree, and HLC. A BroadcastChannel relay syncs
 * operations between them. Remote peer cursors and selections are rendered
 * as colored decorations via the Presence module.
 *
 * Wire protocol follows ebb's Action → Update[] model:
 * - Each CM transaction produces a single Action containing one or more Updates
 * - SPLIT actions are local-only (not included in Actions)
 * - INSERT_RUN → Action with a "put" Update carrying a causal_tree_run field
 * - DELETE_RANGE → Action with a "delete" Update carrying a causal_tree_range field
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
  type Action,
  type Update,
  type SyncMessage,
} from "./relay.ts"
import {
  usePresence,
  createPresenceExtension,
} from "./presence.ts"
import {
  logEvent,
  updateHlc,
  updateDocState,
} from "./inspector-store.ts"
import { InspectorPanel } from "./InspectorPanel.tsx"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANNEL_NAME = "collab-text"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Counter for generating unique update IDs within this peer's session. */
let nextUpdateId = 0

/**
 * Convert a DocAction into an ebb-native Update.
 *
 * - INSERT_RUN → "put" Update with a "causal_tree_run" field value
 * - EXTEND_RUN → "patch" Update with a "causal_tree_append" field value
 * - DELETE_RANGE → "delete" Update with a "causal_tree_range" field value
 * - SPLIT → returns undefined (local-only, not broadcast)
 *
 * Each Update targets a single entity (RunNode) with self-describing
 * typed field data, mirroring ebb's per-field merge dispatch.
 */
const docActionToUpdate = (
  action: DocAction,
  hlc: Hlc,
  peerId: string,
): Update | undefined => {
  switch (action.type) {
    case "INSERT_RUN":
      return {
        id: `${peerId}_upd_${nextUpdateId++}`,
        subject_id: action.node.id,
        subject_type: "run",
        method: "put",
        data: {
          fields: {
            run: {
              type: "causal_tree_run",
              value: action.node,
              hlc,
              // Include the split offset so the receiving peer can split
              // the parent run before inserting. Without this, a mid-run
              // insert would land at the wrong position on peers that
              // haven't split the parent yet.
              ...(action.splitParentAt !== undefined && {
                splitParentAt: action.splitParentAt,
              }),
            },
          },
        },
      }
    case "EXTEND_RUN":
      return {
        id: `${peerId}_upd_${nextUpdateId++}`,
        subject_id: action.runId,
        subject_type: "run",
        method: "patch",
        data: {
          fields: {
            append: {
              type: "causal_tree_append",
              value: { text: action.appendText },
              hlc,
            },
          },
        },
      }
    case "DELETE_RANGE":
      return {
        id: `${peerId}_upd_${nextUpdateId++}`,
        subject_id: action.runId,
        subject_type: "run",
        method: "delete",
        data: {
          fields: {
            range: {
              type: "causal_tree_range",
              value: { offset: action.offset, count: action.count },
              hlc,
            },
          },
        },
      }
    case "SPLIT":
      // SPLIT is a local consequence — not broadcast.
      // Each peer performs its own splits when it receives a "put" Update.
      return undefined
  }
}

/** Counter for generating unique action IDs within this peer's session. */
let nextActionId = 0

/**
 * Wrap a list of Updates into an ebb-native Action.
 *
 * An Action is the atomic sync unit: all Updates are applied together,
 * and the action ID is used for dedup. This mirrors ebb's guarantee
 * that Actions are never split across sync pages.
 */
const createAction = (
  updates: readonly Update[],
  hlc: Hlc,
  peerId: string,
): Action => ({
  id: `${peerId}_act_${nextActionId++}`,
  actor_id: peerId,
  hlc,
  updates,
})

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
  const broadcastRef = useRef<((message: SyncMessage) => void) | null>(null)

  // ---------------------------------------------------------------------------
  // Update batching — collects Updates within a CM transaction, flushes as one Action
  // ---------------------------------------------------------------------------

  // Pending updates accumulator. Within a single CM transaction, the bridge
  // may call localDispatch multiple times (e.g., delete 3 runs = 3 calls).
  // We collect the resulting Updates here, then flush them as one Action
  // after the transaction completes (via microtask).
  const pendingUpdatesRef = useRef<Update[]>([])
  const flushScheduledRef = useRef(false)

  /**
   * Flush all pending Updates into a single ebb-native Action and broadcast.
   *
   * This runs as a microtask after the current event-loop tick, ensuring
   * all DocActions from a single CM transaction are batched together.
   * A multi-run delete produces 1 Action with N "delete" Updates, not N
   * separate messages — matching ebb's atomic Action guarantee.
   */
  const flushPendingUpdates = useCallback(() => {
    flushScheduledRef.current = false
    const updates = pendingUpdatesRef.current
    if (updates.length === 0) return

    pendingUpdatesRef.current = []

    const action = createAction(updates, hlcRef.current, peerId)
    broadcastRef.current?.({ type: "ACTION", action })

    // Inspector instrumentation
    logEvent(peerId, "sent", action)
    updateHlc(peerId, hlcRef.current)
    updateDocState(peerId, docStateRef.current)
  }, [peerId])

  // Dispatch used by the CM Bridge (local edits): updates tree AND collects Updates.
  // We update docStateRef synchronously so that any subsequent reads of
  // getDocState() within the same event-loop tick see the latest state
  // (React's useReducer batches updates and won't flush until the next render).
  const localDispatch = useCallback(
    (action: DocAction) => {
      docStateRef.current = docReducer(docStateRef.current, action)
      treeDispatch(action)

      // Convert to an ebb-native Update and collect it for batching
      const update = docActionToUpdate(action, hlcRef.current, peerId)
      if (update) {
        pendingUpdatesRef.current.push(update)

        // Schedule a flush as a microtask — this ensures all DocActions from
        // the current CM transaction are collected before we create the Action.
        if (!flushScheduledRef.current) {
          flushScheduledRef.current = true
          queueMicrotask(flushPendingUpdates)
        }
      }
    },
    [peerId, flushPendingUpdates],
  )

  // Dispatch used by the Relay (remote edits): updates tree only, no re-broadcast.
  // Same synchronous ref update so rapid sequential BroadcastChannel messages
  // each see the tree state left by the previous message.
  const remoteDispatch = useCallback(
    (action: DocAction) => {
      docStateRef.current = docReducer(docStateRef.current, action)
      treeDispatch(action)

      // Inspector instrumentation
      updateDocState(peerId, docStateRef.current)
    },
    [peerId],
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
    onRemoteMessage: (message) => {
      if (message.type === "ACTION") {
        logEvent(peerId, "received", message.action)
      }
      updateHlc(peerId, hlcRef.current)
    },
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
            const refs = getLocalPresenceIdsRef.current(update.state)
            broadcastRef.current?.({
              type: "PRESENCE",
              peerId,
              anchorId: refs.anchor.runId,
              anchorOffset: refs.anchor.offset,
              headId: refs.head.runId,
              headOffset: refs.head.offset,
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

  return (
    <div className="flex flex-col gap-2 flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <span
          className={`text-sm font-semibold ${
            peerId === "peer-A" ? "text-blue-600" : "text-orange-600"
          }`}
        >
          {peerId}
        </span>
        <span className="text-xs text-gray-400">
          ({docState.nodes.size - 1} nodes)
        </span>
      </div>
      <div
        ref={editorRef}
        className="border border-gray-300 rounded-lg overflow-hidden h-64"
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------

export const App = () => {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center p-8 gap-6">
      <div className="text-center max-w-2xl">
        <h1 className="text-2xl font-bold text-gray-800">
          Collaborative Editing — Under the Hood
        </h1>
        <p className="text-sm text-gray-500 mt-2 leading-relaxed">
          A from-scratch collaborative text editor. No CRDT library — just a{" "}
          <span className="font-semibold">Causal Tree</span> ordered by{" "}
          <span className="font-semibold">Hybrid Logical Clocks</span>. Two
          peer editors sync via BroadcastChannel. Type in one, see it appear in
          the other — with remote cursors and deterministic conflict resolution.
        </p>
      </div>
      <div className="flex gap-6 w-full max-w-5xl">
        <PeerEditor peerId="peer-A" />
        <PeerEditor peerId="peer-B" />
      </div>
      <InspectorPanel />
    </div>
  )
}
