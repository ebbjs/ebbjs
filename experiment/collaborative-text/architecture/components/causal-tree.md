# Causal Tree

## Purpose

Manages the core document data structure — a tree of `CharNode` objects keyed by HLC-derived IDs. Each character knows its parent (the character it was inserted after), forming a causal tree. The Causal Tree module provides a pure reducer for inserting and deleting nodes, and a pure `reconstruct` function that walks the tree to produce the current document string. This is the "model" in the system — it has no knowledge of CodeMirror, React, or the network.

## Responsibilities

- Define the `CharNode` type and the document state shape
- Handle `INSERT` and `DELETE` actions via a pure reducer function
- Reconstruct the visible document string from the tree via DFS traversal
- Determine the correct insertion index for a new node among its siblings using the HLC tie-break rule
- Provide a mapping from tree-order position to node ID (and vice versa) so the CM Bridge can translate between positions and IDs

## Public interface

### Exported functions

| Name | Signature | Description |
|------|-----------|-------------|
| `createDocState` | `() => DocState` | Create an empty document state with only the root sentinel node |
| `docReducer` | `(state: DocState, action: DocAction) => DocState` | Pure reducer. Handles `INSERT` and `DELETE` actions. Returns new state. |
| `reconstruct` | `(state: DocState) => string` | DFS traversal of the causal tree, skipping deleted nodes, producing the visible document string |
| `buildPositionMap` | `(state: DocState) => PositionMap` | DFS traversal that returns a bidirectional mapping: position index ↔ node ID for all visible (non-deleted) characters |
| `findInsertPosition` | `(state: DocState, parentId: string, newNodeId: string) => number` | Given a parent node and a new node's ID, determine the 0-based index in the visible document where this character should appear. Uses the HLC tie-break rule to order among siblings. |

### Types

```ts
type CharNode = {
  readonly id: string         // HLC-derived unique ID (from hlc.toString())
  readonly value: string      // Single character
  readonly parentId: string   // ID of the node this was inserted after
  readonly deleted: boolean   // Tombstone flag
}

type DocState = {
  readonly nodes: ReadonlyMap<string, CharNode>   // All nodes (including deleted)
  readonly children: ReadonlyMap<string, readonly string[]>  // parentId → ordered child IDs
}

// Actions for the reducer
type InsertAction = {
  readonly type: "INSERT"
  readonly node: CharNode
}

type DeleteAction = {
  readonly type: "DELETE"
  readonly nodeId: string
}

type DocAction = InsertAction | DeleteAction

// Bidirectional position mapping
type PositionMap = {
  readonly idAtPosition: readonly string[]   // index → nodeId (only visible chars)
  readonly positionOfId: ReadonlyMap<string, number>  // nodeId → index (only visible chars)
}
```

**Sentinel root node:** The tree has a virtual root node with `id: "ROOT"`, `value: ""`, `parentId: ""`. All top-level characters are children of ROOT. This avoids null-checks for parentId.

## Dependencies

| Dependency | What it needs | Reference |
|------------|---------------|-----------|
| HLC | `compare` function (for sibling ordering in `findInsertPosition`) | [hlc.md](hlc.md#exported-functions) |

The Causal Tree imports only the `compare` function from HLC to determine sibling order. It does not create or increment HLCs — that's the caller's job.

## Internal design notes

### Data structure

`DocState` holds two maps:
- `nodes`: the flat lookup table of all CharNodes by ID
- `children`: an adjacency list mapping each parent ID to its ordered list of child IDs

When a new node is inserted, it's added to `nodes` and spliced into the correct position in `children[parentId]` based on the HLC tie-break rule (higher HLC first among siblings).

### DFS traversal (reconstruct / buildPositionMap)

Starting from ROOT, visit children in order. For each child, if not deleted, append its value (or record its position). Then recurse into that child's children. This produces a depth-first, left-to-right traversal that gives the document's character order.

### Sibling ordering

Children of the same parent are ordered by **descending HLC** (higher HLC = earlier position among siblings). This means if peer A and peer B both insert after the same character, the one with the higher HLC appears first. This is the deterministic tie-break that ensures convergence.

The `children` map maintains this sorted order at insert time, so traversal doesn't need to re-sort.

### Immutability

The reducer returns new objects. `nodes` is a new `Map` (or a copy with the new entry). `children` is a new `Map` with the affected parent's child list replaced. This is a prototype — structural sharing (persistent data structures) is not needed. Shallow copies are fine.

## Open questions

- **Performance of `Map` copies:** For a prototype with small documents, copying the entire `Map` on each insert is fine. For larger documents, consider using an immutable map library or only copying the affected entries. Not a concern for this experiment.
- **`children` as sorted array vs. insertion sort:** The current design inserts into the correct position in the children array on each INSERT action (binary search + splice on a copy). An alternative is to store children unsorted and sort during traversal. Insertion-time sorting is preferred because traversal happens more often than insertion (every keystroke triggers reconstruct).
- **Should `reconstruct` and `buildPositionMap` be memoized?** They traverse the entire tree on every call. For the prototype, this is fine. If performance becomes an issue, memoize based on `DocState` reference identity (since the reducer returns new objects on change).

## File

`src/causal-tree.ts` — pure functions, imports only from `./hlc.ts`.
Test file: `src/__tests__/causal-tree.test.ts`
