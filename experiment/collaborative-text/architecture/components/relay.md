# Relay (Batched Wire Protocol)

## Purpose

Simulates a network layer between editor instances using the browser's `BroadcastChannel` API. When a local editor produces an INSERT_RUN or DELETE_RANGE operation, the Relay broadcasts it. When a remote operation arrives, the Relay applies it to the local Causal Tree (via the reducer), merges the remote HLC, calculates the correct document position, and dispatches a CM transaction to insert/delete the text in the local CodeMirror view.

The key optimization: the relay now speaks in run-level messages (`INSERT_RUN`, `DELETE_RANGE`) instead of per-character messages, dramatically reducing channel traffic and remote-side processing.

## Responsibilities

- Define the wire message types: `InsertRunMessage`, `DeleteRangeMessage`, `PresenceMessage`
- Broadcast local operations as run-level messages
- Receive remote messages, merge HLCs, and apply them to the local Causal Tree + CM view
- Handle run splitting when a remote insert targets the middle of a local run
- Maintain message ordering within a single peer's stream (BroadcastChannel guarantees this)

## Public interface

### Types

```ts
type InsertRunMessage = {
  readonly type: "INSERT_RUN";
  readonly peerId: string;
  readonly node: RunNode; // The full run being inserted
  readonly hlc: Hlc; // Sender's HLC at time of send
};

type DeleteRangeMessage = {
  readonly type: "DELETE_RANGE";
  readonly peerId: string;
  readonly runId: string;
  readonly offset: number;
  readonly count: number;
  readonly hlc: Hlc;
};

type PresenceMessage = {
  readonly type: "PRESENCE";
  readonly peerId: string;
  readonly anchorRunId: string;
  readonly anchorOffset: number;
  readonly headRunId: string;
  readonly headOffset: number;
};

type RelayMessage = InsertRunMessage | DeleteRangeMessage | PresenceMessage;

type RelayConfig = {
  readonly channelName: string;
  readonly peerId: string;
  readonly hlcRef: React.RefObject<Hlc>;
  readonly dispatch: (action: DocAction) => void;
  readonly getDocState: () => DocState;
  readonly viewRef: React.RefObject<EditorView | null>;
  readonly idMapField: StateField<readonly RunSpan[]>;
  readonly updatePresence?: (
    peerId: string,
    anchorRunId: string,
    anchorOffset: number,
    headRunId: string,
    headOffset: number,
  ) => void;
  readonly onRemoteMessage?: (message: RelayMessage) => void;
};

type RelayHandle = {
  readonly broadcast: (message: RelayMessage) => void;
};
```

### Exported functions

| Name                  | Signature                                              | Description                                                                                                        |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `handleRemoteMessage` | `(message: RelayMessage, config: RelayConfig) => void` | Core message handler. Extracted from the hook for testability. Merges HLC, dispatches to tree, applies to CM view. |
| `useRelay`            | `(config: RelayConfig) => RelayHandle`                 | React hook that sets up BroadcastChannel, listens for remote messages, provides `broadcast`.                       |

## Dependencies

| Dependency  | What it needs                                                                                                    | Reference                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| HLC         | `receive()` for clock merge                                                                                      | [hlc.md](hlc.md)                 |
| Causal Tree | `DocAction`, `DocState`, `RunNode`, `findInsertPosition`, `lookupPosition`, `runOffsetToPosition`, `makeSplitId` | [causal-tree.md](causal-tree.md) |
| CM Bridge   | `applyRemoteInsert`, `applyRemoteDelete`, `isRemote`, `setIdMapEffect`                                           | [cm-bridge.md](cm-bridge.md)     |
| Presence    | `presenceUpdateEffect` (to poke CM view on presence changes)                                                     | [presence.md](presence.md)       |

## Internal design notes

### Remote INSERT_RUN handling

```
Pseudocode for handleRemoteMessage(INSERT_RUN):
  1. Merge clocks: hlcRef.current = receive(hlcRef.current, message.hlc)
  2. Idempotency guard: if node.id already exists in tree, skip
  3. Check if the new run needs to split an existing run:
     - The new run's parentId points to an existing run
     - Based on sibling ordering, the new run should appear between
       characters of an existing run (i.e., the parent run has a child
       whose subtree occupies positions that the new run should precede)
     - If so, dispatch SPLIT on the affected run first
  4. Calculate visible position: findInsertPosition(state, parentId, node.id)
  5. Dispatch INSERT_RUN to local Causal Tree
  6. Apply to CM view: applyRemoteInsert(view, position, node.text, ...)
```

The key difference from the current implementation: step 6 inserts the entire run's text in one CM transaction, not character by character.

### Remote DELETE_RANGE handling

```
Pseudocode for handleRemoteMessage(DELETE_RANGE):
  1. Merge clocks
  2. Look up the run's current position: runOffsetToPosition(index, runId, offset)
  3. Dispatch DELETE_RANGE to local Causal Tree
  4. Apply to CM view: applyRemoteDelete(view, position, count, ...)
```

### Run splitting on remote insert

When Peer A has a run "hello" and Peer B inserts "X" after "hel" (the new run's parent is the run containing "hello", and sibling ordering places it at offset 3), the relay on Peer A's side must:

1. Recognize that the insert targets the middle of run "hello"
2. Dispatch `SPLIT("hello-run-id", 3)` → produces "hel" (original ID) + "lo" (split ID `hello-run-id:s:3`)
3. Dispatch `INSERT_RUN({ text: "X", parentId: "hello-run-id" })` — parented to the left half
4. Apply to CM: insert "X" at the correct position

The split detection happens in `handleRemoteMessage` by examining where the new run's insertion point falls relative to existing runs.

### Presence messages

Presence now tracks cursor position as `(runId, offset)` pairs instead of bare node IDs. This is more stable across edits — if a run gets extended, the cursor's `(runId, offset)` still resolves correctly without needing to update the presence data.

### Message size comparison

| Scenario                | Before (per-char)    | After (runs)           |
| ----------------------- | -------------------- | ---------------------- |
| Type "hello world"      | 11 INSERT messages   | 1 INSERT_RUN message   |
| Paste 1000 chars        | 1000 INSERT messages | 1 INSERT_RUN message   |
| Delete a word (5 chars) | 5 DELETE messages    | 1 DELETE_RANGE message |

## Open questions

- **Split before or during INSERT_RUN?** Should the relay dispatch SPLIT as a separate action before INSERT_RUN, or should the Causal Tree reducer handle splitting internally when it detects an INSERT_RUN that targets the middle of a run? **Suggested approach**: The relay dispatches SPLIT explicitly. This keeps the reducer simpler (each action does one thing) and makes the split visible in the inspector/event log.

- **Batching multiple remote ops**: If multiple remote messages arrive in quick succession (e.g., the remote peer pasted a large block that was split into multiple runs), should the relay batch them into a single CM transaction? **Suggested approach**: Not for the POC. Each message gets its own CM dispatch. The big win is already captured by runs being multi-character.

## File

`src/relay.ts` — imports from `./hlc.ts`, `./causal-tree.ts`, `./cm-bridge.ts`.
Test file: `src/__tests__/relay.test.ts`
