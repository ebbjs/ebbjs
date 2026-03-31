# Slice 4: Presence Cursors

## Goal

Each editor displays the remote peer's cursor position (and optionally selection range) as a colored decoration, and the cursor tracks correctly as the document is edited by either peer.

## Components involved

| Component | Interface subset used |
|-----------|---------------------|
| [Presence](../components/presence.md) | `createPresenceExtension`, `usePresence`, `PresenceData`, `PresenceMessage` |
| [CM Bridge](../components/cm-bridge.md) | `getIdAtPosition`, `getPositionOfId` (for resolving cursor IDs to positions) |
| [Relay](../components/relay.md) | `PresenceMessage` handling (broadcast + receive) |
| [Editor App](../components/editor-app.md) | Wire presence extension and hook into each `PeerEditor` |

## Flow

### Broadcasting local cursor position

1. User moves cursor or changes selection in Peer A's editor
2. The Presence extension's ViewPlugin detects the selection change (via `update.selectionSet` or `update.docChanged`)
3. It reads the current selection: `state.selection.main.anchor` and `state.selection.main.head`
4. It maps these positions to node IDs via `getIdAtPosition(state, anchor)` and `getIdAtPosition(state, head)`
   - Special case: if cursor is at position 0 (before any character), use `"ROOT"` as the ID
   - If cursor is at the end of the document, use the ID of the last character
5. Peer A calls `relay.broadcast({ type: "PRESENCE", peerId: "peer-A", anchorId, headId })`

### Receiving remote cursor position

6. Peer B's Relay receives the PRESENCE message
7. Relay calls `updatePresence("peer-A", anchorId, headId)` which updates Peer B's presence map
8. Peer B's Presence ViewPlugin rebuilds its decorations on the next update cycle:
   a. For each remote peer in the presence map, resolve `anchorId` and `headId` to current positions via `getPositionOfId`
   b. If anchor === head: create a `WidgetDecoration` at that position (a thin colored cursor line)
   c. If anchor !== head: create a `Decoration.mark` over the range (colored selection highlight)
9. The remote cursor appears in Peer B's editor at the correct position

### Cursor stability through edits

10. Peer B types a character before Peer A's cursor position
11. Peer A's cursor is tracked by node ID, not position. The node ID doesn't change when other text is inserted.
12. On the next decoration rebuild, `getPositionOfId(anchorId)` returns the new (shifted) position
13. The remote cursor decoration moves to the correct new position automatically

### Cursor on deleted character

14. Peer B deletes the character that Peer A's cursor is on
15. `getPositionOfId(anchorId)` returns `undefined` (the node is deleted/tombstoned)
16. The Presence extension skips rendering Peer A's cursor (it disappears until Peer A moves their cursor to a visible character)

## Acceptance criteria

- [ ] Peer A's cursor position is visible in Peer B's editor as a colored vertical line
- [ ] Peer B's cursor position is visible in Peer A's editor as a colored vertical line
- [ ] Cursors are visually distinct from the local cursor (different color, e.g., blue for Peer A, orange for Peer B)
- [ ] When Peer A moves their cursor (arrow keys, click), the remote cursor in Peer B's editor updates
- [ ] When Peer B types text before Peer A's cursor, Peer A's remote cursor in Peer B's editor shifts to the correct position (because it's tracked by node ID, not position)
- [ ] When a character under a remote cursor is deleted, the remote cursor disappears gracefully (no crash, no stale position)
- [ ] Selection ranges: if Peer A selects a range of text, Peer B sees a colored highlight over that range
- [ ] Presence updates don't interfere with text sync (PRESENCE messages are handled separately from INSERT/DELETE)

## Build order

1. **Implement `usePresence` hook in `src/presence.ts`** — manages the `Map<string, PresenceData>` state. Provides `updatePresence` and `getLocalPresence` functions.

2. **Add PRESENCE message handling to `src/relay.ts`** — when a PRESENCE message arrives, call `updatePresence`. When the local selection changes, broadcast a PRESENCE message.

3. **Implement `createPresenceExtension` in `src/presence.ts`** — a CM6 ViewPlugin that:
   - On each update, reads the presence map
   - Resolves IDs to positions via `getPositionOfId`
   - Builds a `DecorationSet` with cursor widgets and selection marks
   - The cursor widget is a small DOM element (colored `<span>` with `border-left: 2px solid <color>`, `height: 1em`, positioned inline)

4. **Wire into `src/App.tsx`** — add the presence extension to each editor's CM configuration. Add the `usePresence` hook to each `PeerEditor`. Connect the relay to broadcast presence and receive remote presence.

5. **Add `getIdAtPosition` and `getPositionOfId` to `src/cm-bridge.ts`** if not already implemented — these are simple lookups on the ID map StateField.

6. **Manual testing** — open the app, click around in one editor, verify the cursor appears in the other. Select text, verify the highlight appears. Type in one editor while watching the other's remote cursor shift.

7. **Edge case testing** — delete the character under a remote cursor, verify no crash. Move cursor to position 0, verify it renders. Move cursor to end of document, verify it renders.
