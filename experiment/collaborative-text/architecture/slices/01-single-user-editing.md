# Slice 1: Single-User Local Editing

## Goal

A single CodeMirror editor instance where the user can type text, and every keystroke is correctly tracked in the Causal Tree data structure — proving the bidirectional sync between CodeMirror's document model and the Causal Tree works.

## Components involved

| Component | Interface subset used |
|-----------|---------------------|
| [HLC](../components/hlc.md) | `createHlc`, `increment`, `toString` |
| [Causal Tree](../components/causal-tree.md) | `createDocState`, `docReducer`, `InsertAction`, `DeleteAction`, `buildPositionMap` |
| [CM Bridge](../components/cm-bridge.md) | `createBridgeExtension`, `BridgeConfig`, `createIdMapField` |
| [Editor App](../components/editor-app.md) | Single `PeerEditor` component (only one instance, no split pane yet) |

## Flow

### Inserting a character

1. User types character `"a"` at position 3 in the CodeMirror editor
2. CM6 creates a transaction with `changes: { from: 3, insert: "a" }`
3. The CM Bridge's `updateListener` fires and detects `tr.docChanged`
4. The listener reads `idMap[2]` (position 3 - 1) to find the parent node ID. If position is 0, parent is `"ROOT"`.
5. The listener calls `increment(hlcRef.current)` to get a new HLC, updates `hlcRef.current`
6. The listener calls `toString(newHlc)` to generate the new node's ID
7. The listener creates a `CharNode: { id, value: "a", parentId, deleted: false }`
8. The listener calls `config.dispatch({ type: "INSERT", node })` which updates the Causal Tree via `docReducer`
9. The ID map StateField is updated: the new node ID is spliced into position 3
10. The CM document now shows the character, and the Causal Tree has the corresponding node

### Deleting a character

1. User presses Backspace at position 3 (deleting the character at position 2)
2. CM6 creates a transaction with `changes: { from: 2, to: 3 }`
3. The CM Bridge's `updateListener` fires
4. The listener reads `idMap[2]` to find the node ID being deleted
5. The listener calls `config.dispatch({ type: "DELETE", nodeId })` which sets `deleted: true` on the node in the Causal Tree
6. The ID map StateField is updated: the entry at position 2 is removed
7. The CM document shows the character removed, and the Causal Tree has the node marked as deleted (tombstoned)

### Verifying consistency

At any point, calling `reconstruct(docState)` should produce a string identical to `view.state.doc.toString()`. This is the fundamental invariant of this slice.

## Acceptance criteria

- [ ] A single CodeMirror editor renders in the browser via Vite dev server
- [ ] Typing characters inserts them into both the CM document and the Causal Tree
- [ ] Deleting characters (Backspace, Delete, selection-delete) marks them as deleted in the Causal Tree and removes them from the CM document
- [ ] `reconstruct(docState)` always equals `view.state.doc.toString()` after any edit
- [ ] The ID map StateField has exactly as many entries as the document has characters
- [ ] Multi-character paste works: pasting "hello" creates 5 CharNodes, each parented to the previous
- [ ] HLC advances monotonically: each new node's ID is lexicographically greater than the previous
- [ ] Unit tests pass for HLC (`increment` produces monotonically increasing values, `compare` orders correctly, `toString` is lexicographically sortable)
- [ ] Unit tests pass for Causal Tree (`docReducer` handles INSERT/DELETE correctly, `reconstruct` produces correct strings, `buildPositionMap` is consistent with `reconstruct`)

## Build order

1. **Implement `src/hlc.ts`** — pure functions, no dependencies. Write `src/__tests__/hlc.test.ts` testing: creation, increment monotonicity, compare ordering, toString sortability.

2. **Implement `src/causal-tree.ts`** — pure functions, depends only on `hlc.ts`. Write `src/__tests__/causal-tree.test.ts` testing:
   - Insert a sequence of characters → reconstruct produces the expected string
   - Delete a character → reconstruct omits it
   - Insert at different positions (beginning, middle, end) → correct tree structure
   - `buildPositionMap` is consistent with `reconstruct`
   - `findInsertPosition` returns correct index for various parent/sibling configurations

3. **Set up project scaffolding** — `package.json` (with react, react-dom, codemirror deps, tailwindcss, vite, vitest), `vite.config.ts` (dev server mode with `@vitejs/plugin-react`), `tsconfig.json`, `index.html`, `src/main.tsx`.

4. **Implement `src/cm-bridge.ts`** — the StateField and updateListener. Start with the "rebuild from Causal Tree" strategy (Option B from the component doc) for simplicity.

5. **Implement `src/App.tsx`** — render a single `PeerEditor` with one CM instance. Wire up `useReducer`, HLC ref, and the Bridge extension.

6. **Manual verification** — open the Vite dev server, type in the editor, add a `console.log` that prints `reconstruct(docState)` vs `view.state.doc.toString()` on every edit to verify they match.

7. **Write `src/__tests__/cm-bridge.test.ts`** — test the Bridge's ID map update logic in isolation (create a minimal CM state, apply changes, verify the ID map). This may require `jsdom`/`happy-dom` for the CM view.
