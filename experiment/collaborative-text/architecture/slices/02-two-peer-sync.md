# Slice 2: Two-Peer Sync

## Goal

Two side-by-side CodeMirror editors, each with its own peer identity, where typing in one editor causes the text to appear in the other — proving the BroadcastChannel relay and remote operation application work correctly.

## Components involved

| Component | Interface subset used |
|-----------|---------------------|
| [HLC](../components/hlc.md) | `createHlc`, `increment`, `receive`, `toString` |
| [Causal Tree](../components/causal-tree.md) | `createDocState`, `docReducer`, `findInsertPosition`, `buildPositionMap` |
| [CM Bridge](../components/cm-bridge.md) | `createBridgeExtension`, `applyRemoteInsert`, `applyRemoteDelete` |
| [Relay](../components/relay.md) | `useRelay`, `RelayMessage`, `InsertMessage`, `DeleteMessage` |
| [Editor App](../components/editor-app.md) | Full `App` with two `PeerEditor` instances |

## Flow

### Local insert → remote receive

1. User types `"a"` at position 3 in Peer A's editor
2. CM Bridge's updateListener fires in Peer A (same as Slice 1 flow)
3. The `dispatch` callback in Peer A does two things:
   a. Calls `treeDispatch(insertAction)` to update Peer A's Causal Tree
   b. Calls `relay.broadcast({ type: "INSERT", peerId: "peer-A", node, hlc })` to send to Peer B
4. `BroadcastChannel.postMessage` delivers the message
5. Peer B's Relay `onmessage` handler fires:
   a. Calls `receive(localHlc, message.hlc)` to merge Peer B's clock with Peer A's → updates `hlcRef.current`
   b. Calls `dispatch({ type: "INSERT", node: message.node })` to add the node to Peer B's Causal Tree
   c. Calls `findInsertPosition(getDocState(), node.parentId, node.id)` to determine where the character goes in Peer B's document
   d. Calls `applyRemoteInsert(viewRef.current, position, "a", node.id)` to insert the text in Peer B's CM editor
6. Peer B's CM editor now shows `"a"` at the correct position
7. Peer B's CM Bridge updateListener sees the transaction but it's annotated as remote → skips it (no infinite loop)

### Local delete → remote receive

1. User deletes character at position 2 in Peer A's editor
2. CM Bridge's updateListener fires, reads the node ID from the ID map, dispatches DELETE
3. `dispatch` callback broadcasts `{ type: "DELETE", peerId: "peer-A", nodeId, hlc }`
4. Peer B's Relay receives:
   a. Merges clocks
   b. Looks up the node's current position in Peer B's document via `buildPositionMap` **before** dispatching the delete
   c. Dispatches DELETE to Peer B's Causal Tree
   d. Calls `applyRemoteDelete(viewRef.current, position)` to remove the character from Peer B's CM editor
5. Both editors now show the same text

### Bidirectional editing

Both peers can type simultaneously. Each peer's local edits are applied immediately to their own CM + Causal Tree, then broadcast. Remote edits arrive and are applied to the other peer's state. As long as edits don't target the same position, this is straightforward — the Causal Tree's parent-based insertion ensures characters end up in the right place regardless of arrival order.

## Acceptance criteria

- [ ] Two CodeMirror editors render side-by-side, labeled "Peer A" and "Peer B"
- [ ] Typing in Peer A's editor causes the same text to appear in Peer B's editor
- [ ] Typing in Peer B's editor causes the same text to appear in Peer A's editor
- [ ] Deleting in one editor removes the character in the other
- [ ] After any sequence of non-concurrent edits, both editors show identical text
- [ ] After any sequence of non-concurrent edits, `reconstruct(peerA.docState) === reconstruct(peerB.docState)`
- [ ] HLC merge works: after receiving a remote message, the local HLC is at least as large as the remote HLC
- [ ] No infinite loops: remote transactions don't trigger re-broadcast
- [ ] Multi-character paste in one editor appears correctly in the other

## Build order

1. **Implement `src/relay.ts`** — the `useRelay` hook. Start with just INSERT message handling. Use a mock `BroadcastChannel` in tests (or test the message handling logic as a pure function extracted from the hook).

2. **Update `src/App.tsx`** — render two `PeerEditor` instances side-by-side. Each gets its own `useReducer`, HLC ref, CM view ref, and `useRelay` hook. Wire the `dispatch` callback to both update the local tree and broadcast.

3. **Add `applyRemoteInsert` and `applyRemoteDelete` to `src/cm-bridge.ts`** — these functions dispatch annotated transactions to the CM view.

4. **Test INSERT sync manually** — type in Peer A, verify text appears in Peer B and vice versa.

5. **Add DELETE message handling to the Relay** — wire up the delete flow.

6. **Test DELETE sync manually** — delete in one editor, verify it disappears in the other.

7. **Write `src/__tests__/relay.test.ts`** — test the message handling logic: given a remote INSERT message and a current DocState, verify the correct position is calculated and the correct CM transaction would be dispatched. Mock the CM view and BroadcastChannel.

8. **Stress test** — type rapidly in both editors simultaneously. At this point, concurrent edits at the same position may produce different results in each editor (that's Slice 3's problem). But non-overlapping edits should sync correctly.
