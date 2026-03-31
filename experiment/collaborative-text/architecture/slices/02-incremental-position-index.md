# Slice 2: Incremental Position Index

## Goal

Position lookups (`lookupPosition`, `runOffsetToPosition`) return correct results after any sequence of INSERT_RUN, SPLIT, and DELETE_RANGE operations — without ever calling `reconstruct` or performing a full DFS traversal — proven through pure unit tests.

## Components involved

| Component | Interface subset used |
|-----------|---------------------|
| [Causal Tree](../components/causal-tree.md) | `DocState`, `PositionIndex`, `RunSpan`, `lookupPosition`, `runOffsetToPosition`, `findInsertPosition`, `docReducer`, `createDocState`, `reconstruct` (as oracle for verification) |

## Flow

### lookupPosition: find which run contains a document position

1. Given `index.spans = [{ runId: "A", length: 5 }, { runId: "B", length: 3 }, { runId: "C", length: 4 }]`
2. `lookupPosition(index, 0)` → `{ runId: "A", offset: 0, spanIndex: 0 }` (first char of run A)
3. `lookupPosition(index, 4)` → `{ runId: "A", offset: 4, spanIndex: 0 }` (last char of run A)
4. `lookupPosition(index, 5)` → `{ runId: "B", offset: 0, spanIndex: 1 }` (first char of run B)
5. `lookupPosition(index, 11)` → `{ runId: "C", offset: 3, spanIndex: 2 }` (last char of run C)

### runOffsetToPosition: resolve a (runId, offset) to absolute position

1. Same spans as above
2. `runOffsetToPosition(index, "A", 0)` → `0`
3. `runOffsetToPosition(index, "B", 2)` → `7` (5 chars in A + 2 offset in B)
4. `runOffsetToPosition(index, "C", 3)` → `11`
5. `runOffsetToPosition(index, "nonexistent", 0)` → `undefined`

### Index consistency after mutations

1. Start with empty state
2. Insert run "hello" → `spans = [{ "hello-id", 5 }]`, `totalLength = 5`
3. Insert run "world" after "hello" → `spans = [{ "hello-id", 5 }, { "world-id", 5 }]`, `totalLength = 10`
4. Split "hello" at offset 3 → `spans = [{ "hello-id", 3 }, { "hello-id:s:3", 2 }, { "world-id", 5 }]`, `totalLength = 10`
5. Delete range in "world" (offset 1, count 3) → `totalLength = 7`
6. At every step: `index.totalLength === reconstruct(state).length`
7. At every step: for every position `p` in `[0, totalLength)`, `lookupPosition` returns a valid `(runId, offset)` that corresponds to the correct character in `reconstruct(state)`

### findInsertPosition uses the index

1. Build a state with runs "abc" (ROOT child, ts=1000) and "xyz" (ROOT child, ts=1002)
2. `reconstruct` = "xyzabc" (higher HLC first)
3. Insert a new run as child of ROOT with ts=1001 (between xyz and abc)
4. `findInsertPosition(state, ROOT_ID, newRunId)` should return 3 (after "xyz", before "abc")
5. This is computed using the index spans, not via DFS + countVisibleInSubtree

## Acceptance criteria

- [ ] `lookupPosition` returns correct `(runId, offset, spanIndex)` for every valid position in a multi-span index
- [ ] `lookupPosition` handles edge cases: position 0, position = totalLength - 1, single-span index, empty index
- [ ] `runOffsetToPosition` returns correct absolute position for every valid `(runId, offset)` pair
- [ ] `runOffsetToPosition` returns `undefined` for nonexistent run IDs
- [ ] After `INSERT_RUN`: new span appears at the correct position in `spans`, `totalLength` incremented by run text length
- [ ] After `SPLIT`: one span replaced by two, `totalLength` unchanged
- [ ] After `DELETE_RANGE` (full run): span removed, `totalLength` decremented
- [ ] After `DELETE_RANGE` (partial): span length reduced, `totalLength` decremented
- [ ] `findInsertPosition` returns the correct document position using the index (verified against `reconstruct` output)
- [ ] **Consistency oracle**: After any sequence of operations, for every position `p` in `[0, totalLength)`, the character at `p` in `reconstruct(state)` matches the character at `lookupPosition(index, p).offset` in the corresponding run's text
- [ ] **No DFS on hot path**: `lookupPosition`, `runOffsetToPosition`, and `findInsertPosition` do NOT call `reconstruct` or perform a full tree traversal (verified by code inspection, not a runtime test)

## Build order

1. **Implement `lookupPosition`** — linear scan of `spans`: accumulate lengths until the target position falls within a span. Return `{ runId, offset: position - accumulated, spanIndex }`. Write tests for all edge cases.

2. **Implement `runOffsetToPosition`** — linear scan of `spans`: find the span with matching `runId`, accumulate lengths of preceding spans, add offset. Write tests.

3. **Verify index maintenance in `docReducer`** — this was partially built in Slice 1 (the reducer updates `index` on every action). Write focused tests that:
   - Insert multiple runs in various orders, check `spans` after each
   - Split a run, check `spans` reflects the split
   - Delete a range, check `spans` reflects the deletion
   - After each operation, run the consistency oracle (compare every position against `reconstruct`)

4. **Rewrite `findInsertPosition`** to use the index instead of `buildPositionMap` + `countVisibleInSubtree`. The approach:
   - Determine the new run's position among its parent's children (same sibling ordering logic as today)
   - Walk the `spans` array to count visible characters in the subtrees of siblings that come before the insertion point
   - This is O(spans) instead of O(n-chars)
   - Write tests comparing against the old DFS-based approach as an oracle

5. **Remove `buildPositionMap`** — it's no longer needed on the hot path. Keep `reconstruct` for debugging only.
