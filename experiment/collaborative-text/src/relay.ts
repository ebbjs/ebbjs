/**
 * Relay (Batched Wire Protocol)
 *
 * Simulates a network layer between two editor instances using the browser's
 * BroadcastChannel API. When a local editor produces an INSERT_RUN or
 * DELETE_RANGE operation, the Relay broadcasts it. When a remote operation
 * arrives, the Relay applies it to the local Causal Tree, merges the remote
 * HLC, calculates the correct document position, and dispatches a CM
 * transaction.
 *
 * The key optimization: the relay speaks in run-level messages, not
 * per-character messages. Pasting 1000 chars = 1 message, not 1000.
 *
 * SPLIT actions are NOT broadcast — they are a local consequence of receiving
 * a remote INSERT_RUN. Each peer performs its own splits as needed.
 */

import { useCallback, useEffect, useRef } from "react"
import type { StateField } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { receive, type Hlc } from "./hlc.ts"
import {
  findInsertPosition,
  runOffsetToPosition,
  type DocAction,
  type DocState,
  type RunNode,
  type RunSpan,
} from "./causal-tree.ts"
import { applyRemoteDelete, applyRemoteInsert } from "./cm-bridge.ts"
import { presenceUpdateEffect } from "./presence.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InsertRunMessage = {
  readonly type: "INSERT_RUN"
  readonly peerId: string
  readonly node: RunNode
  readonly hlc: Hlc // Sender's HLC at time of send (for clock merge)
}

export type DeleteRangeMessage = {
  readonly type: "DELETE_RANGE"
  readonly peerId: string
  readonly runId: string
  readonly offset: number
  readonly count: number
  readonly hlc: Hlc
}

export type PresenceMessage = {
  readonly type: "PRESENCE"
  readonly peerId: string
  readonly anchorId: string
  readonly headId: string
}

export type RelayMessage = InsertRunMessage | DeleteRangeMessage | PresenceMessage

export type RelayConfig = {
  readonly channelName: string
  readonly peerId: string
  readonly hlcRef: React.RefObject<Hlc>
  readonly dispatch: (action: DocAction) => void // Dispatches to Causal Tree only (no re-broadcast)
  readonly getDocState: () => DocState
  readonly viewRef: React.RefObject<EditorView | null>
  readonly idMapField: StateField<readonly RunSpan[]>
  readonly updatePresence?: (
    peerId: string,
    anchorId: string,
    headId: string,
  ) => void
  /** Optional callback invoked when a remote message is received (for inspector). */
  readonly onRemoteMessage?: (message: RelayMessage) => void
}

export type RelayHandle = {
  readonly broadcast: (message: RelayMessage) => void
}

// ---------------------------------------------------------------------------
// Core message handler (pure-ish, extracted for testability)
// ---------------------------------------------------------------------------

/**
 * Handle a received remote message. This is extracted from the hook so it
 * can be tested independently.
 *
 * Returns void — applies side effects to the mutable refs and dispatch.
 */
export const handleRemoteMessage = (
  message: RelayMessage,
  config: RelayConfig,
): void => {
  // Ignore own messages
  if (message.peerId === config.peerId) return

  // Notify inspector (if wired up)
  config.onRemoteMessage?.(message)

  switch (message.type) {
    case "INSERT_RUN": {
      // 1. Merge clocks (always, even for duplicates — keeps HLC monotonic)
      config.hlcRef.current = receive(config.hlcRef.current, message.hlc)

      // 2. Idempotency guard: if this node already exists in the tree,
      //    skip the insert entirely. This prevents duplicate characters
      //    in the CM view when the same message is received twice.
      const docState = config.getDocState()
      if (docState.nodes.has(message.node.id)) {
        break
      }

      // 3. Calculate visible position BEFORE adding the node to the tree.
      //    This way findInsertPosition sees existing siblings but not the
      //    new node itself, giving the correct insertion index into the
      //    current CM document.
      const insertPos = findInsertPosition(
        docState,
        message.node.parentId,
        message.node.id,
      )

      // 4. Dispatch INSERT_RUN to local Causal Tree
      config.dispatch({ type: "INSERT_RUN", node: message.node })

      // 5. Apply to CM view — insert the entire run text in one transaction
      const view = config.viewRef.current
      if (view) {
        applyRemoteInsert(
          view,
          insertPos,
          message.node.text,
          message.node.id,
          config.idMapField,
          config.getDocState,
        )
      }
      break
    }

    case "DELETE_RANGE": {
      // 1. Merge clocks
      config.hlcRef.current = receive(config.hlcRef.current, message.hlc)

      // 2. Look up the run's current position BEFORE dispatching delete
      const deleteDocState = config.getDocState()
      const deletePos = runOffsetToPosition(
        deleteDocState.index,
        message.runId,
        message.offset,
      )

      // 3. Dispatch DELETE_RANGE to local Causal Tree
      config.dispatch({
        type: "DELETE_RANGE",
        runId: message.runId,
        offset: message.offset,
        count: message.count,
      })

      // 4. Apply to CM view (only if the run was visible)
      const deleteView = config.viewRef.current
      if (deleteView && deletePos !== undefined) {
        applyRemoteDelete(
          deleteView,
          deletePos,
          message.count,
          config.idMapField,
          config.getDocState,
        )
      }
      break
    }

    case "PRESENCE": {
      // Forward to presence module
      config.updatePresence?.(
        message.peerId,
        message.anchorId,
        message.headId,
      )

      // Poke the CM view so the Presence ViewPlugin rebuilds decorations.
      // Without this, a React state update alone wouldn't trigger a CM
      // transaction, and the remote cursor would freeze until the next
      // unrelated edit.
      const presenceView = config.viewRef.current
      if (presenceView) {
        presenceView.dispatch({
          effects: presenceUpdateEffect.of(undefined),
        })
      }
      break
    }
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * React hook that sets up a BroadcastChannel, listens for remote messages,
 * and provides a broadcast function for sending local operations.
 */
export const useRelay = (config: RelayConfig): RelayHandle => {
  const channelRef = useRef<BroadcastChannel | null>(null)

  // Keep config in a ref so the onmessage handler always sees the latest
  const configRef = useRef(config)
  configRef.current = config

  useEffect(() => {
    const channel = new BroadcastChannel(config.channelName)
    channelRef.current = channel

    channel.onmessage = (event: MessageEvent<RelayMessage>) => {
      handleRemoteMessage(event.data, configRef.current)
    }

    return () => {
      channel.close()
      channelRef.current = null
    }
  }, [config.channelName])

  const broadcast = useCallback((message: RelayMessage) => {
    channelRef.current?.postMessage(message)
  }, [])

  return { broadcast }
}
