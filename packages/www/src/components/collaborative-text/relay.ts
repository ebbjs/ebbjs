/**
 * Relay (Ebb-Native Wire Protocol)
 *
 * Simulates a network layer between two editor instances using the browser's
 * BroadcastChannel API. Messages follow ebb's Action → Update[] model:
 *
 * - Every write is an **Action**: the atomic sync unit, carrying one or more
 *   Updates that are always applied together. A multi-run delete that
 *   tombstones 5 runs produces 1 Action with 5 Updates, not 5 separate
 *   messages.
 *
 * - Each **Update** targets a single entity (a RunNode) and carries a
 *   self-describing `method` ("put" for insert, "delete" for tombstone)
 *   with typed field data — mirroring ebb's per-field merge dispatch.
 *
 * - **Presence** messages remain separate — they're ephemeral state, not
 *   durable data. Ebb doesn't model presence as Actions either.
 *
 * SPLIT actions are NOT broadcast — they are a local consequence of receiving
 * a remote INSERT_RUN. Each peer performs its own splits as needed.
 *
 * Idempotency is enforced at the **Action level**: each peer tracks a set
 * of seen action IDs, mirroring ebb's `cf_action_dedup` column family.
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
// Types — Ebb-native Action/Update model
// ---------------------------------------------------------------------------

/**
 * Self-describing field value for a causal tree run.
 *
 * Mirrors ebb's per-field type dispatch: each field carries a `type` tag
 * that determines how concurrent updates are merged. In ebb's core, this
 * would be "lww", "counter", or "crdt". For the causal tree, we define
 * "causal_tree_run" as a custom CRDT field type.
 */
export type CausalTreeRunFieldValue = {
  readonly type: "causal_tree_run"
  readonly value: RunNode
  readonly hlc: Hlc
  /**
   * If set, the parent run must be split at this offset before inserting
   * the new run. The sender split the parent locally (SPLIT is local-only),
   * so the receiver needs this offset to perform the same split.
   *
   * The split is idempotent — if the parent was already split at this
   * offset (e.g., by a prior message), the SPLIT reducer is a no-op.
   */
  readonly splitParentAt?: number
}

/**
 * Self-describing field value for a delete range operation.
 *
 * Carries the range metadata needed to tombstone a portion of a run.
 */
export type DeleteRangeFieldValue = {
  readonly type: "causal_tree_range"
  readonly value: { readonly offset: number; readonly count: number }
  readonly hlc: Hlc
}

/**
 * Self-describing field value for appending text to an existing run.
 *
 * This is the PATCH counterpart to PUT — instead of creating a new entity,
 * it extends an existing one. Mirrors ebb's PATCH method which applies
 * partial changes to existing entities.
 */
export type CausalTreeAppendFieldValue = {
  readonly type: "causal_tree_append"
  readonly value: { readonly text: string }
  readonly hlc: Hlc
}

export type FieldValue =
  | CausalTreeRunFieldValue
  | DeleteRangeFieldValue
  | CausalTreeAppendFieldValue

/**
 * A single mutation targeting one entity (RunNode).
 *
 * Mirrors ebb's Update structure:
 * - `subject_id`: the entity being mutated (RunNode ID)
 * - `subject_type`: entity type discriminant
 * - `method`: "put" (new run), "patch" (extend existing run), "delete" (tombstone)
 * - `data.fields`: self-describing typed field values
 */
export type Update = {
  readonly id: string
  readonly subject_id: string
  readonly subject_type: "run"
  readonly method: "put" | "patch" | "delete"
  readonly data: {
    readonly fields: Readonly<Record<string, FieldValue>>
  }
}

/**
 * The atomic sync unit — one or more Updates applied together.
 *
 * Mirrors ebb's Action structure:
 * - `id`: unique action ID (for dedup)
 * - `actor_id`: which peer authored this action
 * - `hlc`: sender's clock at time of action (for clock merge)
 * - `updates`: 1+ Updates, always synced/applied atomically
 *
 * A single CM transaction (e.g., "select-all and delete") may produce
 * multiple tree mutations. These are bundled into one Action, mirroring
 * ebb's guarantee that Actions are never split across sync pages.
 */
export type Action = {
  readonly id: string
  readonly actor_id: string
  readonly hlc: Hlc
  readonly updates: readonly Update[]
}

/** Ephemeral presence — not an Action (not durable data). */
export type PresenceMessage = {
  readonly type: "PRESENCE"
  readonly peerId: string
  readonly anchorId: string
  readonly anchorOffset: number
  readonly headId: string
  readonly headOffset: number
}

/**
 * Wire message types. Actions carry durable data; Presence is ephemeral.
 * This mirrors ebb's separation of sync (Actions) from presence.
 */
export type SyncMessage =
  | { readonly type: "ACTION"; readonly action: Action }
  | PresenceMessage

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
    anchorOffset: number,
    headId: string,
    headOffset: number,
  ) => void
  /** Optional callback invoked when a remote message is received (for inspector). */
  readonly onRemoteMessage?: (message: SyncMessage) => void
}

export type RelayHandle = {
  readonly broadcast: (message: SyncMessage) => void
}

// ---------------------------------------------------------------------------
// Action-level dedup (mirrors ebb's cf_action_dedup column family)
// ---------------------------------------------------------------------------

/**
 * Set of action IDs that have already been applied locally.
 * Idempotency is enforced at the Action level, not the node level —
 * if an Action is seen twice, ALL of its Updates are skipped.
 * This matches ebb's dedup model where the action_id is checked
 * against cf_action_dedup before any processing.
 */
const seenActionIds = new Set<string>()

// ---------------------------------------------------------------------------
// Core message handler (pure-ish, extracted for testability)
// ---------------------------------------------------------------------------

/**
 * Apply a single Update from an Action to the local Causal Tree and CM view.
 *
 * Dispatched per-update within an Action. Each update targets one entity
 * (RunNode) with a self-describing method and typed field data.
 */
const applyUpdate = (update: Update, config: RelayConfig): void => {
  switch (update.method) {
    case "put": {
      // PUT = insert a new run. The "run" field carries the full RunNode.
      const runField = update.data.fields["run"]
      if (!runField || runField.type !== "causal_tree_run") break

      const node = runField.value

      // Idempotency guard at the node level (within a non-duplicate Action,
      // this handles partial re-application edge cases)
      const docState = config.getDocState()
      if (docState.nodes.has(node.id)) break

      // If the sender split the parent run before inserting, we need to
      // perform the same split locally. The SPLIT is idempotent — if the
      // parent was already split (e.g., the split ID already exists in
      // the nodes map), the reducer is a no-op.
      if (runField.splitParentAt !== undefined) {
        const parentNode = docState.nodes.get(node.parentId)
        if (parentNode && parentNode.text.length > runField.splitParentAt) {
          config.dispatch({
            type: "SPLIT",
            runId: node.parentId,
            offset: runField.splitParentAt,
          })
        }
      }

      // Re-read doc state after potential split (dispatch is synchronous)
      const postSplitState = config.getDocState()

      // Calculate visible position BEFORE adding the node to the tree.
      // This way findInsertPosition sees existing siblings but not the
      // new node itself, giving the correct insertion index.
      const insertPos = findInsertPosition(postSplitState, node.parentId, node.id)

      // Dispatch INSERT_RUN to local Causal Tree
      config.dispatch({ type: "INSERT_RUN", node })

      // Apply to CM view — insert the entire run text in one transaction
      const view = config.viewRef.current
      if (view) {
        applyRemoteInsert(
          view,
          insertPos,
          node.text,
          node.id,
          config.idMapField,
          config.getDocState,
        )
      }
      break
    }

    case "delete": {
      // DELETE = tombstone a range within a run. The "range" field carries
      // the offset and count.
      const rangeField = update.data.fields["range"]
      if (!rangeField || rangeField.type !== "causal_tree_range") break

      const { offset, count } = rangeField.value

      // Look up the run's current position BEFORE dispatching delete
      const deleteDocState = config.getDocState()
      const deletePos = runOffsetToPosition(
        deleteDocState.index,
        update.subject_id,
        offset,
      )

      // Dispatch DELETE_RANGE to local Causal Tree
      config.dispatch({
        type: "DELETE_RANGE",
        runId: update.subject_id,
        offset,
        count,
      })

      // Apply to CM view (only if the run was visible)
      const deleteView = config.viewRef.current
      if (deleteView && deletePos !== undefined) {
        applyRemoteDelete(
          deleteView,
          deletePos,
          count,
          config.idMapField,
          config.getDocState,
        )
      }
      break
    }

    case "patch": {
      // PATCH = extend an existing run by appending text.
      // The "append" field carries the text to append.
      const appendField = update.data.fields["append"]
      if (!appendField || appendField.type !== "causal_tree_append") break

      const { text } = appendField.value

      // Find the end position of this run BEFORE dispatching extend.
      // The appended text goes at the end of the run's current span.
      const patchDocState = config.getDocState()
      const patchNode = patchDocState.nodes.get(update.subject_id)
      if (!patchNode || patchNode.deleted) break

      const runStartPos = runOffsetToPosition(
        patchDocState.index,
        update.subject_id,
        0,
      )
      if (runStartPos === undefined) break

      // Insert position = start of run + current text length
      const appendPos = runStartPos + patchNode.text.length

      // Dispatch EXTEND_RUN to local Causal Tree
      config.dispatch({
        type: "EXTEND_RUN",
        runId: update.subject_id,
        appendText: text,
      })

      // Apply to CM view — insert the appended text at the end of the run
      const patchView = config.viewRef.current
      if (patchView) {
        applyRemoteInsert(
          patchView,
          appendPos,
          text,
          update.subject_id,
          config.idMapField,
          config.getDocState,
        )
      }
      break
    }
  }
}

/**
 * Handle a received remote message. Extracted from the hook for testability.
 *
 * For ACTION messages: merges the HLC once, then iterates Updates,
 * dispatching each to the local tree. Enforces action-level idempotency.
 *
 * For PRESENCE messages: forwarded to the presence module (ephemeral, no dedup).
 */
export const handleRemoteMessage = (
  message: SyncMessage,
  config: RelayConfig,
): void => {
  switch (message.type) {
    case "ACTION": {
      const { action } = message

      // Ignore own actions
      if (action.actor_id === config.peerId) return

      // Notify inspector (if wired up)
      config.onRemoteMessage?.(message)

      // Action-level dedup (mirrors ebb's cf_action_dedup)
      if (seenActionIds.has(action.id)) return
      seenActionIds.add(action.id)

      // 1. Merge clocks ONCE per Action (not per Update)
      config.hlcRef.current = receive(config.hlcRef.current, action.hlc)

      // 2. Apply each Update in order
      for (const update of action.updates) {
        applyUpdate(update, config)
      }
      break
    }

    case "PRESENCE": {
      // Ignore own presence
      if (message.peerId === config.peerId) return

      // Notify inspector
      config.onRemoteMessage?.(message)

      // Forward to presence module
      config.updatePresence?.(
        message.peerId,
        message.anchorId,
        message.anchorOffset,
        message.headId,
        message.headOffset,
      )

      // Poke the CM view so the Presence ViewPlugin rebuilds decorations.
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
 *
 * The channel carries SyncMessages: either ACTION (durable data following
 * ebb's Action → Update[] model) or PRESENCE (ephemeral state).
 */
export const useRelay = (config: RelayConfig): RelayHandle => {
  const channelRef = useRef<BroadcastChannel | null>(null)

  // Keep config in a ref so the onmessage handler always sees the latest
  const configRef = useRef(config)
  configRef.current = config

  useEffect(() => {
    const channel = new BroadcastChannel(config.channelName)
    channelRef.current = channel

    channel.onmessage = (event: MessageEvent<SyncMessage>) => {
      handleRemoteMessage(event.data, configRef.current)
    }

    return () => {
      channel.close()
      channelRef.current = null
    }
  }, [config.channelName])

  const broadcast = useCallback((message: SyncMessage) => {
    channelRef.current?.postMessage(message)
  }, [])

  return { broadcast }
}
