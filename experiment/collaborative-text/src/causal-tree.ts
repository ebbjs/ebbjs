/**
 * Causal Tree
 *
 * Reducer-based document state: a Map<string, CharNode> with pure insert,
 * delete, and reconstruct operations. Each character knows its parent
 * (the character it was inserted after), forming a causal tree.
 *
 * This is the "model" — no knowledge of CodeMirror, React, or the network.
 */

import { compare } from "./hlc.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CharNode = {
  readonly id: string // HLC-derived unique ID (from hlc.toString())
  readonly value: string // Single character
  readonly parentId: string // ID of the node this was inserted after
  readonly deleted: boolean // Tombstone flag
}

export type DocState = {
  readonly nodes: ReadonlyMap<string, CharNode> // All nodes (including deleted)
  readonly children: ReadonlyMap<string, readonly string[]> // parentId → ordered child IDs
}

export type InsertAction = {
  readonly type: "INSERT"
  readonly node: CharNode
}

export type DeleteAction = {
  readonly type: "DELETE"
  readonly nodeId: string
}

export type DocAction = InsertAction | DeleteAction

/** Bidirectional position mapping: visible-doc index ↔ node ID. */
export type PositionMap = {
  readonly idAtPosition: readonly string[] // index → nodeId (only visible chars)
  readonly positionOfId: ReadonlyMap<string, number> // nodeId → index (only visible chars)
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sentinel root node. All top-level characters are children of ROOT. */
export const ROOT_ID = "ROOT"

const ROOT_NODE: CharNode = {
  id: ROOT_ID,
  value: "",
  parentId: "",
  deleted: false,
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/** Create an empty document state with only the root sentinel node. */
export const createDocState = (): DocState => ({
  nodes: new Map([[ROOT_ID, ROOT_NODE]]),
  children: new Map([[ROOT_ID, []]]),
})

/**
 * Pure reducer. Handles INSERT and DELETE actions. Returns new state.
 *
 * INSERT: adds the node to `nodes` and splices it into the correct position
 * in `children[parentId]` based on the HLC tie-break rule (higher HLC first).
 *
 * DELETE: sets the `deleted` flag on the node. Does NOT remove from `children`
 * (tombstone approach — the node stays in the tree for ordering purposes).
 */
export const docReducer = (state: DocState, action: DocAction): DocState => {
  switch (action.type) {
    case "INSERT":
      return applyInsert(state, action.node)
    case "DELETE":
      return applyDelete(state, action.nodeId)
  }
}

/**
 * DFS traversal of the causal tree, skipping deleted nodes, producing the
 * visible document string.
 */
export const reconstruct = (state: DocState): string => {
  const result: string[] = []
  dfs(state, ROOT_ID, (node) => {
    if (!node.deleted && node.id !== ROOT_ID) {
      result.push(node.value)
    }
  })
  return result.join("")
}

/**
 * DFS traversal that returns a bidirectional mapping:
 * position index ↔ node ID for all visible (non-deleted) characters.
 */
export const buildPositionMap = (state: DocState): PositionMap => {
  const idAtPosition: string[] = []
  const positionOfId = new Map<string, number>()

  dfs(state, ROOT_ID, (node) => {
    if (!node.deleted && node.id !== ROOT_ID) {
      const pos = idAtPosition.length
      idAtPosition.push(node.id)
      positionOfId.set(node.id, pos)
    }
  })

  return { idAtPosition, positionOfId }
}

/**
 * Given a parent node and a new node's ID, determine the 0-based index in
 * the visible document where this character should appear.
 *
 * Walks the tree to find where the new node would be placed among its
 * siblings, then counts visible characters up to that point.
 */
export const findInsertPosition = (
  state: DocState,
  parentId: string,
  newNodeId: string,
): number => {
  // First, determine where among the parent's children the new node would go.
  // Children are ordered by descending HLC (higher first).
  const siblings = state.children.get(parentId) ?? []
  let insertIdx = siblings.length // default: after all siblings

  for (let i = 0; i < siblings.length; i++) {
    const siblingId = siblings[i]!
    // Compare: we want descending order, so higher HLC first.
    // If newNodeId > siblingId (by HLC string comparison, which matches compare()),
    // the new node goes before this sibling.
    if (newNodeId > siblingId) {
      insertIdx = i
      break
    }
  }

  // Now count visible characters up to that insertion point.
  // The position is: (visible chars before parent) + 1 (for parent, if visible)
  //                  + (visible chars in subtrees of siblings before insertIdx)
  const posMap = buildPositionMap(state)
  const parentPos = posMap.positionOfId.get(parentId)

  // Start right after the parent's position
  let basePos: number
  if (parentId === ROOT_ID) {
    basePos = 0
  } else if (parentPos !== undefined) {
    basePos = parentPos + 1
  } else {
    // Parent is deleted — insert at position 0 as fallback
    // This shouldn't happen in normal operation
    return 0
  }

  // Add the count of visible characters in the subtrees of siblings that come
  // before the insertion index (i.e., siblings with higher HLCs)
  for (let i = 0; i < insertIdx; i++) {
    const sibId = siblings[i]!
    basePos += countVisibleInSubtree(state, sibId)
  }

  return basePos
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Apply an INSERT action. */
const applyInsert = (state: DocState, node: CharNode): DocState => {
  // Idempotency: if node already exists, skip
  if (state.nodes.has(node.id)) {
    return state
  }

  // Add to nodes map
  const newNodes = new Map(state.nodes)
  newNodes.set(node.id, node)

  // Insert into children list at the correct sorted position
  const newChildren = new Map(state.children)
  const siblings = [...(newChildren.get(node.parentId) ?? [])]

  // Find insertion point: descending HLC order (higher ID string first)
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

  return { nodes: newNodes, children: newChildren }
}

/** Apply a DELETE action (tombstone). */
const applyDelete = (state: DocState, nodeId: string): DocState => {
  const node = state.nodes.get(nodeId)
  if (!node || node.deleted) return state

  const newNodes = new Map(state.nodes)
  newNodes.set(nodeId, { ...node, deleted: true })

  return { nodes: newNodes, children: state.children }
}

/** DFS traversal from a given root, calling visitor for each node. */
const dfs = (
  state: DocState,
  nodeId: string,
  visitor: (node: CharNode) => void,
): void => {
  const node = state.nodes.get(nodeId)
  if (!node) return

  visitor(node)

  const childIds = state.children.get(nodeId) ?? []
  for (const childId of childIds) {
    dfs(state, childId, visitor)
  }
}

/** Count visible (non-deleted) characters in a node's subtree (including itself). */
const countVisibleInSubtree = (state: DocState, nodeId: string): number => {
  let count = 0
  dfs(state, nodeId, (node) => {
    if (!node.deleted && node.id !== ROOT_ID) {
      count++
    }
  })
  return count
}
