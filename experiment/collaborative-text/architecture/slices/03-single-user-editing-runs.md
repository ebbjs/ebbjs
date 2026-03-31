# Slice 3: Single-User Editing with Runs

## Goal

A single CodeMirror editor instance where the user can type, paste, and delete text, and the CM Bridge correctly batches these into run-level actions dispatched to the Causal Tree — proving the CM ↔ run-length Causal Tree bidirectional sync works.

## Components involved

| Component | Interface subset used |
|-----------|---------------------|
| [HLC](../components/hlc.md) | `createHlc`, `increment`, `toString` |
| [Causal Tree](../components/causal-tree.md) | `createDocState`, `docReducer`, `reconstruct`, `lookupPosition`, `RunNode`, `RunSpan`, `PositionIndex`, `ROOT_ID` |
| [CM Bridge](../components/cm-bridge.md) | `createBridgeExtension`, `createIdMapField`, `setIdMapEffect`, `BridgeConfig` |
| [Editor App](../components/editor-app.md) | Single `PeerEditor` component (one instance, no relay yet) |

## Flow

### Typing a word

1. User types "hello" — 5 keystrokes in rapid succession
2. Each keystroke produces a CM transaction with `changes: { from: N, insert: "h" }` (etc.)
3. The CM Bridge's updateListener fires for each transaction
4. For the first keystroke ("h" at position 0):
   - Parent is ROOT (position 0, nothing before it)
   - Bridge increments HLC, generates ID, creates `RunNode { id, text: "h", parentId: ROOT_ID, peerId, deleted: false }`
   - Dispatches `INSERT_RUN` to the reducer
5. For subsequent keystrokes ("e" at position 1, "l" at position 2, etc.):
   - Each creates a new single-character `RunNode` parented to the previous run
   - Each dispatches a separate `INSERT_RUN`
6. After all 5 keystrokes: the tree has 5 single-character runs chained together
7. `reconstruct(state)` returns `"hello"`, matches `view.state.doc.toString()`

> **Note**: In this slice, each keystroke creates a separate run. Run coalescing (combining consecutive single-char runs by the same peer into one multi-char run) is a follow-up optimization. The architecture supports it but it's not required for correctness.

### Pasting text

1. User pastes "world" at position 5 (after "hello")
2. CM produces a single transaction with `changes: { from: 5, insert: "world" }`
3. The Bridge sees 5 characters inserted at once
4. Bridge creates ONE `RunNode { text: "world", ... }` — this is the key batching win
5. Dispatches a single `INSERT_RUN` to the reducer
6. Tree now has the "hello" chain + one "world" run
7. `reconstruct(state)` returns `"helloworld"`

### Deleting text

1. User selects "llo" (positions 2-5) and presses Delete
2. CM produces `changes: { from: 2, to: 5 }`
3. Bridge looks up which runs cover positions 2-4:
   - If these are separate single-char runs: dispatches `DELETE_RANGE` for each
   - If these are part of one run: dispatches a single `DELETE_RANGE(runId, offset: 2, count: 3)`
4. Reducer tombstones or shrinks the affected runs, updates index
5. `reconstruct(state)` returns `"heworld"`

### Inserting in the middle of a run

1. State has a run "world" (from a paste)
2. User clicks between "w" and "o" (position 6 if "hello" precedes) and types "X"
3. Bridge detects the insertion is in the middle of the "world" run:
   - `lookupPosition(index, 5)` → `{ runId: worldId, offset: 0, ... }` — "w" is at offset 0
   - Insertion at position 6 means after "w", which is offset 1 within the run
4. Bridge dispatches `SPLIT(worldId, 1)` → "w" (original ID) + "orld" (split ID)
5. Bridge dispatches `INSERT_RUN({ text: "X", parentId: worldId })` — parented to "w"
6. `reconstruct(state)` returns `"helloXworld"` → wait, that's wrong. Let me re-trace...
   - Actually: "w" keeps original ID, "orld" gets split ID. "X" is inserted as a sibling of "orld" under parent "w". By HLC ordering, "X" (newer, higher HLC) comes before "orld" (split ID, derived from older HLC). So: "w" + "X" + "orld" = "wXorld". Full doc: "hellowXorld" ✓

### StateField update

After every local edit:
1. The reducer updates `DocState.index`
2. The bridge dispatches a follow-up CM transaction with `setIdMapEffect.of(getDocState().index.spans)`
3. The StateField now holds the current `RunSpan[]`
4. This is marked as `isRemote` so the updateListener skips it

## Acceptance criteria

- [ ] A single CodeMirror editor renders via Vite dev server
- [ ] Typing characters creates `INSERT_RUN` actions dispatched to the reducer
- [ ] Pasting multi-character text creates a SINGLE `INSERT_RUN` with the full pasted text
- [ ] Deleting characters creates `DELETE_RANGE` actions
- [ ] Inserting in the middle of a run triggers a `SPLIT` followed by `INSERT_RUN`
- [ ] `reconstruct(docState)` always equals `view.state.doc.toString()` after any edit
- [ ] The StateField holds `RunSpan[]` that is consistent with `DocState.index.spans`
- [ ] `index.totalLength` always equals the CM document length
- [ ] HLC advances monotonically: each new run's ID is lexicographically greater than the previous
- [ ] Backspace at position 0 is a no-op (no crash)
- [ ] Empty document: typing the first character works correctly (parent = ROOT)

## Build order

1. **Update `src/cm-bridge.ts`** — change the StateField from `readonly string[]` to `readonly RunSpan[]`. Update `setIdMapEffect` type. Update `createIdMapField`.

2. **Rewrite the updateListener** — instead of creating per-character `CharNode`s:
   - For insertions: create a single `RunNode` with the full inserted text. If inserting mid-run, dispatch `SPLIT` first.
   - For deletions: determine which runs are affected via `lookupPosition`, dispatch `DELETE_RANGE` for each.
   - After processing all changes, dispatch `setIdMapEffect` with the updated spans.

3. **Update `src/App.tsx`** — wire the new `BridgeConfig` with the run-level `localDispatch`. Render a single `PeerEditor` (no relay yet — that's Slice 4).

4. **Manual verification** — open Vite dev server, type in the editor, verify `reconstruct(docState) === view.state.doc.toString()` via the console check.

5. **Test paste behavior** — paste a multi-character string, verify only one `INSERT_RUN` is dispatched (check via inspector or console log).

6. **Test mid-run insertion** — paste "hello", click in the middle, type a character. Verify the split + insert sequence produces the correct document.

7. **Write `src/__tests__/cm-bridge.test.ts`** — test the bridge logic with a minimal CM state. Verify that:
   - A single-char insert produces one `INSERT_RUN`
   - A multi-char paste produces one `INSERT_RUN`
   - A deletion produces `DELETE_RANGE`
   - Mid-run insertion produces `SPLIT` + `INSERT_RUN`
