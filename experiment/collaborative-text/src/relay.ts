/**
 * Relay (Mock Network)
 *
 * Simulates a network layer between two editor instances using the browser's
 * BroadcastChannel API. When a local editor produces an INSERT or DELETE
 * operation, the Relay broadcasts it. When a remote operation arrives, the
 * Relay applies it to the local Causal Tree, merges the remote HLC,
 * calculates the correct document position, and dispatches a CM transaction.
 *
 * The Relay is the integration hub — the only component that touches
 * HLC, Causal Tree, and CM Bridge together.
 */

import { useCallback, useEffect, useRef } from "react"
import type { StateField } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { receive, type Hlc } from "./hlc.ts"
import {
  buildPositionMap,
  findInsertPosition,
  type CharNode,
  type DocAction,
  type DocState,
} from "./causal-tree.ts"
import { applyRemoteDelete, applyRemoteInsert } from "./cm-bridge.ts"
import { presenceUpdateEffect } from "./presence.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InsertMessage = {
  readonly type: "INSERT"
  readonly peerId: string
  readonly node: CharNode
  readonly hlc: Hlc // Sender's HLC at time of send (for clock merge)
}

export type DeleteMessage = {
  readonly type: "DELETE"
  readonly peerId: string
  readonly nodeId: string
  readonly hlc: Hlc
}

export type PresenceMessage = {
  readonly type: "PRESENCE"
  readonly peerId: string
  readonly anchorId: string
  readonly headId: string
}

export type RelayMessage = InsertMessage | DeleteMessage | PresenceMessage

export type RelayConfig = {
  readonly channelName: string
  readonly peerId: string
  readonly hlcRef: React.RefObject<Hlc>
  readonly dispatch: (action: DocAction) => void // Dispatches to Causal Tree only (no re-broadcast)
  readonly getDocState: () => DocState
  readonly viewRef: React.RefObject<EditorView | null>
  readonly idMapField: StateField<readonly string[]>
  readonly updatePresence?: (
    peerId: string,
    anchorId: string,
    headId: string,
  ) => void
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

  switch (message.type) {
    case "INSERT": {
      // 1. Merge clocks (always, even for duplicates — keeps HLC monotonic)
      config.hlcRef.current = receive(config.hlcRef.current, message.hlc)

      // 2. Idempotency guard: if this node already exists in the tree,
      //    skip the insert entirely. This prevents duplicate characters
      //    in the CM view when the same message is received twice.
      if (config.getDocState().nodes.has(message.node.id)) {
        break
      }

      // 3. Calculate visible position BEFORE adding the node to the tree.
      //    This way findInsertPosition sees existing siblings but not the
      //    new node itself, giving the correct insertion index into the
      //    current CM document.
      const insertPos = findInsertPosition(
        config.getDocState(),
        message.node.parentId,
        message.node.id,
      )

      // 4. Dispatch INSERT to local Causal Tree
      config.dispatch({ type: "INSERT", node: message.node })

      // 5. Apply to CM view
      const view = config.viewRef.current
      if (view) {
        applyRemoteInsert(
          view,
          insertPos,
          message.node.value,
          message.node.id,
          config.idMapField,
          config.getDocState,
        )
      }
      break
    }

    case "DELETE": {
      // 1. Merge clocks
      config.hlcRef.current = receive(config.hlcRef.current, message.hlc)

      // 2. Look up the node's current position BEFORE dispatching delete
      const posMap = buildPositionMap(config.getDocState())
      const deletePos = posMap.positionOfId.get(message.nodeId)

      // 3. Dispatch DELETE to local Causal Tree
      config.dispatch({ type: "DELETE", nodeId: message.nodeId })

      // 4. Apply to CM view (only if the node was visible)
      const deleteView = config.viewRef.current
      if (deleteView && deletePos !== undefined) {
        applyRemoteDelete(
          deleteView,
          deletePos,
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
