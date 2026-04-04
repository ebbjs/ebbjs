# Causal Tree (Run-Length Optimized)

## Purpose

The Causal Tree is the core document model. It stores the collaborative document as a tree of `RunNode`s — contiguous sequences of characters by the same peer — ordered by Hybrid Logical Clocks. It owns all document mutation logic (insert, delete, split) and maintains an incremental `PositionIndex` that maps document positions to runs without requiring a full DFS traversal on every edit.

This is the most significantly changed component in the optimization pass. The current per-character `CharNode` is replaced by `RunNode`, the reducer gains new action types, and the `PositionIndex` replaces the old `buildPositionMap` + `reconstruct` pattern.

## Responsibilities

- Define the `RunNode` type and `DocState` shape (tree + position index)
- Pure reducer handling `INSERT_RUN`, `DELETE_RANGE`, and `SPLIT` actions
- Maintain the `PositionIndex` incrementally inside the reducer (no external rebuild step)
- Provide `reconstruct()` for debugging/consistency checks (not on the hot path)
- Provide `lookupPosition()` and `runOffsetToPosition()` for position resolution
- Deterministic split-ID generation so splits are commutative across peers
- Sibling ordering by descending HLC (same tie-break rule as today)

## Public interface

### Types

```ts
/** A run of consecutive characters by one peer. */
type RunNode = {
  readonly id: string; // HLC-derived ID (from the first character's HLC)
  readonly text: string; // 1+ characters (the run content)
  readonly parentId: string; // ID of the run this was inserted after
  readonly peerId: string; // Which peer authored this run
  readonly deleted: boolean; // Tombstone flag (applies to entire run)
};

/**
 * A span in the position index. Each span covers a contiguous range
 * of document positions belonging to one visible run.
 */
type RunSpan = {
  readonly runId: string; // Which RunNode this span belongs to
  readonly length: number; // Number of visible characters in this span
};

/**
 * Incremental position index. A flat array of RunSpan entries where
 * each entry covers a contiguous range of document positions.
 * Maintained atomically with every tree mutation by the reducer.
 */
type PositionIndex = {
  readonly spans: readonly RunSpan[]; // Ordered list of visible spans
  readonly totalLength: number; // Sum of all span lengths (= doc length)
};

type DocState = {
  readonly nodes: ReadonlyMap<string, RunNode>;
  readonly children: ReadonlyMap<string, readonly string[]>; // parentId → ordered child IDs
  readonly index: PositionIndex;
};

/** Result of looking up a document position in the index. */
type PositionLookup = {
  readonly runId: string; // Which run contains this position
  readonly offset: number; // Offset within the run's text
  readonly spanIndex: number; // Index into PositionIndex.spans (for efficient splicing)
};

type InsertRunAction = {
  readonly type: "INSERT_RUN";
  readonly node: RunNode;
};

type DeleteRangeAction = {
  readonly type: "DELETE_RANGE";
  readonly runId: string;
  readonly offset: number; // Start offset within the run's text
  readonly count: number; // Number of characters to delete
};

/**
 * Split a run at a given offset. The left half keeps the original ID.
 * The right half gets a deterministic split ID.
 */
type SplitAction = {
  readonly type: "SPLIT";
  readonly runId: string;
  readonly offset: number; // Split point within the run's text
};

type DocAction = InsertRunAction | DeleteRangeAction | SplitAction;
```

### Exported functions

| Name                  | Signature                                                                      | Description                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createDocState`      | `() => DocState`                                                               | Create empty document state with ROOT sentinel and empty index                                                                                   |
| `docReducer`          | `(state: DocState, action: DocAction) => DocState`                             | Pure reducer. Handles INSERT_RUN, DELETE_RANGE, SPLIT. Returns new state with updated index.                                                     |
| `reconstruct`         | `(state: DocState) => string`                                                  | DFS traversal producing visible text. For debugging/consistency checks only — not on the hot path.                                               |
| `lookupPosition`      | `(index: PositionIndex, position: number) => PositionLookup`                   | O(spans) lookup: which run contains a given document position.                                                                                   |
| `runOffsetToPosition` | `(index: PositionIndex, runId: string, offset: number) => number \| undefined` | Given a run ID and offset within it, return the absolute document position. O(spans).                                                            |
| `findInsertPosition`  | `(state: DocState, parentId: string, newNodeId: string) => number`             | Determine the document position where a new run should appear, based on sibling ordering. Uses the index instead of DFS + countVisibleInSubtree. |
| `makeSplitId`         | `(originalId: string, offset: number) => string`                               | Deterministic split-ID generation: `originalId + ":s:" + offset`. Pure function.                                                                 |
| `ROOT_ID`             | `"ROOT"`                                                                       | Sentinel root node ID (unchanged).                                                                                                               |

## Dependencies

| Dependency | What it needs                                                                                        | Reference        |
| ---------- | ---------------------------------------------------------------------------------------------------- | ---------------- |
| HLC        | `toString()` for generating run IDs, `compare()` is implicit in string comparison of serialized HLCs | [hlc.md](hlc.md) |

No dependency on CM Bridge, Relay, Presence, or React.

## Internal design notes

### RunNode lifecycle

1. **Creation**: When a user types consecutive characters, the CM Bridge accumulates them and dispatches a single `INSERT_RUN` with the full text. The run gets one HLC ID (the HLC at the start of the typing burst).

2. **Splitting**: When a remote insert targets a position in the middle of an existing run, the reducer first handles a `SPLIT` to break the run into two halves, then the new run is inserted between them. The left half keeps the original ID; the right half gets `makeSplitId(originalId, offset)`.

3. **Appending**: When the same peer continues typing at the end of their own run, the CM Bridge can extend the existing run rather than creating a new one. This is an optimization in the bridge, not the tree — the tree sees an `INSERT_RUN` whose parent is the existing run, and the bridge knows to coalesce.

### Split-ID determinism

The critical invariant: if Peer A and Peer B both need to split the same run at the same offset, they must produce identical split IDs. The scheme `originalId + ":s:" + offset` achieves this because:

- `originalId` is globally unique (HLC-derived)
- `offset` is a property of the insertion point, not the peer performing the split
- The separator `:s:` is unambiguous (HLC IDs use `:` as a separator but never contain `:s:`)

If a run is split multiple times (e.g., at offset 3, then the left half at offset 1), the IDs nest: `originalId:s:3` for the first split, `originalId:s:1` for the second. Order of splits doesn't matter — the same set of splits always produces the same set of run IDs.

### PositionIndex maintenance

The index is a flat array of `RunSpan` entries. Each span says "the next N characters belong to run X." The reducer updates this array atomically with every tree mutation:

- **INSERT_RUN**: Find the span where the new run's parent ends (using sibling ordering to determine exact position among siblings). Splice a new `RunSpan { runId: node.id, length: node.text.length }` into the array at that point. Increment `totalLength`.
- **DELETE_RANGE**: Find the span(s) covering the deleted range. Shrink or remove them. Decrement `totalLength`. For a full-run delete, mark the run as tombstoned and remove its span entirely.
- **SPLIT**: Find the span for the split run. Replace it with two spans: `{ runId: originalId, length: offset }` and `{ runId: splitId, length: originalLength - offset }`. No change to `totalLength`.

### Sibling ordering (unchanged)

Children of a parent are ordered by descending HLC string comparison (higher HLC first). This is the same tie-break rule as the current per-character implementation. The only difference is that the unit is now a run, not a character.

### Complexity improvements

| Operation       | Before (per-char)                              | After (runs)                                |
| --------------- | ---------------------------------------------- | ------------------------------------------- |
| Insert (local)  | O(n) DFS to rebuild position map               | O(spans) to splice into index               |
| Insert (remote) | O(n) DFS for findInsertPosition + O(n) rebuild | O(spans) lookup + O(spans) splice           |
| Delete          | O(n) DFS to find position + O(n) rebuild       | O(spans) lookup + O(1) span shrink/removal  |
| Reconstruct     | O(n) DFS                                       | O(n) DFS (but only for debug, not hot path) |
| Position lookup | O(n) linear scan of ID array                   | O(spans) scan of span array                 |

Where `spans` is typically 10-100x smaller than `n` (the character count).

## Open questions

- **Run extension vs. new run**: When a user types at the end of their own existing run, should the reducer support an `EXTEND_RUN` action that mutates the run's `text` in place (appending characters)? Or should it always create a new single-char run that the bridge coalesces? The former is more efficient but adds a mutation path. The latter is simpler but creates more runs during fast typing. **Suggested approach**: Start with always creating new runs (simpler). Add `EXTEND_RUN` as a follow-up optimization if run count becomes a problem.

- **Tombstone compaction**: Deleted runs accumulate as tombstones. Should the reducer support a `COMPACT` action that merges adjacent tombstoned runs? Not needed for the POC, but worth noting as a future optimization. **Suggested approach**: Skip for now. Tombstoned runs don't appear in the `PositionIndex` spans, so they don't affect lookup performance — only memory.

- **Multi-offset splits**: If two remote inserts land at different offsets within the same run in the same batch, the second split needs to account for the first. The reducer handles this naturally (each action sees the state left by the previous), but the relay must apply them sequentially, not in parallel. **Suggested approach**: Document this as a constraint on the relay — remote ops within a batch must be applied in causal order.

## File

`src/causal-tree.ts` — pure functions, imports only from `./hlc.ts`.
Test file: `src/__tests__/causal-tree.test.ts`
