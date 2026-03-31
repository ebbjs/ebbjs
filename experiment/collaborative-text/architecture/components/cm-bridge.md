# CodeMirror Bridge

## Purpose

The bidirectional translation layer between CodeMirror 6's text document model and the Causal Tree. CodeMirror thinks in terms of character positions and text replacements. The Causal Tree thinks in terms of node IDs and parent relationships. The Bridge maintains a `StateField` that maps every character position in the CM document to its corresponding `CharNode.id`, and provides an `updateListener` that intercepts local edits and translates them into Causal Tree actions.

This is the most complex component in the system — it must keep two representations of the same document in sync without creating infinite loops.

## Responsibilities

- Maintain a CM6 `StateField` that stores the node ID for every character position in the document
- Update the ID map when CM transactions occur (local or remote), shifting IDs correctly via `ChangeSet` mapping
- Intercept local user edits via an `updateListener` and translate them into `INSERT` / `DELETE` actions for the Causal Tree reducer
- Provide a function to apply remote Causal Tree operations as CM transactions (insert/delete text at the correct position)
- Expose the current position ↔ ID mapping so Presence can resolve cursor positions

## Public interface

### Exported functions / extensions

| Name | Signature | Description |
|------|-----------|-------------|
| `createIdMapField` | `() => StateField<readonly string[]>` | Creates the CM6 StateField that holds an array of node IDs parallel to the document text. Index `i` in the array = node ID of the character at document position `i`. |
| `createBridgeExtension` | `(config: BridgeConfig) => Extension` | Returns a CM6 Extension (bundles the StateField + updateListener). The `config` provides callbacks for dispatching Causal Tree actions and reading the current HLC. |
| `applyRemoteInsert` | `(view: EditorView, position: number, char: string, nodeId: string) => void` | Dispatch a CM transaction that inserts `char` at `position` and updates the ID map StateField accordingly. Marks the transaction as "remote" via an annotation so the updateListener ignores it. |
| `applyRemoteDelete` | `(view: EditorView, position: number) => void` | Dispatch a CM transaction that deletes the character at `position`. Marks as "remote" via annotation. |
| `getIdAtPosition` | `(state: EditorState, position: number) => string \| undefined` | Read the node ID at a given document position from the StateField. Used by Presence for cursor tracking. |
| `getPositionOfId` | `(state: EditorState, nodeId: string) => number \| undefined` | Find the document position of a given node ID. Linear scan of the StateField array. Used by Presence for rendering remote cursors. |

### Types

```ts
type BridgeConfig = {
  readonly peerId: string
  readonly getHlc: () => Hlc
  readonly setHlc: (hlc: Hlc) => void
  readonly dispatch: (action: DocAction) => void  // Dispatch to Causal Tree reducer
  readonly getDocState: () => DocState             // Read current Causal Tree state
}

// Annotation to mark transactions as remote (so updateListener skips them)
// This is a CM6 Annotation<boolean>, not a type we export — but it's part of the contract.
```

## Dependencies

| Dependency | What it needs | Reference |
|------------|---------------|-----------|
| HLC | `increment`, `toString`, `Hlc` type | [hlc.md](hlc.md#exported-functions) |
| Causal Tree | `DocAction`, `InsertAction`, `DeleteAction`, `DocState`, `findInsertPosition`, `buildPositionMap` | [causal-tree.md](causal-tree.md#exported-functions) |
| CodeMirror 6 | `StateField`, `EditorView`, `EditorState`, `Extension`, `Annotation`, `Transaction` | External dependency (`@codemirror/state`, `@codemirror/view`) |

## Internal design notes

### The ID map StateField

The StateField holds a `string[]` where `idMap[i]` is the `CharNode.id` of the character at document position `i`. This array is the same length as the document.

**On local transactions:** The updateListener fires. For each `ChangeSet` in the transaction:
- For insertions: the listener reads the parent ID from `idMap[insertPos - 1]` (or ROOT if inserting at position 0), increments the HLC, creates a new `CharNode`, dispatches an INSERT action to the reducer, and splices the new node ID into the local copy of the ID map.
- For deletions: the listener reads the node ID from `idMap[deletePos]`, dispatches a DELETE action to the reducer, and removes the entry from the ID map.

**On remote transactions (annotated):** The updateListener skips them. The ID map is updated by the `applyRemoteInsert` / `applyRemoteDelete` functions which directly manipulate the StateField via transaction effects or by rebuilding from the Causal Tree's `buildPositionMap`.

### Avoiding infinite loops

The critical invariant: **local edits flow outward** (CM → Bridge → Causal Tree → Relay), and **remote edits flow inward** (Relay → Causal Tree → Bridge → CM). The `isRemote` annotation on transactions tells the updateListener to ignore remote changes, breaking the loop.

### StateField update strategy

Two approaches are viable:

**Option A: Incremental updates.** The StateField's `update` method maps the existing ID array through `tr.changes` (shifting positions) and splices in new IDs for insertions. This is efficient but complex — it must handle multi-cursor edits, batch replacements, etc.

**Option B: Rebuild from Causal Tree.** On every transaction, rebuild the ID array from `buildPositionMap(docState)`. Simpler but O(n) on every keystroke. For a prototype with small documents, this is acceptable.

**Recommendation:** Start with Option B (rebuild) for simplicity. If performance is noticeable, switch to Option A. Flag this in the implementation.

### Parent ID resolution for insertions

When the user types a character at position `p`:
- If `p === 0`, the parent is ROOT
- Otherwise, the parent is `idMap[p - 1]`

This works because in the Causal Tree, "insert after X" means "X is the parent." The character at position `p - 1` in the document is the node we're inserting after.

## Open questions

- **`RangeSet` vs. plain array for the StateField:** The PLAN.md suggests `RangeSet<string>`. However, `RangeSet` is designed for sparse decorations, not dense per-character metadata. A plain `string[]` (or `readonly string[]`) stored in a `StateField` is simpler and more natural for this use case. The architecture assumes a plain array. If there's a strong reason to use `RangeSet` (e.g., built-in change mapping), the implementer can revisit.
- **Multi-character paste / batch edits:** When the user pastes multiple characters, CM6 fires a single transaction with a multi-character insertion. The Bridge must handle this by creating multiple `CharNode`s in sequence, each parented to the previous one. The updateListener needs to iterate over the inserted text character by character.
- **Undo/redo:** Not in scope for this experiment. CM6's built-in undo will conflict with the Causal Tree model. Disable CM6's undo keybindings or accept that undo may produce inconsistent state.

## File

`src/cm-bridge.ts` — imports from `./hlc.ts`, `./causal-tree.ts`, and `@codemirror/*`.
Test file: `src/__tests__/cm-bridge.test.ts`
