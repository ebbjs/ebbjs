import { describe, expect, it } from "vitest"
import { toString, type Hlc } from "../hlc.ts"
import {
  buildPositionMap,
  createDocState,
  docReducer,
  findInsertPosition,
  reconstruct,
  ROOT_ID,
  type CharNode,
  type DocState,
} from "../causal-tree.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a CharNode with a synthetic HLC-derived ID. */
const makeNode = (
  ts: number,
  count: number,
  peerId: string,
  value: string,
  parentId: string,
): CharNode => ({
  id: toString({ ts, count, peerId }),
  value,
  parentId,
  deleted: false,
})

/** Insert a sequence of characters, each parented to the previous. */
const insertSequence = (
  initial: DocState,
  chars: string,
  peerId: string,
  startTs: number,
): { state: DocState; nodeIds: string[] } => {
  let state = initial
  let parentId = ROOT_ID
  const nodeIds: string[] = []

  for (let i = 0; i < chars.length; i++) {
    const node = makeNode(startTs + i, 0, peerId, chars[i]!, parentId)
    state = docReducer(state, { type: "INSERT", node })
    nodeIds.push(node.id)
    parentId = node.id
  }

  return { state, nodeIds }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDocState", () => {
  it("creates a state with only the ROOT node", () => {
    const state = createDocState()
    expect(state.nodes.size).toBe(1)
    expect(state.nodes.has(ROOT_ID)).toBe(true)
    expect(state.children.get(ROOT_ID)).toEqual([])
  })

  it("reconstructs to an empty string", () => {
    expect(reconstruct(createDocState())).toBe("")
  })
})

describe("docReducer — INSERT", () => {
  it("inserts a single character", () => {
    let state = createDocState()
    const node = makeNode(1000, 0, "peer-A", "a", ROOT_ID)
    state = docReducer(state, { type: "INSERT", node })

    expect(state.nodes.size).toBe(2) // ROOT + a
    expect(state.nodes.get(node.id)).toEqual(node)
    expect(reconstruct(state)).toBe("a")
  })

  it("inserts a sequence of characters", () => {
    const { state } = insertSequence(createDocState(), "hello", "peer-A", 1000)
    expect(reconstruct(state)).toBe("hello")
  })

  it("inserts at the beginning (child of ROOT)", () => {
    // Insert "bc" first, then insert "a" also as child of ROOT
    // "a" should come first because it has a lower HLC? No — higher HLC comes first among siblings.
    // "bc": ts 1000, 1001. Then "a": ts 1002 (higher) → "a" comes first.
    const { state: s1, nodeIds } = insertSequence(createDocState(), "bc", "peer-A", 1000)
    const aNode = makeNode(1002, 0, "peer-A", "a", ROOT_ID)
    const s2 = docReducer(s1, { type: "INSERT", node: aNode })

    // "a" (ts=1002) has higher HLC than "b" (ts=1000) among ROOT's children
    // Higher HLC comes first, so: "a" then "bc"
    expect(reconstruct(s2)).toBe("abc")
  })

  it("inserts in the middle", () => {
    // Insert "ac" (a parented to ROOT, c parented to a)
    let state = createDocState()
    const aNode = makeNode(1000, 0, "peer-A", "a", ROOT_ID)
    state = docReducer(state, { type: "INSERT", node: aNode })
    const cNode = makeNode(1001, 0, "peer-A", "c", aNode.id)
    state = docReducer(state, { type: "INSERT", node: cNode })
    expect(reconstruct(state)).toBe("ac")

    // Insert "b" also parented to "a" — between a and c
    // "b" has ts=1002 (higher than c's ts=1001), so "b" comes first among a's children
    const bNode = makeNode(1002, 0, "peer-A", "b", aNode.id)
    state = docReducer(state, { type: "INSERT", node: bNode })

    // Higher HLC first: b (1002) before c (1001)
    expect(reconstruct(state)).toBe("abc")
  })

  it("is idempotent — duplicate INSERT is a no-op", () => {
    let state = createDocState()
    const node = makeNode(1000, 0, "peer-A", "a", ROOT_ID)
    state = docReducer(state, { type: "INSERT", node })
    const stateBefore = state
    state = docReducer(state, { type: "INSERT", node })
    expect(state).toBe(stateBefore) // reference equality — no change
    expect(reconstruct(state)).toBe("a")
  })
})

describe("docReducer — DELETE", () => {
  it("deletes a character (tombstone)", () => {
    const { state: s1, nodeIds } = insertSequence(createDocState(), "abc", "peer-A", 1000)
    expect(reconstruct(s1)).toBe("abc")

    const s2 = docReducer(s1, { type: "DELETE", nodeId: nodeIds[1]! }) // delete "b"
    expect(reconstruct(s2)).toBe("ac")

    // The node still exists but is marked deleted
    const deletedNode = s2.nodes.get(nodeIds[1]!)
    expect(deletedNode?.deleted).toBe(true)
  })

  it("deleting a non-existent node is a no-op", () => {
    const state = createDocState()
    const s2 = docReducer(state, { type: "DELETE", nodeId: "nonexistent" })
    expect(s2).toBe(state)
  })

  it("deleting an already-deleted node is a no-op", () => {
    const { state: s1, nodeIds } = insertSequence(createDocState(), "a", "peer-A", 1000)
    const s2 = docReducer(s1, { type: "DELETE", nodeId: nodeIds[0]! })
    const s3 = docReducer(s2, { type: "DELETE", nodeId: nodeIds[0]! })
    expect(s3).toBe(s2)
  })

  it("deleting a parent does not delete children", () => {
    // Insert "ab" where b is child of a
    const { state: s1, nodeIds } = insertSequence(createDocState(), "ab", "peer-A", 1000)
    const s2 = docReducer(s1, { type: "DELETE", nodeId: nodeIds[0]! }) // delete "a"
    // "b" should still be visible (its parent is deleted but it's not)
    expect(reconstruct(s2)).toBe("b")
  })
})

describe("reconstruct", () => {
  it("handles interleaved inserts correctly", () => {
    let state = createDocState()

    // Build tree: ROOT → a → b → c (sequential)
    const a = makeNode(1000, 0, "peer-A", "a", ROOT_ID)
    state = docReducer(state, { type: "INSERT", node: a })
    const b = makeNode(1001, 0, "peer-A", "b", a.id)
    state = docReducer(state, { type: "INSERT", node: b })
    const c = makeNode(1002, 0, "peer-A", "c", b.id)
    state = docReducer(state, { type: "INSERT", node: c })

    expect(reconstruct(state)).toBe("abc")
  })

  it("handles mix of inserts and deletes", () => {
    const { state: s1, nodeIds } = insertSequence(createDocState(), "abcde", "peer-A", 1000)
    let state = s1
    state = docReducer(state, { type: "DELETE", nodeId: nodeIds[1]! }) // delete b
    state = docReducer(state, { type: "DELETE", nodeId: nodeIds[3]! }) // delete d
    expect(reconstruct(state)).toBe("ace")
  })
})

describe("buildPositionMap", () => {
  it("returns empty map for empty document", () => {
    const posMap = buildPositionMap(createDocState())
    expect(posMap.idAtPosition).toEqual([])
    expect(posMap.positionOfId.size).toBe(0)
  })

  it("is consistent with reconstruct", () => {
    const { state } = insertSequence(createDocState(), "hello", "peer-A", 1000)
    const text = reconstruct(state)
    const posMap = buildPositionMap(state)

    expect(posMap.idAtPosition.length).toBe(text.length)

    // Each position maps to a node whose value matches the character
    for (let i = 0; i < text.length; i++) {
      const nodeId = posMap.idAtPosition[i]!
      const node = state.nodes.get(nodeId)
      expect(node?.value).toBe(text[i])
      expect(posMap.positionOfId.get(nodeId)).toBe(i)
    }
  })

  it("excludes deleted nodes", () => {
    const { state: s1, nodeIds } = insertSequence(createDocState(), "abc", "peer-A", 1000)
    const s2 = docReducer(s1, { type: "DELETE", nodeId: nodeIds[1]! }) // delete b
    const posMap = buildPositionMap(s2)
    expect(posMap.idAtPosition.length).toBe(2)
    expect(posMap.positionOfId.has(nodeIds[1]!)).toBe(false)
  })
})

describe("findInsertPosition", () => {
  it("returns 0 for insert as child of ROOT in empty document", () => {
    const state = createDocState()
    const newId = toString({ ts: 1000, count: 0, peerId: "peer-A" })
    expect(findInsertPosition(state, ROOT_ID, newId)).toBe(0)
  })

  it("returns correct position for insert after last character", () => {
    const { state, nodeIds } = insertSequence(createDocState(), "ab", "peer-A", 1000)
    // Insert after "b" (the last character)
    const newId = toString({ ts: 1002, count: 0, peerId: "peer-A" })
    const pos = findInsertPosition(state, nodeIds[1]!, newId)
    expect(pos).toBe(2) // after "ab"
  })

  it("returns correct position for insert at the beginning", () => {
    const { state } = insertSequence(createDocState(), "bc", "peer-A", 1000)
    // Insert as child of ROOT with higher HLC than existing children
    const newId = toString({ ts: 1002, count: 0, peerId: "peer-A" })
    const pos = findInsertPosition(state, ROOT_ID, newId)
    expect(pos).toBe(0) // before everything, because higher HLC comes first
  })

  it("returns correct position for sibling tie-break", () => {
    // Create "a" then two siblings of "a" with different HLCs
    let state = createDocState()
    const a = makeNode(1000, 0, "peer-A", "a", ROOT_ID)
    state = docReducer(state, { type: "INSERT", node: a })

    // "x" is child of "a" with ts=1001
    const x = makeNode(1001, 0, "peer-A", "x", a.id)
    state = docReducer(state, { type: "INSERT", node: x })
    // State: "ax"

    // Now find position for a new node "y" child of "a" with ts=1002 (higher)
    const yId = toString({ ts: 1002, count: 0, peerId: "peer-A" })
    const pos = findInsertPosition(state, a.id, yId)
    // y has higher HLC, so it should come first among a's children → position 1 (right after a)
    expect(pos).toBe(1)
  })
})

describe("sibling ordering", () => {
  it("orders siblings by descending HLC (higher first)", () => {
    let state = createDocState()

    // Insert three children of ROOT with different HLCs, in arbitrary order
    const c = makeNode(1000, 0, "peer-A", "c", ROOT_ID)
    state = docReducer(state, { type: "INSERT", node: c })
    const a = makeNode(1002, 0, "peer-A", "a", ROOT_ID)
    state = docReducer(state, { type: "INSERT", node: a })
    const b = makeNode(1001, 0, "peer-A", "b", ROOT_ID)
    state = docReducer(state, { type: "INSERT", node: b })

    // Higher HLC first: a (1002), b (1001), c (1000)
    expect(reconstruct(state)).toBe("abc")
  })

  it("tie-breaks on peerId when ts and count are equal", () => {
    let state = createDocState()

    const x = makeNode(1000, 0, "peer-A", "x", ROOT_ID)
    state = docReducer(state, { type: "INSERT", node: x })
    const y = makeNode(1000, 0, "peer-B", "y", ROOT_ID)
    state = docReducer(state, { type: "INSERT", node: y })

    // peer-B > peer-A lexicographically, so y has higher HLC → y first
    expect(reconstruct(state)).toBe("yx")
  })
})

// ---------------------------------------------------------------------------
// Slice 3: Concurrent Conflict (Tie-Break)
// ---------------------------------------------------------------------------

describe("convergence — same ops in different orders produce identical results", () => {
  it("two concurrent inserts with the same parent converge regardless of apply order", () => {
    // Scenario: both peers start with "ab" (a→ROOT, b→a)
    // Peer A inserts "X" after a (parent = a), Peer B inserts "Y" after a (parent = a)
    // Both X and Y are siblings of b under parent a.

    const a = makeNode(1000, 0, "peer-A", "a", ROOT_ID)
    const b = makeNode(1001, 0, "peer-A", "b", a.id)
    const x = makeNode(1002, 0, "peer-A", "X", a.id) // Peer A's concurrent insert
    const y = makeNode(1002, 0, "peer-B", "Y", a.id) // Peer B's concurrent insert (same ts, different peerId)

    // Order 1: base → X → Y (Peer A's perspective: local X first, then remote Y)
    let state1 = createDocState()
    state1 = docReducer(state1, { type: "INSERT", node: a })
    state1 = docReducer(state1, { type: "INSERT", node: b })
    state1 = docReducer(state1, { type: "INSERT", node: x })
    state1 = docReducer(state1, { type: "INSERT", node: y })

    // Order 2: base → Y → X (Peer B's perspective: local Y first, then remote X)
    let state2 = createDocState()
    state2 = docReducer(state2, { type: "INSERT", node: a })
    state2 = docReducer(state2, { type: "INSERT", node: b })
    state2 = docReducer(state2, { type: "INSERT", node: y })
    state2 = docReducer(state2, { type: "INSERT", node: x })

    const text1 = reconstruct(state1)
    const text2 = reconstruct(state2)

    // Both must converge to the same document
    expect(text1).toBe(text2)

    // Y has higher HLC (peer-B > peer-A lexicographically) → Y comes first among siblings
    // b (ts=1001) has lower HLC than both X and Y (ts=1002) → b comes last among a's children
    // So: a, then Y (highest), then X, then b (lowest)
    expect(text1).toBe("aYXb")
  })

  it("three concurrent inserts at the same parent converge in all 6 orderings", () => {
    const parent = makeNode(1000, 0, "peer-A", "p", ROOT_ID)
    const n1 = makeNode(1001, 0, "peer-A", "1", parent.id)
    const n2 = makeNode(1001, 0, "peer-B", "2", parent.id)
    const n3 = makeNode(1001, 0, "peer-C", "3", parent.id)

    const nodes = [n1, n2, n3]

    // All 6 permutations of the 3 concurrent inserts
    const permutations = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2],
      [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ]

    const results: string[] = []
    for (const perm of permutations) {
      let state = createDocState()
      state = docReducer(state, { type: "INSERT", node: parent })
      for (const idx of perm) {
        state = docReducer(state, { type: "INSERT", node: nodes[idx]! })
      }
      results.push(reconstruct(state))
    }

    // All permutations produce the same result
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(results[0])
    }

    // Descending peerId order: C > B > A → "p321"
    expect(results[0]).toBe("p321")
  })

  it("concurrent inserts with different timestamps converge", () => {
    const a = makeNode(1000, 0, "peer-A", "a", ROOT_ID)
    // Two inserts after "a" with different timestamps
    const x = makeNode(1005, 0, "peer-A", "X", a.id) // higher ts
    const y = makeNode(1003, 0, "peer-B", "Y", a.id) // lower ts

    // Order 1: x then y
    let s1 = createDocState()
    s1 = docReducer(s1, { type: "INSERT", node: a })
    s1 = docReducer(s1, { type: "INSERT", node: x })
    s1 = docReducer(s1, { type: "INSERT", node: y })

    // Order 2: y then x
    let s2 = createDocState()
    s2 = docReducer(s2, { type: "INSERT", node: a })
    s2 = docReducer(s2, { type: "INSERT", node: y })
    s2 = docReducer(s2, { type: "INSERT", node: x })

    expect(reconstruct(s1)).toBe(reconstruct(s2))
    // X has ts=1005 (higher), so X comes first: "aXY"
    expect(reconstruct(s1)).toBe("aXY")
  })
})

describe("commutativity — ops in forward and reverse order produce same result", () => {
  it("full sequence of inserts is commutative", () => {
    const nodes: CharNode[] = [
      makeNode(1000, 0, "peer-A", "a", ROOT_ID),
      makeNode(1001, 0, "peer-A", "b", toString({ ts: 1000, count: 0, peerId: "peer-A" })),
      makeNode(1002, 0, "peer-B", "c", toString({ ts: 1000, count: 0, peerId: "peer-A" })),
      makeNode(1003, 0, "peer-A", "d", toString({ ts: 1001, count: 0, peerId: "peer-A" })),
    ]

    // Forward order
    let forward = createDocState()
    for (const node of nodes) {
      forward = docReducer(forward, { type: "INSERT", node })
    }

    // Reverse order
    let reverse = createDocState()
    for (let i = nodes.length - 1; i >= 0; i--) {
      reverse = docReducer(reverse, { type: "INSERT", node: nodes[i]! })
    }

    expect(reconstruct(forward)).toBe(reconstruct(reverse))
  })

  it("interleaved inserts and deletes are commutative for inserts", () => {
    const a = makeNode(1000, 0, "peer-A", "a", ROOT_ID)
    const b = makeNode(1001, 0, "peer-A", "b", a.id)
    const c = makeNode(1002, 0, "peer-B", "c", a.id) // sibling of b

    // Order 1: insert a, b, c, then delete b
    let s1 = createDocState()
    s1 = docReducer(s1, { type: "INSERT", node: a })
    s1 = docReducer(s1, { type: "INSERT", node: b })
    s1 = docReducer(s1, { type: "INSERT", node: c })
    s1 = docReducer(s1, { type: "DELETE", nodeId: b.id })

    // Order 2: insert a, c, delete b (noop — b not yet inserted), then insert b, delete b
    let s2 = createDocState()
    s2 = docReducer(s2, { type: "INSERT", node: a })
    s2 = docReducer(s2, { type: "INSERT", node: c })
    s2 = docReducer(s2, { type: "DELETE", nodeId: b.id }) // noop
    s2 = docReducer(s2, { type: "INSERT", node: b })
    s2 = docReducer(s2, { type: "DELETE", nodeId: b.id })

    expect(reconstruct(s1)).toBe(reconstruct(s2))
    // c has higher HLC (ts=1002) than b (ts=1001), and b is deleted
    // Result: "ac"
    expect(reconstruct(s1)).toBe("ac")
  })
})

describe("idempotency — duplicate INSERTs are no-ops", () => {
  it("inserting the same node twice does not duplicate it", () => {
    let state = createDocState()
    const node = makeNode(1000, 0, "peer-A", "a", ROOT_ID)

    state = docReducer(state, { type: "INSERT", node })
    const afterFirst = reconstruct(state)

    state = docReducer(state, { type: "INSERT", node })
    const afterSecond = reconstruct(state)

    expect(afterFirst).toBe("a")
    expect(afterSecond).toBe("a")
    expect(state.nodes.size).toBe(2) // ROOT + a (not ROOT + a + a)
  })

  it("concurrent inserts replayed are idempotent", () => {
    const a = makeNode(1000, 0, "peer-A", "a", ROOT_ID)
    const x = makeNode(1001, 0, "peer-A", "X", a.id)
    const y = makeNode(1001, 0, "peer-B", "Y", a.id)

    let state = createDocState()
    state = docReducer(state, { type: "INSERT", node: a })
    state = docReducer(state, { type: "INSERT", node: x })
    state = docReducer(state, { type: "INSERT", node: y })

    const textBefore = reconstruct(state)
    const sizeBefore = state.nodes.size

    // Replay all inserts
    state = docReducer(state, { type: "INSERT", node: a })
    state = docReducer(state, { type: "INSERT", node: x })
    state = docReducer(state, { type: "INSERT", node: y })

    expect(reconstruct(state)).toBe(textBefore)
    expect(state.nodes.size).toBe(sizeBefore)
  })
})
