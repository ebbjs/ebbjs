# Presence

## Purpose

Tracks where remote peers' cursors and selections are in the document and renders them as visual decorations in CodeMirror. Presence data is now expressed in terms of `(runId, offset)` pairs (stable across edits) rather than bare character-position node IDs. The Presence module resolves these to current document positions using the Causal Tree's `PositionIndex` and renders cursor lines and selection highlights as CM6 decorations.

## Responsibilities

- Maintain a map of remote peer presence data (`peerId → { anchorRunId, anchorOffset, headRunId, headOffset }`)
- Update presence data when remote presence messages arrive
- Resolve `(runId, offset)` pairs to current document positions via the `PositionIndex`
- Render remote cursors as `WidgetDecoration` (colored cursor line) and selections as `Decoration.mark` (colored highlight)
- Assign distinct colors to each remote peer

## Public interface

### Types

```ts
type PresenceData = {
  readonly peerId: string
  readonly anchorRunId: string    // RunNode ID at the anchor of the selection
  readonly anchorOffset: number   // Offset within the anchor run
  readonly headRunId: string      // RunNode ID at the head of the selection
  readonly headOffset: number     // Offset within the head run
  readonly color: string          // CSS color for this peer's cursor/selection
}

type PresenceConfig = {
  readonly localPeerId: string
  readonly getPresenceMap: () => ReadonlyMap<string, PresenceData>
  readonly idMapField: StateField<readonly RunSpan[]>
  readonly getDocState: () => DocState
}

type PresenceHook = {
  readonly presenceMap: ReadonlyMap<string, PresenceData>
  readonly presenceMapRef: MutableRefObject<ReadonlyMap<string, PresenceData>>
  readonly updatePresence: (
    peerId: string,
    anchorRunId: string, anchorOffset: number,
    headRunId: string, headOffset: number,
  ) => void
  readonly getLocalPresenceIds: (editorState: EditorState) => {
    anchorRunId: string; anchorOffset: number;
    headRunId: string; headOffset: number;
  }
}
```

### Exported functions / values

| Name | Signature | Description |
|------|-----------|-------------|
| `usePresence` | `(peerId: string, idMapField: StateField<...>) => PresenceHook` | React hook managing the presence state map. Provides `updatePresence` and `getLocalPresenceIds`. |
| `createPresenceExtension` | `(config: PresenceConfig) => Extension` | CM6 ViewPlugin that renders remote cursors and selections as decorations. |
| `presenceUpdateEffect` | `StateEffect<void>` | No-op effect dispatched to poke CM into rebuilding presence decorations when remote presence data changes. |
| `positionToRunOffset` | `(editorState, position, idMapField) => { runId, offset }` | Map a cursor position to a `(runId, offset)` pair for presence broadcasting. |
| `runOffsetToDocPosition` | `(editorState, runId, offset, idMapField) => number \| undefined` | Resolve a `(runId, offset)` pair back to a document position for rendering. |

## Dependencies

| Dependency | What it needs | Reference |
|------------|---------------|-----------|
| Causal Tree | `DocState`, `PositionIndex`, `RunSpan`, `runOffsetToPosition`, `lookupPosition`, `ROOT_ID` | [causal-tree.md](causal-tree.md) |
| CM Bridge | `idMapField` StateField (reads spans for position resolution) | [cm-bridge.md](cm-bridge.md) |
| `@codemirror/view` | `ViewPlugin`, `Decoration`, `WidgetType`, `EditorView`, `DecorationSet` | External |
| `@codemirror/state` | `StateEffect`, `EditorState`, `Extension`, `StateField` | External |

## Internal design notes

### Change from node IDs to (runId, offset) pairs

The current implementation tracks cursor position as a single `CharNode.id`. With runs, a cursor position within a run needs both the run ID and the character offset within that run. For example, if the cursor is after the 3rd character of run "hello", the presence data is `{ runId: "hello-run-id", offset: 3 }`.

This is more stable than bare positions because:
- If text is inserted *before* the run, the `(runId, offset)` still resolves correctly
- If the run itself is extended (more chars appended), the offset still points to the same character
- Only if the run is *split* at or before the offset does the resolution need to account for the split — and `runOffsetToPosition` handles this by checking if the run still exists and has enough characters

### Cursor rendering (unchanged approach)

The ViewPlugin rebuilds its `DecorationSet` on every update. For each entry in the presence map (excluding the local peer):
1. Resolve `(anchorRunId, anchorOffset)` and `(headRunId, headOffset)` to document positions
2. If both resolve: render cursor widget (if same position) or selection mark (if range)
3. If either fails to resolve (run deleted): skip that peer's cursor

### Color assignment (unchanged)

Hardcoded: `peer-A → blue (#3b82f6)`, `peer-B → orange (#f97316)`. Fallback palette for unknown peers.

## Open questions

- **Cursor on split boundary**: If a run is split at exactly the cursor's offset, should the cursor resolve to the end of the left half or the beginning of the right half? **Suggested approach**: End of the left half (the cursor was "after" that character, and the left half retains the original ID). The right half is a new run from the cursor's perspective.

## File

`src/presence.ts` — imports from `./causal-tree.ts`, `./cm-bridge.ts`, and `@codemirror/*`.
No dedicated test file — tested through slice acceptance criteria.
