/**
 * Inspector Store
 *
 * A lightweight, module-level observable store that both PeerEditor instances
 * write to and the InspectorPanel reads from. Uses useSyncExternalStore for
 * tear-free React integration.
 *
 * Three data streams:
 * - Event log: append-only list of messages sent/received between peers
 * - HLC state: latest Hybrid Logical Clock per peer
 * - Doc state: latest Causal Tree DocState per peer
 */

import { useSyncExternalStore } from "react"
import type { Hlc } from "./hlc.ts"
import type { DocState } from "./causal-tree.ts"
import type { RelayMessage } from "./relay.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InspectorEvent = {
  readonly id: number
  readonly timestamp: number // Date.now() at time of logging
  readonly peerId: string // Which peer generated/received this
  readonly direction: "sent" | "received"
  readonly message: RelayMessage
}

type InspectorSnapshot = {
  readonly events: readonly InspectorEvent[]
  readonly hlcStates: Readonly<Record<string, Hlc>>
  readonly docStates: Readonly<Record<string, DocState>>
}

// ---------------------------------------------------------------------------
// Store state (module-level singleton)
// ---------------------------------------------------------------------------

const MAX_EVENTS = 200

let nextEventId = 0
let events: InspectorEvent[] = []
let hlcStates: Record<string, Hlc> = {}
let docStates: Record<string, DocState> = {}
let snapshot: InspectorSnapshot = { events: [], hlcStates: {}, docStates: {} }
let listeners: Set<() => void> = new Set()

/** Notify all subscribers that the snapshot changed. */
const emit = (): void => {
  snapshot = {
    events: [...events],
    hlcStates: { ...hlcStates },
    docStates: { ...docStates },
  }
  for (const listener of listeners) {
    listener()
  }
}

// ---------------------------------------------------------------------------
// Public mutation functions (called by PeerEditor / Relay)
// ---------------------------------------------------------------------------

/** Append an event to the log and notify subscribers. */
export const logEvent = (
  peerId: string,
  direction: "sent" | "received",
  message: RelayMessage,
): void => {
  const event: InspectorEvent = {
    id: nextEventId++,
    timestamp: Date.now(),
    peerId,
    direction,
    message,
  }

  events.push(event)

  // Cap at MAX_EVENTS to prevent unbounded memory growth
  if (events.length > MAX_EVENTS) {
    events = events.slice(-MAX_EVENTS)
  }

  emit()
}

/** Update a peer's latest HLC and notify subscribers. */
export const updateHlc = (peerId: string, hlc: Hlc): void => {
  hlcStates = { ...hlcStates, [peerId]: hlc }
  emit()
}

/** Update a peer's latest DocState and notify subscribers. */
export const updateDocState = (peerId: string, state: DocState): void => {
  docStates = { ...docStates, [peerId]: state }
  emit()
}

/** Clear all events (useful for a "clear log" button). */
export const clearEvents = (): void => {
  events = []
  emit()
}

// ---------------------------------------------------------------------------
// React integration via useSyncExternalStore
// ---------------------------------------------------------------------------

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = (): InspectorSnapshot => snapshot

/** React hook to read the full inspector snapshot. */
export const useInspectorStore = (): InspectorSnapshot =>
  useSyncExternalStore(subscribe, getSnapshot)
