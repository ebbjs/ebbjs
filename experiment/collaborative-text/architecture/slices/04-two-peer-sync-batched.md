# Slice 4: Two-Peer Sync with Batched Protocol

## Goal

Two side-by-side CodeMirror editors where typing in one causes the text to appear in the other, using run-level messages (`INSERT_RUN`, `DELETE_RANGE`) instead of per-character messages — proving the batched relay protocol works correctly.

## Components involved

| Component                                   | Interface subset used                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [HLC](../components/hlc.md)                 | `createHlc`, `increment`, `receive`, `toString`                                                              |
| [Causal Tree](../components/causal-tree.md) | `createDocState`, `docReducer`, `findInsertPosition`, `runOffsetToPosition`, `lookupPosition`, `reconstruct` |
| [CM Bridge](../components/cm-bridge.md)     | `createBridgeExtension`, `applyRemoteInsert`, `applyRemoteDelete`, `createIdMapField`, `setIdMapEffect`      |
| [Relay](../components/relay.md)             | `useRelay`, `handleRemoteMessage`, `InsertRunMessage`, `DeleteRangeMessage`                                  |
| [Editor App](../components/editor-app.md)   | Full `App` with two `PeerEditor` instances                                                                   |

## Flow

### Local insert → remote receive (run-level)

1. User pastes "hello world" in Peer A's editor
2. CM Bridge creates one `RunNode { text: "hello world", ... }` and dispatches `INSERT_RUN`
3. `localDispatch` updates Peer A's tree AND broadcasts: `{ type: "INSERT_RUN", peerId: "peer-A", node: { ... }, hlc }`
4. **One message** over BroadcastChannel (not 11)
5. Peer B's Relay `onmessage` fires:
   a. Merges clocks: `hlcRef.current = receive(hlcRef.current, message.hlc)`
   b. Idempotency check: node ID not in tree → proceed
   c. Calculates position: `findInsertPosition(state, node.parentId, node.id)` → position 0 (empty doc)
   d. Dispatches `INSERT_RUN` to Peer B's tree
   e. Applies to CM: `applyRemoteInsert(view, 0, "hello world", ...)` — **one CM transaction** for all 11 chars
6. Peer B's editor shows "hello world"

### Local delete → remote receive (range-level)

1. User selects "world" (positions 6-11) in Peer A and deletes
2. CM Bridge dispatches `DELETE_RANGE(runId, offset: 6, count: 5)` (or multiple if spanning runs)
3. `localDispatch` broadcasts: `{ type: "DELETE_RANGE", peerId: "peer-A", runId, offset: 6, count: 5, hlc }`
4. **One message** (not 5)
5. Peer B's Relay:
   a. Merges clocks
   b. Looks up position: `runOffsetToPosition(index, runId, 6)` → absolute position
   c. Dispatches `DELETE_RANGE` to Peer B's tree
   d. Applies to CM: `applyRemoteDelete(view, position, 5, ...)` — one transaction

### Remote insert that requires splitting

1. Peer A has run "hello" (one run, ID = helloId)
2. Peer B inserts "X" after "hel" — Peer B's message: `INSERT_RUN { node: { text: "X", parentId: helloId }, ... }`
3. Peer A's Relay receives the message:
   a. Detects that the new run's parent is `helloId`, and based on sibling ordering, "X" should appear at offset 3 within the "hello" run
   b. Dispatches `SPLIT(helloId, 3)` → "hel" (keeps helloId) + "lo" (gets `helloId:s:3`)
   c. Dispatches `INSERT_RUN` for "X" (parented to helloId, which is now "hel")
   d. Calculates position: `findInsertPosition(state, helloId, xNodeId)` → 3
   e. Applies to CM: `applyRemoteInsert(view, 3, "X", ...)`
4. Peer A's editor shows "helXlo"

### SPLIT actions are NOT broadcast

SPLITs are a local consequence of receiving a remote INSERT_RUN. Each peer performs its own splits as needed. The wire protocol only carries `INSERT_RUN` and `DELETE_RANGE`.

## Acceptance criteria

- [ ] Two editors render side-by-side, labeled "Peer A" and "Peer B"
- [ ] Typing in Peer A appears in Peer B (and vice versa)
- [ ] Pasting multi-character text in one editor appears in the other via a SINGLE `INSERT_RUN` message
- [ ] Deleting a range in one editor removes it in the other via a SINGLE `DELETE_RANGE` message
- [ ] After any sequence of non-concurrent edits, both editors show identical text
- [ ] After any sequence of non-concurrent edits, `reconstruct(peerA.docState) === reconstruct(peerB.docState)`
- [ ] HLC merge works: after receiving a remote message, the local HLC is ≥ the remote HLC
- [ ] No infinite loops: remote transactions don't trigger re-broadcast
- [ ] Remote insert into the middle of a local run correctly splits and inserts
- [ ] Inspector event log shows run-level messages (not per-character)
- [ ] **Message count verification**: pasting "hello world" produces exactly 1 message in the event log (not 11)

## Build order

1. **Update `src/relay.ts`** — change message types from `InsertMessage`/`DeleteMessage` to `InsertRunMessage`/`DeleteRangeMessage`. Update `handleRemoteMessage`:
   - For `INSERT_RUN`: merge clocks, check idempotency, detect if split is needed, dispatch SPLIT if so, calculate position via `findInsertPosition`, dispatch `INSERT_RUN`, apply to CM via `applyRemoteInsert(view, pos, node.text, ...)`
   - For `DELETE_RANGE`: merge clocks, look up position via `runOffsetToPosition`, dispatch `DELETE_RANGE`, apply to CM via `applyRemoteDelete(view, pos, count, ...)`

2. **Update `applyRemoteInsert` in `src/cm-bridge.ts`** — change signature to accept `text: string` (multi-char) instead of `char: string` (single char). The CM dispatch inserts the full text in one transaction.

3. **Update `applyRemoteDelete` in `src/cm-bridge.ts`** — change signature to accept `count: number`. The CM dispatch deletes `count` chars in one transaction.

4. **Update `src/App.tsx`** — render two `PeerEditor` instances. Wire `localDispatch` to broadcast run-level messages. Wire `remoteDispatch` for the relay. Update `actionToMessage` to produce `InsertRunMessage`/`DeleteRangeMessage`.

5. **Implement split detection in relay** — when an `INSERT_RUN` arrives and the parent run exists locally, determine if the new run's insertion point falls within the parent run's text (not at a boundary). If so, dispatch SPLIT first.

6. **Manual testing** — type in one editor, verify it appears in the other. Paste text, verify one message in the inspector. Delete a range, verify one message.

7. **Write `src/__tests__/relay.test.ts`** — test `handleRemoteMessage` with mock CM view:
   - INSERT_RUN at empty doc → correct position
   - INSERT_RUN requiring split → SPLIT dispatched before INSERT_RUN
   - DELETE_RANGE → correct position and count
   - Idempotency: duplicate INSERT_RUN is a no-op
   - HLC merge: local clock advances after receiving remote message
