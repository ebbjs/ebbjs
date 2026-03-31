# CodeMirror Bridge (Run-Optimized)

## Purpose

The bidirectional translation layer between CodeMirror 6's text document model and the run-length Causal Tree. It intercepts local edits from CM, batches consecutive character inserts into run-level actions, dispatches them to the Causal Tree reducer, and applies remote run operations back to the CM view as single transactions. It also maintains a CM `StateField` that mirrors the `PositionIndex` spans for use by Presence and other consumers.

The key change from the current implementation: instead of rebuilding the entire ID map via `buildPositionMap()` on every keystroke, the bridge reads the `PositionIndex` maintained incrementally by the Causal Tree reducer.

## Responsibilities

- Maintain a CM6 `StateField` holding the current span array (mirrors `PositionIndex.spans`)
- Intercept local CM edits via `EditorView.updateListener` and translate them into `INSERT_RUN` / `DELETE_RANGE` / `SPLIT` actions
- Batch consecutive local character inserts into a single run before dispatching
- Apply remote run operations to the CM view as single transactions (one `view.dispatch` per run, not per character)
- Mark remote transactions with an `isRemote` annotation so the update listener skips them
- Provide position-to-run helpers for Presence

## Public interface

### Types

```ts
type BridgeConfig = {
  readonly peerId: string
  readonly getHlc: () => Hlc
  readonly setHlc: (hlc: Hlc) => void
  readonly dispatch: (action: DocAction) => void
  readonly getDocState: () => DocState
}
```

### Exported functions / values

| Name | Signature | Description |
|------|-----------|-------------|
| `createIdMapField` | `() => StateField<readonly RunSpan[]>` | Creates the CM6 StateField holding the current span array (mirrors `PositionIndex.spans`). |
| `setIdMapEffect` | `StateEffect<readonly RunSpan[]>` | Effect to replace the span array in the StateField. |
| `isRemote` | `Annotation<boolean>` | Annotation marking a transaction as remote (unchanged). |
| `createBridgeExtension` | `(config: BridgeConfig, idMapField: StateField<...>) => Extension` | Returns the CM6 Extension bundle: StateField + updateListener. |
| `applyRemoteInsert` | `(view, position, text, runId, idMapField, getDocState) => void` | Dispatch a CM transaction inserting a run's full text at a position. Marks as remote. Updates span field. |
| `applyRemoteDelete` | `(view, from, count, idMapField, getDocState) => void` | Dispatch a CM transaction deleting `count` chars starting at `from`. Marks as remote. Updates span field. |
| `getRunAtPosition` | `(state, position, idMapField) => PositionLookup \| undefined` | Read the run ID + offset at a given document position from the StateField. |
| `getPositionOfRun` | `(state, runId, offset, idMapField) => number \| undefined` | Find the document position of a given run ID + offset. |

## Dependencies

| Dependency | What it needs | Reference |
|------------|---------------|-----------|
| Causal Tree | `RunNode`, `DocState`, `PositionIndex`, `RunSpan`, `lookupPosition`, `runOffsetToPosition`, `findInsertPosition`, `makeSplitId`, `ROOT_ID`, `DocAction` | [causal-tree.md](causal-tree.md) |
| HLC | `increment`, `toString` (for generating IDs on local inserts) | [hlc.md](hlc.md) |
| `@codemirror/state` | `StateField`, `StateEffect`, `Annotation`, `Extension`, `Transaction` | External |
| `@codemirror/view` | `EditorView` | External |

## Internal design notes

### Local edit batching

The current bridge processes each character insert individually inside `tr.changes.iterChanges()`. The optimized bridge treats each CM change spec as a single run:

```
Pseudocode:
  on CM transaction with doc changes:
    for each change spec (fromA, toA, inserted):
      // Read current spans from StateField to resolve positions
      spans = tr.startState.field(idMapField)

      if toA > fromA:
        // Deletions: find which run(s) are affected via lookupPosition
        // For each affected run:
        //   dispatch DELETE_RANGE(runId, offset, count)

      if inserted.length > 0:
        // Insertion: create a single RunNode for the entire inserted text
        hlc = increment(getHlc())
        setHlc(hlc)
        id = toString(hlc)

        // Determine parent: the run at (fromA - 1), or ROOT if fromA === 0
        // If inserting in the middle of a run, dispatch SPLIT first
        parentLookup = lookupPosition(index, fromA - 1)  // or ROOT
        if parentLookup is mid-run:
          dispatch SPLIT(parentLookup.runId, parentLookup.offset + 1)
          parentId = parentLookup.runId  // left half keeps original ID

        dispatch INSERT_RUN({ id, text: inserted, parentId, peerId, deleted: false })

    // After all changes processed, update the StateField from the tree's index
    view.dispatch({
      effects: setIdMapEffect.of(getDocState().index.spans),
      annotations: isRemote.of(true),
    })
```

This means a paste of 1000 characters produces 1 `INSERT_RUN` action, not 1000 `INSERT` actions.

### Handling insertions in the middle of a run

When the user clicks in the middle of a word and types, the inserted text lands inside an existing run. The bridge must:

1. Look up which run contains position `fromA` via `lookupPosition` → `(runId, offset)`
2. If `offset > 0 && offset < run.text.length`, dispatch `SPLIT(runId, offset)` first
3. Then dispatch `INSERT_RUN` with `parentId` = the left half's ID

The split is dispatched to the Causal Tree reducer, which handles it atomically with the index update.

### StateField: spans instead of per-char IDs

The current `StateField<readonly string[]>` holds one string ID per character position. The optimized version holds `readonly RunSpan[]` — a much smaller array. Position resolution walks the spans array, which is typically 10-100x smaller than the character count.

The StateField is updated via `setIdMapEffect` after every tree mutation, but now the data comes directly from `DocState.index.spans` (already maintained by the reducer) rather than being rebuilt via DFS.

### Remote operation application

Remote inserts and deletes are applied as single CM transactions:

```
applyRemoteInsert(view, position, "hello world", runId, ...):
  → view.dispatch({
      changes: { from: position, insert: "hello world" },
      effects: setIdMapEffect.of(getDocState().index.spans),
      annotations: isRemote.of(true),
    })
```

One dispatch per run, not per character. This is the main performance win for remote operations.

## Open questions

- **Run extension**: When the local user types at the end of their own run, should the bridge dispatch a new `INSERT_RUN` or try to extend the existing run? Extending is more efficient but requires the bridge to track "is the cursor at the end of the last run I created?" state. **Suggested approach**: Start with always creating new runs. The Causal Tree handles this correctly; the only cost is more spans in the index. Optimize later if needed.

- **Multi-change transactions**: CM6 can produce transactions with multiple change specs (e.g., find-and-replace). Each change spec should be processed independently. The current code already handles this via `iterChanges`; the optimized version should preserve that pattern but produce run-level actions.

## File

`src/cm-bridge.ts` — imports from `./hlc.ts`, `./causal-tree.ts`, and `@codemirror/*`.
Test file: `src/__tests__/cm-bridge.test.ts`
