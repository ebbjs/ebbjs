# Presence

## Purpose

Tracks where remote peers' cursors and selections are in the document and renders them as visual decorations in CodeMirror. Presence data is expressed in terms of `CharNode` IDs (stable across edits) rather than positions (which shift). The Presence module resolves IDs to current positions using the CM Bridge's StateField, and renders cursor lines and selection highlights as CM6 decorations.

## Responsibilities

- Maintain a map of remote peer presence data (`peerId → { anchorId, headId }`)
- Update presence data when remote presence messages arrive
- Resolve node IDs to current document positions via the CM Bridge
- Render remote cursors as `WidgetDecoration` (colored cursor line) and selections as `Decoration.mark` (colored highlight)
- Assign distinct colors to each remote peer

## Public interface

### Exported functions / extensions

| Name | Signature | Description |
|------|-----------|-------------|
| `createPresenceExtension` | `(config: PresenceConfig) => Extension` | Returns a CM6 Extension (ViewPlugin) that renders remote cursors and selections as decorations |
| `usePresence` | `(peerId: string) => PresenceHook` | React hook that manages the presence state map and provides functions to update it |

### Types

```ts
type PresenceData = {
  readonly peerId: string
  readonly anchorId: string   // CharNode ID at the anchor of the selection
  readonly headId: string     // CharNode ID at the head of the selection (same as anchor if no selection)
  readonly color: string      // CSS color for this peer's cursor/selection
}

type PresenceConfig = {
  readonly localPeerId: string
  readonly getPresenceMap: () => ReadonlyMap<string, PresenceData>
  readonly getPositionOfId: (nodeId: string) => number | undefined
}

type PresenceHook = {
  readonly presenceMap: ReadonlyMap<string, PresenceData>
  readonly updatePresence: (peerId: string, anchorId: string, headId: string) => void
  readonly getLocalPresence: (editorState: EditorState) => { anchorId: string; headId: string }
}
```

## Dependencies

| Dependency | What it needs | Reference |
|------------|---------------|-----------|
| CM Bridge | `getPositionOfId` function to resolve node IDs to positions | [cm-bridge.md](cm-bridge.md#exported-functions--extensions) |
| CodeMirror 6 | `ViewPlugin`, `Decoration`, `WidgetType`, `EditorView`, `DecorationSet` | External dependency (`@codemirror/view`) |

## Internal design notes

### Cursor rendering

The ViewPlugin rebuilds its `DecorationSet` on every document update. For each entry in the presence map (excluding the local peer):
1. Look up `anchorId` and `headId` positions via `getPositionOfId`
2. If both resolve to valid positions:
   - If anchor === head: render a `WidgetDecoration` at that position (a thin colored line)
   - If anchor !== head: render a `Decoration.mark` over the range with a colored background

If an ID doesn't resolve (the character was deleted), skip that peer's cursor. This is acceptable for a prototype — in production you'd fall back to the nearest visible character.

### Color assignment

Use a fixed palette of 4-5 distinct colors. Assign based on peer ID hash or simple index. Since this prototype only has 2 peers, even a hardcoded mapping (`peer-A → blue`, `peer-B → orange`) is fine.

### Local presence tracking

`getLocalPresence` reads the CM editor's current selection (`state.selection.main`) and maps the anchor/head positions back to node IDs using the CM Bridge's ID map. This is broadcast to remote peers via the Relay.

### Presence message format

Presence updates are sent as separate messages through the Relay (not bundled with edit operations). The message shape:

```ts
type PresenceMessage = {
  readonly type: "PRESENCE"
  readonly peerId: string
  readonly anchorId: string
  readonly headId: string
}
```

## Open questions

- **Throttling presence updates:** Every cursor movement triggers a presence broadcast. For two local editors this is fine. If this were a real network, you'd throttle to ~50ms. Not needed for the prototype but worth noting.
- **Cursor widget styling:** The cursor widget needs to be a DOM element (a `<span>` with absolute positioning and a colored border). CM6's `WidgetType` requires a `toDOM` method. This is one place where a class is technically required by CM6's API — `WidgetType` is a class you extend. This is an exception to the "no classes" rule since it's dictated by the CM6 API. Alternatively, use `Decoration.widget` with an inline `toDOM` function if CM6 supports it.

## File

`src/presence.ts` — imports from `./cm-bridge.ts` and `@codemirror/*`.
No dedicated test file — tested through Slice 4 acceptance criteria.
