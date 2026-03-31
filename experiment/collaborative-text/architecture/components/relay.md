# Relay (Mock Network)

## Purpose

Simulates a network layer between two editor instances using the browser's `BroadcastChannel` API. When a local editor produces an INSERT or DELETE operation, the Relay broadcasts it. When a remote operation arrives, the Relay applies it to the local Causal Tree (via the reducer), merges the remote HLC, calculates the correct document position, and dispatches a CM transaction to insert/delete the text in the local CodeMirror view.

The Relay is the integration hub — it's the only component that touches HLC, Causal Tree, and CM Bridge together.

## Responsibilities

- Broadcast local Causal Tree operations (INSERT, DELETE) and presence updates to remote peers via `BroadcastChannel`
- Receive remote operations and apply them to the local state:
  1. Merge the remote HLC into the local HLC
  2. Dispatch the operation to the local Causal Tree reducer
  3. Calculate the resulting document position
  4. Apply the text change to the local CodeMirror view via the CM Bridge
- Receive remote presence updates and forward them to the Presence module
- Provide a React hook interface for easy integration with the Editor App

## Public interface

### Exported functions

| Name | Signature | Description |
|------|-----------|-------------|
| `useRelay` | `(config: RelayConfig) => RelayHandle` | React hook that sets up a `BroadcastChannel`, listens for remote messages, and provides a `broadcast` function for sending local operations |

### Types

```ts
type RelayConfig = {
  readonly channelName: string                          // BroadcastChannel name (same for both peers)
  readonly peerId: string                               // This peer's ID (to ignore own messages)
  readonly hlcRef: React.MutableRefObject<Hlc>          // Mutable ref to the local HLC
  readonly dispatch: (action: DocAction) => void        // Dispatch to Causal Tree reducer
  readonly getDocState: () => DocState                  // Read current Causal Tree state
  readonly viewRef: React.MutableRefObject<EditorView | null>  // Ref to the CM EditorView
  readonly updatePresence: (peerId: string, anchorId: string, headId: string) => void
}

type RelayHandle = {
  readonly broadcast: (message: RelayMessage) => void   // Send a message to remote peers
}

// Messages sent over BroadcastChannel
type InsertMessage = {
  readonly type: "INSERT"
  readonly peerId: string
  readonly node: CharNode       // The full CharNode to insert
  readonly hlc: Hlc             // Sender's HLC at time of send (for clock merge)
}

type DeleteMessage = {
  readonly type: "DELETE"
  readonly peerId: string
  readonly nodeId: string       // ID of the node to delete
  readonly hlc: Hlc
}

type PresenceMessage = {
  readonly type: "PRESENCE"
  readonly peerId: string
  readonly anchorId: string
  readonly headId: string
}

type RelayMessage = InsertMessage | DeleteMessage | PresenceMessage
```

## Dependencies

| Dependency | What it needs | Reference |
|------------|---------------|-----------|
| HLC | `receive` (merge remote clock), `Hlc` type | [hlc.md](hlc.md#exported-functions) |
| Causal Tree | `DocAction`, `DocState`, `findInsertPosition`, `CharNode` type | [causal-tree.md](causal-tree.md#exported-functions) |
| CM Bridge | `applyRemoteInsert`, `applyRemoteDelete` | [cm-bridge.md](cm-bridge.md#exported-functions--extensions) |
| Presence | `updatePresence` callback (passed through config) | [presence.md](presence.md#exported-functions--extensions) |
| BroadcastChannel | Browser API | Built-in |

## Internal design notes

### Message flow: local edit → broadcast

1. User types in CM → CM Bridge's updateListener fires → dispatches INSERT action to Causal Tree reducer
2. After dispatching to the reducer, the Editor App (or Bridge callback) calls `relay.broadcast({ type: "INSERT", peerId, node, hlc })`
3. The Relay posts the message to the `BroadcastChannel`

### Message flow: receive remote → apply locally

1. `BroadcastChannel.onmessage` fires with a remote message
2. Relay checks `message.peerId !== config.peerId` (ignore own echoes)
3. For INSERT:
   a. Call `receive(localHlc, message.hlc)` to merge clocks → update `hlcRef.current`
   b. Call `dispatch({ type: "INSERT", node: message.node })` to add to Causal Tree
   c. Call `findInsertPosition(getDocState(), message.node.parentId, message.node.id)` to get the visible position
   d. Call `applyRemoteInsert(viewRef.current, position, message.node.value, message.node.id)` to update CM
4. For DELETE:
   a. Merge clocks
   b. Look up the node's current position via `buildPositionMap(getDocState())` **before** dispatching the delete
   c. Call `dispatch({ type: "DELETE", nodeId: message.nodeId })`
   d. Call `applyRemoteDelete(viewRef.current, position)` to update CM
5. For PRESENCE:
   a. Call `updatePresence(message.peerId, message.anchorId, message.headId)`

### Ordering concern

The Relay must update the Causal Tree **before** (for inserts) or **look up position before** (for deletes) applying to CM. The sequence matters:
- INSERT: dispatch to tree first (so `findInsertPosition` can see the new node's siblings), then apply to CM
- DELETE: look up position first (while the node is still visible), then dispatch to tree, then apply to CM

### Hook lifecycle

The `useRelay` hook:
- Creates the `BroadcastChannel` in a `useEffect`
- Attaches the `onmessage` handler
- Returns the `broadcast` function (stable ref via `useCallback`)
- Closes the channel on cleanup

### BroadcastChannel serialization

`BroadcastChannel.postMessage` uses the structured clone algorithm, so plain objects with strings and numbers are fine. No need for JSON serialization.

## Open questions

- **Operation ordering guarantees:** `BroadcastChannel` delivers messages in order within a single channel, but there's no guarantee about timing relative to local state. For two editors in the same tab, messages arrive synchronously (or nearly so). This is fine for the prototype. A real network would need operation buffering.
- **Batching:** If the user pastes 100 characters, that's 100 INSERT messages. For the prototype this is fine. A real system would batch operations.
- **Should the Relay own the HLC ref, or should the Editor App?** The architecture puts the HLC ref in the Editor App and passes it to both the Relay and the CM Bridge. This avoids the Relay needing to "own" state that the Bridge also needs. The Editor App is the single owner; Relay and Bridge both read/write through the ref.

## File

`src/relay.ts` — imports from `./hlc.ts`, `./causal-tree.ts`, `./cm-bridge.ts`.
Test file: `src/__tests__/relay.test.ts` (test message handling logic with mock BroadcastChannel)
