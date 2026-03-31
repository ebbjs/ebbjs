/**
 * Dual Editors Component
 *
 * Renders two side-by-side CodeMirror peer editors that sync via BroadcastChannel.
 * This is the main interactive component for the collaborative editing demo.
 *
 * Includes optional ghost typing feature where peer-B automatically types a message.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react"
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
import { usePresence, createPresenceExtension } from "./presence.ts"
import { logEvent, updateHlc, updateDocState } from "./inspector-store.ts"

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
      return undefined
  }
}

/** Counter for generating unique action IDs within this peer's session. */
let nextActionId = 0

/**
 * Wrap a list of Updates into an ebb-native Action.
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

type PeerEditorProps = {
  peerId: string
  onViewReady?: (view: EditorView) => void
  onFocus?: () => void
  ghostActive?: boolean
}

const PeerEditor = ({
  peerId,
  onViewReady,
  onFocus,
  ghostActive,
}: PeerEditorProps) => {
  const editorRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const hlcRef = useRef<Hlc>(createHlc(peerId))

  // Causal Tree state via useReducer
  const [docState, treeDispatch] = useReducer(
    docReducer,
    undefined,
    createDocState,
  )

  // Stable ref to latest docState
  const docStateRef = useRef<DocState>(docState)
  docStateRef.current = docState

  // Create the ID map StateField once
  const idMapField = useMemo(() => createIdMapField(), [])

  // Presence tracking
  const presence = usePresence(peerId, idMapField)
  const getLocalPresenceIdsRef = useRef(presence.getLocalPresenceIds)
  getLocalPresenceIdsRef.current = presence.getLocalPresenceIds

  // Ref to hold the relay broadcast function
  const broadcastRef = useRef<((message: SyncMessage) => void) | null>(null)

  // ---------------------------------------------------------------------------
  // Update batching
  // ---------------------------------------------------------------------------

  const pendingUpdatesRef = useRef<Update[]>([])
  const flushScheduledRef = useRef(false)

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

  // Dispatch used by the CM Bridge (local edits)
  const localDispatch = useCallback(
    (action: DocAction) => {
      docStateRef.current = docReducer(docStateRef.current, action)
      treeDispatch(action)

      const update = docActionToUpdate(action, hlcRef.current, peerId)
      if (update) {
        pendingUpdatesRef.current.push(update)

        if (!flushScheduledRef.current) {
          flushScheduledRef.current = true
          queueMicrotask(flushPendingUpdates)
        }
      }
    },
    [peerId, flushPendingUpdates],
  )

  // Dispatch used by the Relay (remote edits)
  const remoteDispatch = useCallback(
    (action: DocAction) => {
      docStateRef.current = docReducer(docStateRef.current, action)
      treeDispatch(action)
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
        keymap.of([...defaultKeymap]),
        drawSelection(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle),
        bracketMatching(),
        createBridgeExtension(bridgeConfig, idMapField),
        createPresenceExtension({
          localPeerId: peerId,
          getPresenceMap: () => presence.presenceMapRef.current,
          idMapField,
          getDocState: () => docStateRef.current,
        }),
        EditorView.updateListener.of((update) => {
          const hasIdMapUpdate = update.transactions.some((tr) =>
            tr.effects.some((e) => e.is(setIdMapEffect)),
          )
          const pureSelectionChange = update.selectionSet && !update.docChanged

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
        EditorView.lineWrapping,
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { overflowX: "hidden", overflowY: "auto" },
        }),
      ],
    })

    const view = new EditorView({
      state,
      parent: editorRef.current,
    })

    viewRef.current = view
    onViewReady?.(view)

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debug: log consistency check
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

  const isPeerA = peerId === "peer-A"
  const peerColor = isPeerA ? "text-blue-400" : "text-amber-400"
  const peerLabel = isPeerA ? "peer-A" : "peer-B"

  return (
    <div className="flex flex-col flex-1 min-w-0">
      {/* Window chrome */}
      <div className="border border-stone-700 rounded-lg bg-stone-950 overflow-hidden">
        {/* Title bar */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-stone-700">
          <span className="w-3 h-3 rounded-full bg-stone-700" />
          <span className="w-3 h-3 rounded-full bg-stone-700" />
          <span className="w-3 h-3 rounded-full bg-stone-700" />
          <span className={`font-mono text-xs ml-2 ${peerColor}`}>
            {peerLabel}
          </span>
          {ghostActive && (
            <span className="font-mono text-xs text-stone-500 ml-1">
              (ghost)
            </span>
          )}
          <span className="font-mono text-xs text-stone-500 ml-auto">
            {docState.nodes.size - 1} runs
          </span>
        </div>
        {/* Editor area */}
        <div ref={editorRef} className="h-64 sm:h-72" onFocus={onFocus} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ghost peer typing
// ---------------------------------------------------------------------------

const GHOST_MESSAGE = "Hello from the other side."
const GHOST_START_DELAY = 1500
const GHOST_CHAR_MIN_DELAY = 80
const GHOST_CHAR_MAX_DELAY = 120

// ---------------------------------------------------------------------------
// DualEditors component
// ---------------------------------------------------------------------------

export const DualEditors = () => {
  const [ghostActive, setGhostActive] = useState(true)
  const peerBViewRef = useRef<EditorView | null>(null)
  const ghostTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Start ghost typing after delay
  useEffect(() => {
    if (!ghostActive) return

    const typeNextChar = (index: number) => {
      const view = peerBViewRef.current
      if (!view || index >= GHOST_MESSAGE.length || !ghostActive) {
        setGhostActive(false)
        return
      }

      const char = GHOST_MESSAGE[index]!
      view.dispatch(view.state.replaceSelection(char))

      const delay =
        GHOST_CHAR_MIN_DELAY +
        Math.random() * (GHOST_CHAR_MAX_DELAY - GHOST_CHAR_MIN_DELAY)
      ghostTimeoutRef.current = setTimeout(
        () => typeNextChar(index + 1),
        delay,
      )
    }

    ghostTimeoutRef.current = setTimeout(() => {
      typeNextChar(0)
    }, GHOST_START_DELAY)

    return () => {
      if (ghostTimeoutRef.current) {
        clearTimeout(ghostTimeoutRef.current)
      }
    }
  }, [ghostActive])

  const handlePeerBViewReady = useCallback((view: EditorView) => {
    peerBViewRef.current = view
  }, [])

  const handlePeerBFocus = useCallback(() => {
    setGhostActive(false)
    if (ghostTimeoutRef.current) {
      clearTimeout(ghostTimeoutRef.current)
    }
  }, [])

  return (
    <div className="flex flex-col sm:flex-row gap-4 sm:gap-6">
      <PeerEditor peerId="peer-A" />
      <PeerEditor
        peerId="peer-B"
        onViewReady={handlePeerBViewReady}
        onFocus={handlePeerBFocus}
        ghostActive={ghostActive}
      />
    </div>
  )
}
