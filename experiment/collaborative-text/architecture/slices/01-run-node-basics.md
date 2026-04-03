# Slice 1: RunNode Basics

## Goal

A `RunNode`-based causal tree where inserting runs, splitting runs, deleting ranges, and reconstructing the document all produce correct results — proven entirely through pure unit tests with no CM, no React, no relay.

## Components involved

| Component                                   | Interface subset used                                                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [HLC](../components/hlc.md)                 | `toString` (for generating run IDs in test helpers)                                                                                                   |
| [Causal Tree](../components/causal-tree.md) | `RunNode`, `DocState`, `createDocState`, `docReducer`, `reconstruct`, `makeSplitId`, `ROOT_ID`, `InsertRunAction`, `DeleteRangeAction`, `SplitAction` |

## Flow

### Inserting a run

1. Start with an empty `DocState` (only ROOT)
2. Create a `RunNode { id: "1000:00000:peer-A", text: "hello", parentId: "ROOT", peerId: "peer-A", deleted: false }`
3. Dispatch `{ type: "INSERT_RUN", node }` to `docReducer`
4. New state has the run in `nodes`, ROOT's children list contains the run's ID, and `index.spans` has one entry `{ runId: "...", length: 5 }`
5. `reconstruct(state)` returns `"hello"`

### Inserting sequential runs

1. Start with state containing run "hello" (parented to ROOT)
2. Insert run "world" parented to the "hello" run
3. `reconstruct(state)` returns `"helloworld"`
4. `index.spans` has two entries: `[{ runId: helloId, length: 5 }, { runId: worldId, length: 5 }]`

### Splitting a run

1. Start with state containing run "hello" (5 chars)
2. Dispatch `{ type: "SPLIT", runId: helloId, offset: 3 }`
3. State now has two runs: `"hel"` (original ID) and `"lo"` (split ID = `makeSplitId(helloId, 3)`)
4. `"lo"` is a child of `"hel"` in the tree
5. `reconstruct(state)` still returns `"hello"` — splitting doesn't change visible text
6. `index.spans` has two entries: `[{ runId: helloId, length: 3 }, { runId: splitId, length: 2 }]`

### Deleting a range within a run

1. Start with state containing run "hello"
2. Dispatch `{ type: "DELETE_RANGE", runId: helloId, offset: 1, count: 3 }` — delete "ell"
3. The run's text is effectively `"ho"` (or the run is split into visible portions — implementation detail)
4. `reconstruct(state)` returns `"ho"`
5. `index.totalLength` is 2

### Deleting an entire run

1. Start with state containing run "hello"
2. Dispatch `{ type: "DELETE_RANGE", runId: helloId, offset: 0, count: 5 }`
3. The run is tombstoned (`deleted: true`)
4. `reconstruct(state)` returns `""`
5. `index.spans` is empty, `index.totalLength` is 0

### Sibling ordering with runs

1. Insert run "abc" as child of ROOT (HLC ts=1000)
2. Insert run "xyz" as child of ROOT (HLC ts=1002, higher)
3. `reconstruct(state)` returns `"xyzabc"` — higher HLC first among siblings

## Acceptance criteria

- [ ] `createDocState()` produces a state with only ROOT, empty index
- [ ] Inserting a single run: `reconstruct` returns the run's text, `index.spans` has one entry with correct length
- [ ] Inserting sequential runs (each parented to the previous): `reconstruct` returns concatenated text in order
- [ ] Inserting sibling runs (same parent, different HLCs): ordered by descending HLC
- [ ] `SPLIT` at offset N: left half keeps original ID with text `[0..N)`, right half gets `makeSplitId(id, N)` with text `[N..)`, `reconstruct` unchanged
- [ ] `SPLIT` then `INSERT_RUN` between halves: new run appears at the split point in `reconstruct`
- [ ] `DELETE_RANGE` partial: removes characters from the middle of a run, `reconstruct` reflects deletion
- [ ] `DELETE_RANGE` full: tombstones the run, `reconstruct` omits it, `index.spans` removes the entry
- [ ] Idempotency: inserting the same run twice is a no-op (same as current `CharNode` behavior)
- [ ] `makeSplitId` is deterministic: same inputs always produce the same output
- [ ] `index.totalLength` always equals `reconstruct(state).length`

## Build order

1. **Define types** in `src/causal-tree.ts`: `RunNode`, `RunSpan`, `PositionIndex`, `DocState`, action types. Remove or alias the old `CharNode` type.

2. **Implement `makeSplitId`** — trivial pure function: `(id, offset) => id + ":s:" + offset`. Write a quick test.

3. **Implement `createDocState`** — same as today but with `index: { spans: [], totalLength: 0 }` added to the state.

4. **Implement `docReducer` for `INSERT_RUN`** — add the run to `nodes`, splice into `children[parentId]` at the correct sorted position (descending HLC), splice a new `RunSpan` into `index.spans` at the correct position. This is the most complex part — getting the span insertion position right requires walking the tree structure to determine where in the flat span array the new run belongs.

5. **Implement `docReducer` for `SPLIT`** — find the run, create two new runs (left keeps ID, right gets split ID), update `children` (right becomes child of left, left inherits original's children), update `index.spans` (replace one span with two).

6. **Implement `docReducer` for `DELETE_RANGE`** — find the run, handle full-delete (tombstone) vs. partial-delete (need to think about whether partial delete splits the run or marks a sub-range — see open question in causal-tree.md). Update `index.spans`.

7. **Implement `reconstruct`** — DFS traversal, concatenating `node.text` for non-deleted runs. Same pattern as today but with multi-char nodes.

8. **Write comprehensive tests** in `src/__tests__/causal-tree.test.ts` covering all acceptance criteria above. Port the existing convergence and commutativity tests to use `RunNode` instead of `CharNode`.
