/**
 * Presence (Run-Optimized)
 *
 * Tracks remote peer cursors and selections, and renders them as CodeMirror 6
 * decorations (colored cursor lines and selection highlights).
 *
 * Presence data is expressed in terms of CharNode IDs (stable across edits)
 * rather than document positions (which shift). The Presence module resolves
 * IDs to current positions using the Causal Tree's PositionIndex via the
 * CM Bridge's RunSpan StateField.
 *
 * Two exports:
 * - `usePresence` — React hook managing the presence map
 * - `createPresenceExtension` — CM6 ViewPlugin for rendering decorations
 */

import { useCallback, useRef, useState, type MutableRefObject } from "react"
import {
  type DecorationSet,
  Decoration,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view"
import {
  StateEffect,
  type EditorState,
  type Extension,
  type StateField,
} from "@codemirror/state"
import {
  ROOT_ID,
  type DocState,
  type RunSpan,
} from "./causal-tree.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PresenceData = {
  readonly peerId: string
  readonly anchorId: string // Run ID at the anchor of the selection
  readonly anchorOffset: number // Offset within the anchor run (0-based)
  readonly headId: string // Run ID at the head (same as anchor if no selection)
  readonly headOffset: number // Offset within the head run (0-based)
  readonly color: string // CSS color for this peer's cursor/selection
}

export type PresenceConfig = {
  readonly localPeerId: string
  readonly getPresenceMap: () => ReadonlyMap<string, PresenceData>
  readonly idMapField: StateField<readonly RunSpan[]>
  readonly getDocState: () => DocState
}

/** Reference to a position within a run: run ID + character offset within it. */
export type RunRef = {
  readonly runId: string
  readonly offset: number
}

export type PresenceHook = {
  readonly presenceMap: ReadonlyMap<string, PresenceData>
  /** Mutable ref to the presence map — always up-to-date synchronously. */
  readonly presenceMapRef: MutableRefObject<ReadonlyMap<string, PresenceData>>
  readonly updatePresence: (
    peerId: string,
    anchorId: string,
    anchorOffset: number,
    headId: string,
    headOffset: number,
  ) => void
  readonly getLocalPresenceIds: (
    editorState: EditorState,
  ) => { anchor: RunRef; head: RunRef }
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/**
 * A no-op CM6 StateEffect dispatched when remote presence data changes.
 * This forces the CM view to process a transaction, which triggers the
 * Presence ViewPlugin's `update()` method to rebuild decorations.
 *
 * Without this, React state updates to the presence map would never
 * cause the ViewPlugin to re-render — CM6 only calls `update()` on
 * actual CM transactions.
 */
export const presenceUpdateEffect = StateEffect.define<void>()

// ---------------------------------------------------------------------------
// Color assignment
// ---------------------------------------------------------------------------

const PEER_COLORS: Record<string, string> = {
  "peer-A": "#60a5fa", // blue-400 (bright enough for dark backgrounds)
  "peer-B": "#fbbf24", // amber-400 (matching ebb site accent palette)
}

/** Fallback palette for unknown peer IDs. */
const FALLBACK_PALETTE = [
  "#ef4444", // red-500
  "#10b981", // emerald-500
  "#8b5cf6", // violet-500
  "#ec4899", // pink-500
  "#14b8a6", // teal-500
]

const colorForPeer = (peerId: string): string => {
  if (peerId in PEER_COLORS) return PEER_COLORS[peerId]!
  // Simple hash-based fallback
  let hash = 0
  for (let i = 0; i < peerId.length; i++) {
    hash = (hash * 31 + peerId.charCodeAt(i)) | 0
  }
  return FALLBACK_PALETTE[Math.abs(hash) % FALLBACK_PALETTE.length]!
}

// ---------------------------------------------------------------------------
// Cursor widget
// ---------------------------------------------------------------------------

/**
 * CM6 requires extending WidgetType (a class) to render inline widgets.
 * This is the one exception to the "no classes" rule — dictated by CM6's API.
 */
class CursorWidget extends WidgetType {
  constructor(
    readonly color: string,
    readonly label: string,
  ) {
    super()
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span")
    span.className = "cm-remote-cursor"
    span.style.borderLeft = `2px solid ${this.color}`
    span.style.height = "1.2em"
    span.style.display = "inline-block"
    span.style.width = "0"
    span.style.verticalAlign = "text-bottom"
    span.style.position = "relative"
    span.style.marginLeft = "-1px"
    span.style.marginRight = "-1px"
    span.setAttribute("aria-label", `${this.label}'s cursor`)

    // Peer label tooltip above the cursor
    const label = document.createElement("span")
    label.className = "cm-remote-cursor-label"
    label.textContent = this.label
    label.style.position = "absolute"
    label.style.bottom = "100%"
    label.style.left = "-1px"
    label.style.padding = "1px 4px"
    label.style.fontSize = "10px"
    label.style.lineHeight = "1.2"
    label.style.backgroundColor = this.color
    label.style.color = "white"
    label.style.borderRadius = "2px"
    label.style.whiteSpace = "nowrap"
    label.style.pointerEvents = "none"
    span.appendChild(label)

    return span
  }

  eq(other: CursorWidget): boolean {
    return this.color === other.color && this.label === other.label
  }
}

// ---------------------------------------------------------------------------
// Position resolution helpers
// ---------------------------------------------------------------------------

/**
 * Map a cursor position (0-based document offset) to a RunRef (runId + offset).
 *
 * Convention:
 * - Position 0 → ROOT_ID, offset 0 (cursor is before all content)
 * - Position P > 0 → the run containing char at P-1, with the intra-run offset
 *   (cursor is logically "after" that character)
 *
 * The offset is critical for correct remote cursor rendering within long runs
 * (e.g., after EXTEND_RUN coalescing where a single run may contain many chars).
 */
export const positionToRunRef = (
  editorState: EditorState,
  position: number,
  idMapField: StateField<readonly RunSpan[]>,
): RunRef => {
  const spans = editorState.field(idMapField)

  if (spans.length === 0) return { runId: ROOT_ID, offset: 0 }
  if (position === 0) return { runId: ROOT_ID, offset: 0 }

  // Walk spans to find the run containing position - 1
  let cumulative = 0
  for (const span of spans) {
    if (position - 1 < cumulative + span.length) {
      return { runId: span.runId, offset: position - 1 - cumulative }
    }
    cumulative += span.length
  }

  // Past end — return last run ID at its last offset
  const lastSpan = spans[spans.length - 1]
  return lastSpan
    ? { runId: lastSpan.runId, offset: lastSpan.length - 1 }
    : { runId: ROOT_ID, offset: 0 }
}

/**
 * Resolve a RunRef (runId + offset) back to a document position for rendering.
 *
 * Convention (inverse of positionToRunRef):
 * - ROOT_ID → position 0
 * - A valid run ID + offset → cumulative position of run start + offset + 1
 *   (cursor is "after" the character at that offset)
 * - Unknown/deleted ID → undefined (skip rendering)
 *
 * If the offset exceeds the current span length (e.g., the run was split
 * after the presence message was sent), the position is clamped to the
 * end of the span.
 */
export const runRefToPosition = (
  editorState: EditorState,
  runId: string,
  offset: number,
  idMapField: StateField<readonly RunSpan[]>,
): number | undefined => {
  if (runId === ROOT_ID) return 0

  const spans = editorState.field(idMapField)
  let cumulative = 0
  for (const span of spans) {
    if (span.runId === runId) {
      // Clamp offset to span length - 1 (in case the run was split
      // after the presence message was sent)
      const clampedOffset = Math.min(offset, span.length - 1)
      // Cursor is "after" the character at this offset
      return cumulative + clampedOffset + 1
    }
    cumulative += span.length
  }
  return undefined
}

// ---------------------------------------------------------------------------
// usePresence hook
// ---------------------------------------------------------------------------

/**
 * React hook that manages the presence state map.
 *
 * The presence map is stored in a mutable ref so that `updatePresence`
 * updates it **synchronously**. This is critical because the CM6 ViewPlugin
 * reads the map immediately when a `presenceUpdateEffect` transaction fires
 * — if we only used React `useState`, the ref wouldn't be updated until the
 * next React render, causing the remote cursor to always be 1 update behind.
 *
 * We also keep a `useState` copy so React components that depend on the
 * presence map (e.g. for debug display) still trigger re-renders.
 */
export const usePresence = (
  peerId: string,
  idMapField: StateField<readonly RunSpan[]>,
): PresenceHook => {
  // Mutable ref — updated synchronously in updatePresence so the CM
  // ViewPlugin always reads the latest data.
  const presenceMapRef = useRef<ReadonlyMap<string, PresenceData>>(new Map())

  // React state copy — triggers re-renders for any React consumers.
  const [presenceMap, setPresenceMap] = useState<
    ReadonlyMap<string, PresenceData>
  >(() => new Map())

  const updatePresence = useCallback(
    (
      remotePeerId: string,
      anchorId: string,
      anchorOffset: number,
      headId: string,
      headOffset: number,
    ) => {
      const next = new Map(presenceMapRef.current)
      next.set(remotePeerId, {
        peerId: remotePeerId,
        anchorId,
        anchorOffset,
        headId,
        headOffset,
        color: colorForPeer(remotePeerId),
      })
      // Update ref synchronously — the ViewPlugin reads this immediately
      presenceMapRef.current = next
      // Also update React state for re-renders
      setPresenceMap(next)
    },
    [],
  )

  const getLocalPresenceIds = useCallback(
    (editorState: EditorState) => {
      const sel = editorState.selection.main
      const anchor = positionToRunRef(editorState, sel.anchor, idMapField)
      const head = positionToRunRef(editorState, sel.head, idMapField)
      return { anchor, head }
    },
    [idMapField],
  )

  return {
    presenceMap,
    presenceMapRef,
    updatePresence,
    getLocalPresenceIds,
  }
}

// ---------------------------------------------------------------------------
// CM6 Presence Extension (ViewPlugin)
// ---------------------------------------------------------------------------

/**
 * Creates a CM6 Extension (ViewPlugin) that renders remote peer cursors
 * and selections as decorations.
 *
 * Rebuilds decorations on every update by resolving node IDs to current
 * positions. This is O(peers * spans) per update but fine for a prototype
 * with 2 peers.
 */
export const createPresenceExtension = (
  config: PresenceConfig,
): Extension => {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view.state, config)
      }

      update(update: ViewUpdate) {
        // Rebuild on every update — doc changes, selection changes,
        // or presence map changes (triggered by React re-render)
        this.decorations = buildDecorations(update.state, config)
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  )
}

/**
 * Build a DecorationSet with remote cursor widgets and selection marks
 * for all peers in the presence map.
 */
const buildDecorations = (
  editorState: EditorState,
  config: PresenceConfig,
): DecorationSet => {
  const presenceMap = config.getPresenceMap()
  const decorations: { from: number; to: number; decoration: Decoration }[] = []

  for (const [remotePeerId, data] of presenceMap) {
    // Skip local peer
    if (remotePeerId === config.localPeerId) continue

    const anchorPos = runRefToPosition(
      editorState,
      data.anchorId,
      data.anchorOffset,
      config.idMapField,
    )
    const headPos = runRefToPosition(
      editorState,
      data.headId,
      data.headOffset,
      config.idMapField,
    )

    // If either position can't be resolved (deleted char), skip
    if (anchorPos === undefined || headPos === undefined) continue

    // Clamp positions to document bounds
    const docLen = editorState.doc.length
    const clampedAnchor = Math.min(anchorPos, docLen)
    const clampedHead = Math.min(headPos, docLen)

    if (clampedAnchor === clampedHead) {
      // Cursor (no selection): render a widget
      decorations.push({
        from: clampedAnchor,
        to: clampedAnchor,
        decoration: Decoration.widget({
          widget: new CursorWidget(data.color, data.peerId),
          side: 1, // render after the character at this position
        }),
      })
    } else {
      // Selection range: render a mark
      const from = Math.min(clampedAnchor, clampedHead)
      const to = Math.max(clampedAnchor, clampedHead)
      decorations.push({
        from,
        to,
        decoration: Decoration.mark({
          class: "cm-remote-selection",
          attributes: {
            style: `background-color: ${data.color}33`, // 20% opacity
          },
        }),
      })
      // Also render a cursor widget at the head position
      decorations.push({
        from: clampedHead,
        to: clampedHead,
        decoration: Decoration.widget({
          widget: new CursorWidget(data.color, data.peerId),
          side: 1,
        }),
      })
    }
  }

  // Sort by from position — required by CM6's Decoration.set
  decorations.sort((a, b) => a.from - b.from || a.to - b.to)
  return Decoration.set(
    decorations.map((d) =>
      d.from === d.to
        ? d.decoration.range(d.from)
        : d.decoration.range(d.from, d.to),
    ),
  )
}
