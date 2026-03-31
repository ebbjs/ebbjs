/**
 * Causal Tree (Run-Length Optimized)
 *
 * Reducer-based document state using RunNodes — contiguous sequences of
 * characters by the same peer — ordered by Hybrid Logical Clocks. Maintains
 * an incremental PositionIndex that maps document positions to runs without
 * requiring a full DFS traversal on every edit.
 *
 * This is the "model" — no knowledge of CodeMirror, React, or the network.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A run of consecutive characters by one peer. */
export type RunNode = {
  readonly id: string // HLC-derived ID (from the first character's HLC)
  readonly text: string // 1+ characters (the run content)
  readonly parentId: string // ID of the run this was inserted after
  readonly peerId: string // Which peer authored this run
  readonly deleted: boolean // Tombstone flag (applies to entire run)
}

/**
 * A span in the position index. Each span covers a contiguous range
 * of document positions belonging to one visible run.
 */
export type RunSpan = {
  readonly runId: string // Which RunNode this span belongs to
  readonly length: number // Number of visible characters in this span
}

/**
 * Incremental position index. A flat array of RunSpan entries where
 * each entry covers a contiguous range of document positions.
 * Maintained atomically with every tree mutation by the reducer.
 */
export type PositionIndex = {
  readonly spans: readonly RunSpan[] // Ordered list of visible spans
  readonly totalLength: number // Sum of all span lengths (= doc length)
}

export type DocState = {
  readonly nodes: ReadonlyMap<string, RunNode>
  readonly children: ReadonlyMap<string, readonly string[]> // parentId → ordered child IDs
  readonly index: PositionIndex
}

/** Result of looking up a document position in the index. */
export type PositionLookup = {
  readonly runId: string // Which run contains this position
  readonly offset: number // Offset within the run's text
  readonly spanIndex: number // Index into PositionIndex.spans
}

export type InsertRunAction = {
  readonly type: "INSERT_RUN"
  readonly node: RunNode
}

export type DeleteRangeAction = {
  readonly type: "DELETE_RANGE"
  readonly runId: string
  readonly offset: number // Start offset within the run's text
  readonly count: number // Number of characters to delete
}

/**
 * Split a run at a given offset. The left half keeps the original ID.
 * The right half gets a deterministic split ID.
 */
export type SplitAction = {
  readonly type: "SPLIT"
  readonly runId: string
  readonly offset: number // Split point within the run's text
}

export type DocAction = InsertRunAction | DeleteRangeAction | SplitAction

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sentinel root node. All top-level runs are children of ROOT. */
export const ROOT_ID = "ROOT"

const ROOT_NODE: RunNode = {
  id: ROOT_ID,
  text: "",
  parentId: "",
  peerId: "",
  deleted: false,
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Deterministic split-ID generation.
 * Same inputs always produce the same output, regardless of which peer
 * performs the split. The separator ":s:" is unambiguous — HLC IDs use ":"
 * as a separator but never contain ":s:".
 */
export const makeSplitId = (originalId: string, offset: number): string =>
  `${originalId}:s:${offset}`

/** Create an empty document state with only the root sentinel node. */
export const createDocState = (): DocState => ({
  nodes: new Map([[ROOT_ID, ROOT_NODE]]),
  children: new Map([[ROOT_ID, []]]),
  index: { spans: [], totalLength: 0 },
})

/**
 * Pure reducer. Handles INSERT_RUN, DELETE_RANGE, and SPLIT actions.
 * Returns new state with updated index.
 */
export const docReducer = (state: DocState, action: DocAction): DocState => {
  switch (action.type) {
    case "INSERT_RUN":
      return applyInsertRun(state, action.node)
    case "SPLIT":
      return applySplit(state, action.runId, action.offset)
    case "DELETE_RANGE":
      return applyDeleteRange(state, action.runId, action.offset, action.count)
  }
}

/**
 * DFS traversal of the causal tree, skipping deleted nodes, producing the
 * visible document string. For debugging/consistency checks only — not on
 * the hot path.
 */
export const reconstruct = (state: DocState): string => {
  const result: string[] = []
  dfs(state, ROOT_ID, (node) => {
    if (!node.deleted && node.id !== ROOT_ID) {
      result.push(node.text)
    }
  })
  return result.join("")
}

/**
 * O(spans) lookup: which run contains a given document position.
 * Returns undefined if position is out of bounds.
 */
export const lookupPosition = (
  index: PositionIndex,
  position: number,
): PositionLookup | undefined => {
  if (position < 0 || position >= index.totalLength) return undefined

  let cumulative = 0
  for (let i = 0; i < index.spans.length; i++) {
    const span = index.spans[i]!
    if (position < cumulative + span.length) {
      return {
        runId: span.runId,
        offset: position - cumulative,
        spanIndex: i,
      }
    }
    cumulative += span.length
  }

  return undefined
}

/**
 * Given a run ID and offset within it, return the absolute document position.
 * O(spans). Returns undefined if the run is not in the index.
 */
export const runOffsetToPosition = (
  index: PositionIndex,
  runId: string,
  offset: number,
): number | undefined => {
  let cumulative = 0
  for (const span of index.spans) {
    if (span.runId === runId) {
      if (offset >= span.length) return undefined
      return cumulative + offset
    }
    cumulative += span.length
  }
  return undefined
}

/**
 * Determine the document position where a new run should appear, based on
 * sibling ordering. Uses the span index — no DFS traversal.
 *
 * Approach: find the parent's position in the span array, advance past the
 * parent's own span, then for each preceding sibling (higher HLC) sum the
 * span lengths of its entire subtree.
 */
export const findInsertPosition = (
  state: DocState,
  parentId: string,
  newNodeId: string,
): number => {
  const siblings = state.children.get(parentId) ?? []

  // Find where among siblings the new node would go (descending HLC order)
  let insertIdx = siblings.length
  for (let i = 0; i < siblings.length; i++) {
    if (newNodeId > siblings[i]!) {
      insertIdx = i
      break
    }
  }

  // Compute base position: right after the parent (or 0 for ROOT)
  let basePos: number
  if (parentId === ROOT_ID) {
    basePos = 0
  } else {
    const parentPos = runOffsetToPosition(state.index, parentId, 0)
    if (parentPos === undefined) {
      // Parent is deleted or not in index — fallback
      return 0
    }
    const parentSpan = state.index.spans.find((s) => s.runId === parentId)
    basePos = parentPos + (parentSpan?.length ?? 0)
  }

  // Add visible characters in subtrees of siblings that precede insertIdx.
  // Uses the span index: collect all node IDs in each sibling's subtree,
  // then sum the lengths of matching spans.
  for (let i = 0; i < insertIdx; i++) {
    basePos += subtreeVisibleLength(state, siblings[i]!)
  }

  return basePos
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Apply an INSERT_RUN action. */
const applyInsertRun = (state: DocState, node: RunNode): DocState => {
  // Idempotency: if node already exists, skip
  if (state.nodes.has(node.id)) {
    return state
  }

  // Add to nodes map
  const newNodes = new Map(state.nodes)
  newNodes.set(node.id, node)

  // Insert into children list at the correct sorted position (descending HLC)
  const newChildren = new Map(state.children)
  const siblings = [...(newChildren.get(node.parentId) ?? [])]

  let insertIdx = siblings.length
  for (let i = 0; i < siblings.length; i++) {
    if (node.id > siblings[i]!) {
      insertIdx = i
      break
    }
  }

  siblings.splice(insertIdx, 0, node.id)
  newChildren.set(node.parentId, siblings)

  // Ensure the new node has an entry in the children map
  if (!newChildren.has(node.id)) {
    newChildren.set(node.id, [])
  }

  // Update the position index: find where in the flat span array this run goes.
  // We need the state with updated children for findSpanInsertIndex to work,
  // but we'll compute the span position based on the tree structure.
  const stateWithTree: DocState = {
    nodes: newNodes,
    children: newChildren,
    index: state.index,
  }

  const spanIndex = findSpanInsertIndex(stateWithTree, node)
  const newSpans = [...state.index.spans]

  if (!node.deleted) {
    newSpans.splice(spanIndex, 0, { runId: node.id, length: node.text.length })
  }

  return {
    nodes: newNodes,
    children: newChildren,
    index: {
      spans: newSpans,
      totalLength: node.deleted
        ? state.index.totalLength
        : state.index.totalLength + node.text.length,
    },
  }
}

/** Apply a SPLIT action. */
const applySplit = (
  state: DocState,
  runId: string,
  offset: number,
): DocState => {
  const node = state.nodes.get(runId)
  if (!node) {
    console.error(`SPLIT: node ${runId} not found`)
    return state
  }

  if (offset <= 0 || offset >= node.text.length) {
    console.error(
      `SPLIT: invalid offset ${offset} for node with text length ${node.text.length}`,
    )
    return state
  }

  const splitId = makeSplitId(runId, offset)

  // If the split has already been performed (idempotency), skip
  if (state.nodes.has(splitId)) {
    return state
  }

  // Left half: keeps original ID, truncated text
  const leftNode: RunNode = {
    ...node,
    text: node.text.slice(0, offset),
  }

  // Right half: new split ID, remainder text, parented to left half
  const rightNode: RunNode = {
    id: splitId,
    text: node.text.slice(offset),
    parentId: runId, // child of left half
    peerId: node.peerId,
    deleted: node.deleted,
  }

  // Update nodes
  const newNodes = new Map(state.nodes)
  newNodes.set(runId, leftNode)
  newNodes.set(splitId, rightNode)

  // Update children:
  // - Right half inherits original's children
  // - Left half's children = [rightId, ...] (right is the first/highest-priority child
  //   because it's the continuation of the original text)
  const newChildren = new Map(state.children)
  const originalChildren = newChildren.get(runId) ?? []

  // Right half gets the original's children
  newChildren.set(splitId, [...originalChildren])

  // Left half's first child is the right half, placed before any existing children.
  // The right half must come first among left's children because it's the
  // continuation of the run — it should appear immediately after the left half
  // in document order. We place it at position 0 so it sorts before any
  // other children that might be inserted later (those would have their own
  // HLC ordering). Actually, we need to insert it at the correct sorted position
  // among siblings. But since rightNode is the continuation of the original,
  // and any existing children were children of the original node (now re-parented
  // to right), left's children list should just be [splitId].
  newChildren.set(runId, [splitId])

  // Re-parent the original's children to point to the right half.
  // The children entries in the children map are keyed by parent, so we
  // already moved them above. But the child nodes' parentId fields point
  // to the original — we need to update those to point to the right half.
  for (const childId of originalChildren) {
    const childNode = newNodes.get(childId)
    if (childNode) {
      newNodes.set(childId, { ...childNode, parentId: splitId })
    }
  }

  // Update the position index:
  // Find the span for the original run, replace with two spans
  if (node.deleted) {
    // Deleted nodes have no spans — just update the tree structure
    return { nodes: newNodes, children: newChildren, index: state.index }
  }

  const newSpans = [...state.index.spans]
  const spanIdx = newSpans.findIndex((s) => s.runId === runId)

  if (spanIdx === -1) {
    console.error(`SPLIT: span for ${runId} not found in index`)
    return { nodes: newNodes, children: newChildren, index: state.index }
  }

  // Replace one span with two
  newSpans.splice(spanIdx, 1, {
    runId: runId,
    length: offset,
  }, {
    runId: splitId,
    length: node.text.length - offset,
  })

  return {
    nodes: newNodes,
    children: newChildren,
    index: { spans: newSpans, totalLength: state.index.totalLength },
  }
}

/** Apply a DELETE_RANGE action. */
const applyDeleteRange = (
  state: DocState,
  runId: string,
  offset: number,
  count: number,
): DocState => {
  const node = state.nodes.get(runId)
  if (!node || node.deleted) return state

  const textLen = node.text.length

  // Validate range
  if (offset < 0 || count <= 0 || offset + count > textLen) {
    console.error(
      `DELETE_RANGE: invalid range [${offset}, ${offset + count}) for text length ${textLen}`,
    )
    return state
  }

  // Case 1: Full delete — tombstone the entire run
  if (offset === 0 && count === textLen) {
    return tombstoneRun(state, runId)
  }

  // Case 2: Delete from the beginning of the run
  if (offset === 0) {
    // Split at `count`, then tombstone the left half
    const split = applySplit(state, runId, count)
    return tombstoneRun(split, runId)
  }

  // Case 3: Delete from the end of the run
  if (offset + count === textLen) {
    // Split at `offset`, then tombstone the right half
    const split = applySplit(state, runId, offset)
    const rightId = makeSplitId(runId, offset)
    return tombstoneRun(split, rightId)
  }

  // Case 4: Delete from the middle of the run
  // First split at `offset` to isolate the tail
  const split1 = applySplit(state, runId, offset)
  const rightId = makeSplitId(runId, offset)

  // Then split the right half at `count` to isolate the portion to delete
  const split2 = applySplit(split1, rightId, count)

  // Tombstone the right half (which now contains only the deleted characters)
  return tombstoneRun(split2, rightId)
}

/** Tombstone a single run and remove its span from the index. */
const tombstoneRun = (state: DocState, runId: string): DocState => {
  const node = state.nodes.get(runId)
  if (!node || node.deleted) return state

  const newNodes = new Map(state.nodes)
  newNodes.set(runId, { ...node, deleted: true })

  // Remove the span from the index
  const newSpans = state.index.spans.filter((s) => s.runId !== runId)

  return {
    nodes: newNodes,
    children: state.children,
    index: {
      spans: newSpans,
      totalLength: state.index.totalLength - node.text.length,
    },
  }
}

/** DFS traversal from a given root, calling visitor for each node. */
const dfs = (
  state: DocState,
  nodeId: string,
  visitor: (node: RunNode) => void,
): void => {
  const node = state.nodes.get(nodeId)
  if (!node) return

  visitor(node)

  const childIds = state.children.get(nodeId) ?? []
  for (const childId of childIds) {
    dfs(state, childId, visitor)
  }
}

/**
 * Collect all node IDs in a subtree rooted at `rootId` (inclusive).
 * Walks the children map only — no DFS over node values.
 * O(subtree-size).
 */
const collectSubtreeIds = (
  state: DocState,
  rootId: string,
): Set<string> => {
  const result = new Set<string>()
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop()!
    result.add(id)
    const childIds = state.children.get(id) ?? []
    for (let i = childIds.length - 1; i >= 0; i--) {
      stack.push(childIds[i]!)
    }
  }
  return result
}

/**
 * Sum the visible character count (span lengths) for all nodes in a subtree.
 * Uses the span index — no DFS over node text.
 *
 * Collects subtree IDs via the children map, then sums matching span lengths.
 * O(subtree-size + spans).
 */
const subtreeVisibleLength = (
  state: DocState,
  rootId: string,
): number => {
  const ids = collectSubtreeIds(state, rootId)
  let total = 0
  for (const span of state.index.spans) {
    if (ids.has(span.runId)) {
      total += span.length
    }
  }
  return total
}

/**
 * Find the index in the flat span array where a newly inserted run's span
 * should be spliced. Uses the span index — no full-document DFS.
 *
 * Approach:
 * 1. Find the parent's span in the array (or start at 0 for ROOT).
 * 2. Advance past the parent's span.
 * 3. For each sibling with a higher HLC (comes before the new node in the
 *    children list), skip past all spans belonging to that sibling's subtree.
 * 4. The resulting position is the insertion index.
 *
 * This works because the span array is in document order, and subtrees
 * occupy contiguous ranges in the span array.
 */
const findSpanInsertIndex = (state: DocState, newNode: RunNode): number => {
  const { spans } = state.index
  const siblings = state.children.get(newNode.parentId) ?? []

  // Find where the new node sits among its siblings (descending HLC)
  let siblingInsertIdx = siblings.length
  for (let i = 0; i < siblings.length; i++) {
    if (siblings[i] === newNode.id) {
      siblingInsertIdx = i
      break
    }
  }

  // Find the starting span index: right after the parent's span
  let spanIdx: number
  if (newNode.parentId === ROOT_ID) {
    spanIdx = 0
  } else {
    // Find the parent's span index
    const parentSpanIdx = spans.findIndex(
      (s) => s.runId === newNode.parentId,
    )
    if (parentSpanIdx === -1) {
      // Parent is deleted (no span) — find where its subtree would be
      // by scanning for any span belonging to its subtree. If none, append.
      // For a deleted parent with no visible descendants before us, we need
      // to find the right position by walking up to the grandparent.
      // Simplification: count visible chars before us and locate the span index.
      // This path is rare (inserting as child of a deleted node).
      return spans.length
    }
    spanIdx = parentSpanIdx + 1
  }

  // Skip past spans belonging to subtrees of preceding siblings
  for (let i = 0; i < siblingInsertIdx; i++) {
    const sibId = siblings[i]!
    const sibIds = collectSubtreeIds(state, sibId)
    while (spanIdx < spans.length && sibIds.has(spans[spanIdx]!.runId)) {
      spanIdx++
    }
  }

  return spanIdx
}
