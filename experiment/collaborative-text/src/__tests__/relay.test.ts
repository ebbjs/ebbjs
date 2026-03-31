/**
 * Relay tests (Ebb-Native Wire Protocol)
 *
 * Tests the handleRemoteMessage function directly (pure-ish, no
 * BroadcastChannel needed). Uses a real CM EditorView in happy-dom
 * to verify that remote operations apply correctly.
 *
 * Messages now follow ebb's Action → Update[] model:
 * - INSERT_RUN becomes an Action with a "put" Update carrying a causal_tree_run field
 * - DELETE_RANGE becomes an Action with a "delete" Update carrying a causal_tree_range field
 * - Actions are the atomic sync unit — dedup happens at the Action level
 *
 * @vitest-environment happy-dom
 */

import { describe, expect, it, vi } from "vitest"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { createHlc, increment, toString, type Hlc } from "../hlc.ts"
import {
  createDocState,
  docReducer,
  reconstruct,
  ROOT_ID,
  type DocAction,
  type DocState,
  type RunNode,
} from "../causal-tree.ts"
import {
  createBridgeExtension,
  createIdMapField,
  isRemote,
  setIdMapEffect,
  type BridgeConfig,
} from "../cm-bridge.ts"
import {
  handleRemoteMessage,
  type Action,
  type SyncMessage,
  type PresenceMessage,
  type RelayConfig,
} from "../relay.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Counter for generating unique action/update IDs in tests. */
let testIdCounter = 0

/**
 * Create an ebb-native Action containing a single "put" Update for inserting
 * a RunNode. Mirrors the production code in App.tsx's docActionToUpdate.
 */
const makeInsertAction = (
  peerId: string,
  node: RunNode,
  hlc: Hlc,
): Action => {
  const id = `test_act_${testIdCounter++}`
  return {
    id,
    actor_id: peerId,
    hlc,
    updates: [
      {
        id: `test_upd_${testIdCounter++}`,
        subject_id: node.id,
        subject_type: "run",
        method: "put",
        data: {
          fields: {
            run: { type: "causal_tree_run", value: node, hlc },
          },
        },
      },
    ],
  }
}

/**
 * Create an ebb-native Action containing a single "delete" Update for
 * tombstoning a range within a RunNode.
 */
const makeDeleteAction = (
  peerId: string,
  runId: string,
  offset: number,
  count: number,
  hlc: Hlc,
): Action => {
  const id = `test_act_${testIdCounter++}`
  return {
    id,
    actor_id: peerId,
    hlc,
    updates: [
      {
        id: `test_upd_${testIdCounter++}`,
        subject_id: runId,
        subject_type: "run",
        method: "delete",
        data: {
          fields: {
            range: { type: "causal_tree_range", value: { offset, count }, hlc },
          },
        },
      },
    ],
  }
}

/** Wrap an Action into a SyncMessage for handleRemoteMessage. */
const actionMsg = (action: Action): SyncMessage => ({
  type: "ACTION",
  action,
})

/**
 * Create a fully wired test environment: a CM EditorView + Causal Tree +
 * relay config, simulating one peer's local state.
 */
const createTestPeer = (peerId: string) => {
  let docState: DocState = createDocState()
  const hlcRef = { current: createHlc(peerId) }
  const viewRef: { current: EditorView | null } = { current: null }
  const idMapField = createIdMapField()
  const dispatched: DocAction[] = []

  const dispatch = (action: DocAction) => {
    docState = docReducer(docState, action)
    dispatched.push(action)
  }

  // Bridge config (for local edits — not used directly in relay tests,
  // but needed for CM setup)
  const bridgeConfig: BridgeConfig = {
    peerId,
    getHlc: () => hlcRef.current,
    setHlc: (h: Hlc) => {
      hlcRef.current = h
    },
    dispatch,
    getDocState: () => docState,
  }

  const state = EditorState.create({
    doc: "",
    extensions: [createBridgeExtension(bridgeConfig, idMapField)],
  })

  const view = new EditorView({ state })
  viewRef.current = view

  const relayConfig: RelayConfig = {
    channelName: "test-channel",
    peerId,
    hlcRef,
    dispatch,
    getDocState: () => docState,
    viewRef,
    idMapField,
  }

  return {
    view,
    hlcRef,
    relayConfig,
    getDocState: () => docState,
    getDispatched: () => dispatched,
    idMapField,
    /**
     * Helper: locally insert a run by directly manipulating the tree + CM.
     * Simulates what the bridge does for local edits.
     */
    localInsertRun: (text: string, parentId?: string) => {
      hlcRef.current = increment(hlcRef.current)
      const nodeId = toString(hlcRef.current)

      // Determine parent: the last visible run, or ROOT
      const resolvedParentId = parentId ?? (() => {
        const { spans } = docState.index
        if (spans.length === 0) return ROOT_ID
        return spans[spans.length - 1]!.runId
      })()

      const node: RunNode = {
        id: nodeId,
        text,
        parentId: resolvedParentId,
        peerId,
        deleted: false,
      }

      docState = docReducer(docState, { type: "INSERT_RUN", node })

      // Apply to CM view — insert the text and update the span field
      const pos = view.state.doc.length
      view.dispatch({
        changes: { from: pos, insert: text },
        effects: setIdMapEffect.of(docState.index.spans),
        annotations: isRemote.of(true),
      })

      return { nodeId, node }
    },
  }
}

/** Create a RunNode with a specific HLC. */
const makeRunNode = (
  ts: number,
  count: number,
  peerId: string,
  text: string,
  parentId: string,
): RunNode => ({
  id: toString({ ts, count, peerId }),
  text,
  parentId,
  peerId,
  deleted: false,
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleRemoteMessage — Action with put Update (insert)", () => {
  it("applies a remote insert to an empty document", () => {
    const peer = createTestPeer("peer-B")
    const senderHlc: Hlc = { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" }
    const node = makeRunNode(senderHlc.ts, 0, "peer-A", "hello", ROOT_ID)

    const action = makeInsertAction("peer-A", node, senderHlc)
    handleRemoteMessage(actionMsg(action), peer.relayConfig)

    expect(reconstruct(peer.getDocState())).toBe("hello")
    expect(peer.view.state.doc.toString()).toBe("hello")
  })

  it("applies a multi-character remote insert in one CM transaction", () => {
    const peer = createTestPeer("peer-B")
    const senderHlc: Hlc = { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" }
    const node = makeRunNode(senderHlc.ts, 0, "peer-A", "hello world", ROOT_ID)

    const action = makeInsertAction("peer-A", node, senderHlc)
    handleRemoteMessage(actionMsg(action), peer.relayConfig)

    expect(reconstruct(peer.getDocState())).toBe("hello world")
    expect(peer.view.state.doc.toString()).toBe("hello world")
  })

  it("applies a remote insert at the correct position in an existing document", () => {
    const peer = createTestPeer("peer-B")
    // Locally insert "ac"
    const { nodeId: aId } = peer.localInsertRun("ac")
    expect(peer.view.state.doc.toString()).toBe("ac")

    // Remote peer-A inserts "b" after "ac" (child of "ac" run)
    const senderHlc: Hlc = { ts: Date.now() + 200_000, count: 0, peerId: "peer-A" }
    const bNode = makeRunNode(senderHlc.ts, 0, "peer-A", "b", aId)

    const action = makeInsertAction("peer-A", bNode, senderHlc)
    handleRemoteMessage(actionMsg(action), peer.relayConfig)

    // "b" is child of "ac", higher HLC → comes before any lower-HLC children
    expect(reconstruct(peer.getDocState())).toBe("acb")
    expect(peer.view.state.doc.toString()).toBe("acb")
  })

  it("merges the remote HLC into the local HLC", () => {
    const peer = createTestPeer("peer-B")

    const remoteFutureHlc: Hlc = {
      ts: Date.now() + 500_000,
      count: 10,
      peerId: "peer-A",
    }
    const node = makeRunNode(remoteFutureHlc.ts, 10, "peer-A", "x", ROOT_ID)

    const action = makeInsertAction("peer-A", node, remoteFutureHlc)
    handleRemoteMessage(actionMsg(action), peer.relayConfig)

    // After merge, local HLC should be >= remote HLC
    expect(peer.hlcRef.current.ts).toBeGreaterThanOrEqual(remoteFutureHlc.ts)
  })

  it("is idempotent — duplicate Action is a no-op (action-level dedup)", () => {
    const peer = createTestPeer("peer-B")
    const senderHlc: Hlc = { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" }
    const node = makeRunNode(senderHlc.ts, 0, "peer-A", "hello", ROOT_ID)
    const action = makeInsertAction("peer-A", node, senderHlc)

    // Send the same Action twice
    handleRemoteMessage(actionMsg(action), peer.relayConfig)
    handleRemoteMessage(actionMsg(action), peer.relayConfig)

    // Causal Tree is correct — no duplicate
    expect(reconstruct(peer.getDocState())).toBe("hello")
    // CM view is also correct — action-level dedup skips the entire
    // second Action, so no duplicate text
    expect(peer.view.state.doc.toString()).toBe("hello")
  })
})

describe("handleRemoteMessage — Action with delete Update", () => {
  it("applies a remote delete", () => {
    const peer = createTestPeer("peer-B")
    const { nodeId } = peer.localInsertRun("abc")
    expect(peer.view.state.doc.toString()).toBe("abc")

    const senderHlc: Hlc = { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" }

    // Delete "b" from "abc" (offset 1, count 1)
    const action = makeDeleteAction("peer-A", nodeId, 1, 1, senderHlc)
    handleRemoteMessage(actionMsg(action), peer.relayConfig)

    expect(reconstruct(peer.getDocState())).toBe("ac")
    expect(peer.view.state.doc.toString()).toBe("ac")
  })

  it("applies a remote full-run delete", () => {
    const peer = createTestPeer("peer-B")
    const { nodeId } = peer.localInsertRun("hello")
    expect(peer.view.state.doc.toString()).toBe("hello")

    const senderHlc: Hlc = { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" }

    const action = makeDeleteAction("peer-A", nodeId, 0, 5, senderHlc)
    handleRemoteMessage(actionMsg(action), peer.relayConfig)

    expect(reconstruct(peer.getDocState())).toBe("")
    expect(peer.view.state.doc.toString()).toBe("")
  })

  it("merges the remote HLC on delete", () => {
    const peer = createTestPeer("peer-B")
    const { nodeId } = peer.localInsertRun("a")

    const remoteFutureHlc: Hlc = {
      ts: Date.now() + 500_000,
      count: 5,
      peerId: "peer-A",
    }

    const action = makeDeleteAction("peer-A", nodeId, 0, 1, remoteFutureHlc)
    handleRemoteMessage(actionMsg(action), peer.relayConfig)

    expect(peer.hlcRef.current.ts).toBeGreaterThanOrEqual(remoteFutureHlc.ts)
  })
})

describe("handleRemoteMessage — Action with multiple Updates (batched)", () => {
  it("applies multiple updates in a single Action atomically", () => {
    const peer = createTestPeer("peer-B")

    // Set up two runs: "abc" and "def"
    const { nodeId: abcId } = peer.localInsertRun("abc")
    const { nodeId: defId } = peer.localInsertRun("def")
    expect(peer.view.state.doc.toString()).toBe("abcdef")

    const senderHlc: Hlc = { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" }

    // Create a single Action that deletes from both runs
    // (like a "select all and delete" operation)
    const action: Action = {
      id: `test_batch_act_${testIdCounter++}`,
      actor_id: "peer-A",
      hlc: senderHlc,
      updates: [
        {
          id: `test_batch_upd_${testIdCounter++}`,
          subject_id: abcId,
          subject_type: "run",
          method: "delete",
          data: {
            fields: {
              range: { type: "causal_tree_range", value: { offset: 0, count: 3 }, hlc: senderHlc },
            },
          },
        },
        {
          id: `test_batch_upd_${testIdCounter++}`,
          subject_id: defId,
          subject_type: "run",
          method: "delete",
          data: {
            fields: {
              range: { type: "causal_tree_range", value: { offset: 0, count: 3 }, hlc: senderHlc },
            },
          },
        },
      ],
    }

    handleRemoteMessage(actionMsg(action), peer.relayConfig)

    expect(reconstruct(peer.getDocState())).toBe("")
    expect(peer.view.state.doc.toString()).toBe("")
  })
})

describe("handleRemoteMessage — own message filtering", () => {
  it("ignores Actions from the same actor_id", () => {
    const peer = createTestPeer("peer-A")
    const node = makeRunNode(Date.now() + 100_000, 0, "peer-A", "x", ROOT_ID)
    const hlc: Hlc = { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" }

    // Action with actor_id matching the local peer
    const action = makeInsertAction("peer-A", node, hlc)
    handleRemoteMessage(actionMsg(action), peer.relayConfig)

    // Should not have been applied
    expect(reconstruct(peer.getDocState())).toBe("")
    expect(peer.view.state.doc.toString()).toBe("")
  })
})

describe("handleRemoteMessage — PRESENCE", () => {
  it("forwards presence to the updatePresence callback", () => {
    const updatePresence = vi.fn()
    const peer = createTestPeer("peer-B")
    const configWithPresence: RelayConfig = {
      ...peer.relayConfig,
      updatePresence,
    }

    const message: PresenceMessage = {
      type: "PRESENCE",
      peerId: "peer-A",
      anchorId: "some-id",
      anchorOffset: 3,
      headId: "some-id",
      headOffset: 3,
    }

    handleRemoteMessage(message, configWithPresence)

    expect(updatePresence).toHaveBeenCalledWith("peer-A", "some-id", 3, "some-id", 3)
  })

  it("does not crash if updatePresence is not provided", () => {
    const peer = createTestPeer("peer-B")

    const message: PresenceMessage = {
      type: "PRESENCE",
      peerId: "peer-A",
      anchorId: "some-id",
      anchorOffset: 3,
      headId: "some-id",
      headOffset: 3,
    }

    // Should not throw
    expect(() =>
      handleRemoteMessage(message, peer.relayConfig),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Concurrent Conflict (Tie-Break) — Run-Level
// ---------------------------------------------------------------------------

describe("concurrent conflict — tie-break convergence (run-level)", () => {
  it("two peers inserting at the same position converge to the same document", () => {
    const peerA = createTestPeer("peer-A")
    const peerB = createTestPeer("peer-B")

    // Both peers start with "ab" (one run "ab" → ROOT)
    const baseTs = Date.now() + 1_000_000
    const baseNode = makeRunNode(baseTs, 0, "peer-A", "ab", ROOT_ID)

    // Apply base state to both peers
    for (const peer of [peerA, peerB]) {
      peer.relayConfig.dispatch({ type: "INSERT_RUN", node: baseNode })
      peer.view.dispatch({
        changes: { from: 0, insert: "ab" },
        effects: setIdMapEffect.of(peer.getDocState().index.spans),
        annotations: isRemote.of(true),
      })
    }

    // Verify both start with "ab"
    expect(peerA.view.state.doc.toString()).toBe("ab")
    expect(peerB.view.state.doc.toString()).toBe("ab")

    // Peer A inserts "XX" after "ab" (parent = baseNode.id)
    const hlcX: Hlc = { ts: baseTs + 2, count: 0, peerId: "peer-A" }
    const nodeX = makeRunNode(baseTs + 2, 0, "peer-A", "XX", baseNode.id)

    // Apply XX locally on Peer A
    peerA.relayConfig.dispatch({ type: "INSERT_RUN", node: nodeX })
    peerA.view.dispatch({
      changes: { from: 2, insert: "XX" },
      effects: setIdMapEffect.of(peerA.getDocState().index.spans),
      annotations: isRemote.of(true),
    })
    expect(peerA.view.state.doc.toString()).toBe("abXX")

    // Peer B inserts "YY" after "ab" (parent = baseNode.id) — BEFORE receiving XX
    const hlcY: Hlc = { ts: baseTs + 2, count: 0, peerId: "peer-B" }
    const nodeY = makeRunNode(baseTs + 2, 0, "peer-B", "YY", baseNode.id)

    peerB.relayConfig.dispatch({ type: "INSERT_RUN", node: nodeY })
    peerB.view.dispatch({
      changes: { from: 2, insert: "YY" },
      effects: setIdMapEffect.of(peerB.getDocState().index.spans),
      annotations: isRemote.of(true),
    })
    expect(peerB.view.state.doc.toString()).toBe("abYY")

    // Now exchange messages as ebb-native Actions:
    // Peer A receives Peer B's YY
    const actionY = makeInsertAction("peer-B", nodeY, hlcY)
    handleRemoteMessage(actionMsg(actionY), peerA.relayConfig)

    // Peer B receives Peer A's XX
    const actionX = makeInsertAction("peer-A", nodeX, hlcX)
    handleRemoteMessage(actionMsg(actionX), peerB.relayConfig)

    // Both peers must converge to the same document
    const textA = reconstruct(peerA.getDocState())
    const textB = reconstruct(peerB.getDocState())
    expect(textA).toBe(textB)

    // YY has higher HLC (peer-B > peer-A at same ts:count) → YY comes first
    expect(textA).toBe("abYYXX")

    // CM views must also match
    expect(peerA.view.state.doc.toString()).toBe("abYYXX")
    expect(peerB.view.state.doc.toString()).toBe("abYYXX")
  })

  it("duplicate Actions during concurrent conflict are handled correctly", () => {
    const peerA = createTestPeer("peer-A")

    // Insert base run
    const baseTs = Date.now() + 1_000_000
    const baseNode = makeRunNode(baseTs, 0, "peer-A", "a", ROOT_ID)
    peerA.relayConfig.dispatch({ type: "INSERT_RUN", node: baseNode })
    peerA.view.dispatch({
      changes: { from: 0, insert: "a" },
      effects: setIdMapEffect.of(peerA.getDocState().index.spans),
      annotations: isRemote.of(true),
    })

    // Peer B sends "XX" after "a" — wrapped as an ebb-native Action
    const hlcX: Hlc = { ts: baseTs + 1, count: 0, peerId: "peer-B" }
    const nodeX = makeRunNode(baseTs + 1, 0, "peer-B", "XX", baseNode.id)
    const actionX = makeInsertAction("peer-B", nodeX, hlcX)

    // Peer A receives the same Action twice (simulating network replay)
    handleRemoteMessage(actionMsg(actionX), peerA.relayConfig)
    handleRemoteMessage(actionMsg(actionX), peerA.relayConfig)

    // Should be "aXX" not "aXXXX" — action-level dedup prevents re-application
    expect(reconstruct(peerA.getDocState())).toBe("aXX")
    expect(peerA.view.state.doc.toString()).toBe("aXX")
  })
})

describe("two-peer simulation (run-level)", () => {
  it("syncs a sequence of run inserts between two peers via Actions", () => {
    const peerA = createTestPeer("peer-A")
    const peerB = createTestPeer("peer-B")

    // Peer A types "hello" (one run)
    const aHlc1 = increment(peerA.hlcRef.current)
    peerA.hlcRef.current = aHlc1
    const nodeHello: RunNode = {
      id: toString(aHlc1),
      text: "hello",
      parentId: ROOT_ID,
      peerId: "peer-A",
      deleted: false,
    }

    // Apply locally on A
    peerA.relayConfig.dispatch({ type: "INSERT_RUN", node: nodeHello })
    peerA.view.dispatch({
      changes: { from: 0, insert: "hello" },
      effects: setIdMapEffect.of(peerA.getDocState().index.spans),
      annotations: isRemote.of(true),
    })

    // Broadcast to B as an ebb-native Action
    const actionHello = makeInsertAction("peer-A", nodeHello, aHlc1)
    handleRemoteMessage(actionMsg(actionHello), peerB.relayConfig)

    // Second run: " world" parented to "hello"
    const aHlc2 = increment(peerA.hlcRef.current)
    peerA.hlcRef.current = aHlc2
    const nodeWorld: RunNode = {
      id: toString(aHlc2),
      text: " world",
      parentId: nodeHello.id,
      peerId: "peer-A",
      deleted: false,
    }

    peerA.relayConfig.dispatch({ type: "INSERT_RUN", node: nodeWorld })
    peerA.view.dispatch({
      changes: { from: 5, insert: " world" },
      effects: setIdMapEffect.of(peerA.getDocState().index.spans),
      annotations: isRemote.of(true),
    })

    const actionWorld = makeInsertAction("peer-A", nodeWorld, aHlc2)
    handleRemoteMessage(actionMsg(actionWorld), peerB.relayConfig)

    // Both peers should show "hello world"
    expect(reconstruct(peerA.getDocState())).toBe("hello world")
    expect(reconstruct(peerB.getDocState())).toBe("hello world")
    expect(peerA.view.state.doc.toString()).toBe("hello world")
    expect(peerB.view.state.doc.toString()).toBe("hello world")
  })
})

// ---------------------------------------------------------------------------
// PATCH Update tests (run extension / append coalescing)
// ---------------------------------------------------------------------------

/**
 * Create an ebb-native Action containing a single "patch" Update for
 * appending text to an existing RunNode.
 */
const makePatchAction = (
  peerId: string,
  runId: string,
  appendText: string,
  hlc: Hlc,
): Action => {
  const id = `test_act_${testIdCounter++}`
  return {
    id,
    actor_id: peerId,
    hlc,
    updates: [
      {
        id: `test_upd_${testIdCounter++}`,
        subject_id: runId,
        subject_type: "run",
        method: "patch",
        data: {
          fields: {
            append: { type: "causal_tree_append", value: { text: appendText }, hlc },
          },
        },
      },
    ],
  }
}

describe("handleRemoteMessage — Action with patch Update (extend)", () => {
  it("appends text to an existing run via a remote patch", () => {
    const peer = createTestPeer("peer-B")

    // Insert "hel" locally
    const { nodeId } = peer.localInsertRun("hel")
    expect(peer.view.state.doc.toString()).toBe("hel")

    // Remote peer-A sends a patch to extend this run with "lo"
    const senderHlc: Hlc = { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" }
    const action = makePatchAction("peer-A", nodeId, "lo", senderHlc)
    handleRemoteMessage(actionMsg(action), peer.relayConfig)

    expect(reconstruct(peer.getDocState())).toBe("hello")
    expect(peer.view.state.doc.toString()).toBe("hello")
  })

  it("extends a run multiple times via sequential patch Actions", () => {
    const peer = createTestPeer("peer-B")

    // Insert "h" locally
    const { nodeId } = peer.localInsertRun("h")
    expect(peer.view.state.doc.toString()).toBe("h")

    // Remote peer-A sends sequential patches: e, l, l, o
    const baseTs = Date.now() + 100_000
    for (let i = 0; i < 4; i++) {
      const char = "ello"[i]!
      const hlc: Hlc = { ts: baseTs + i, count: 0, peerId: "peer-A" }
      const action = makePatchAction("peer-A", nodeId, char, hlc)
      handleRemoteMessage(actionMsg(action), peer.relayConfig)
    }

    expect(reconstruct(peer.getDocState())).toBe("hello")
    expect(peer.view.state.doc.toString()).toBe("hello")
    // Only 2 nodes: ROOT + 1 run (not 5)
    expect(peer.getDocState().nodes.size).toBe(2)
  })

  it("patch on a deleted run is a no-op", () => {
    const peer = createTestPeer("peer-B")

    // Insert "abc" then delete it
    const { nodeId } = peer.localInsertRun("abc")
    peer.relayConfig.dispatch({
      type: "DELETE_RANGE",
      runId: nodeId,
      offset: 0,
      count: 3,
    })
    peer.view.dispatch({
      changes: { from: 0, to: 3 },
      effects: setIdMapEffect.of(peer.getDocState().index.spans),
      annotations: isRemote.of(true),
    })
    expect(peer.view.state.doc.toString()).toBe("")

    // Remote patch should be no-op
    const senderHlc: Hlc = { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" }
    const action = makePatchAction("peer-A", nodeId, "xyz", senderHlc)
    handleRemoteMessage(actionMsg(action), peer.relayConfig)

    expect(reconstruct(peer.getDocState())).toBe("")
    expect(peer.view.state.doc.toString()).toBe("")
  })

  it("patch correctly inserts text at the end of a run followed by another run", () => {
    const peer = createTestPeer("peer-B")

    // Insert "abc" then "xyz" (two runs)
    const { nodeId: abcId } = peer.localInsertRun("abc")
    peer.localInsertRun("xyz")
    expect(peer.view.state.doc.toString()).toBe("abcxyz")

    // Remote patch appends "DEF" to the "abc" run
    const senderHlc: Hlc = { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" }
    const action = makePatchAction("peer-A", abcId, "DEF", senderHlc)
    handleRemoteMessage(actionMsg(action), peer.relayConfig)

    // "DEF" should appear between "abc" and "xyz"
    expect(reconstruct(peer.getDocState())).toBe("abcDEFxyz")
    expect(peer.view.state.doc.toString()).toBe("abcDEFxyz")
  })
})

// ---------------------------------------------------------------------------
// splitParentAt tests (mid-run insert on unsplit peer)
// ---------------------------------------------------------------------------

/**
 * Create an ebb-native Action containing a "put" Update with splitParentAt.
 * This simulates what happens when a peer inserts text in the middle of
 * another peer's run: the sender splits locally and broadcasts the insert
 * with the split offset so the receiver can perform the same split.
 */
const makeInsertWithSplitAction = (
  peerId: string,
  node: RunNode,
  hlc: Hlc,
  splitParentAt: number,
): Action => {
  const id = `test_act_${testIdCounter++}`
  return {
    id,
    actor_id: peerId,
    hlc,
    updates: [
      {
        id: `test_upd_${testIdCounter++}`,
        subject_id: node.id,
        subject_type: "run",
        method: "put",
        data: {
          fields: {
            run: { type: "causal_tree_run", value: node, hlc, splitParentAt },
          },
        },
      },
    ],
  }
}

describe("handleRemoteMessage — splitParentAt (mid-run insert convergence)", () => {
  it("reproduces the exact bug: 'This is a test' + mid-run insert 'a split'", () => {
    // Peer-A has "This is a test" as a single unsplit run (via EXTEND_RUN coalescing)
    const peerA = createTestPeer("peer-A")
    const { nodeId: runId } = peerA.localInsertRun("This is a test")
    expect(peerA.view.state.doc.toString()).toBe("This is a test")

    // Peer-B would have split this run at offset 7 ("This is" | " a test")
    // and inserted " a split" as a child of the left half (parentId = runId).
    // The broadcast includes splitParentAt: 7.
    const senderHlc: Hlc = { ts: Date.now() + 200_000, count: 0, peerId: "peer-B" }
    const insertNode = makeRunNode(senderHlc.ts, 0, "peer-B", " a split", runId)
    const action = makeInsertWithSplitAction("peer-B", insertNode, senderHlc, 7)

    handleRemoteMessage(actionMsg(action), peerA.relayConfig)

    // Peer-A should now show "This is a split a test" — matching Peer-B
    expect(reconstruct(peerA.getDocState())).toBe("This is a split a test")
    expect(peerA.view.state.doc.toString()).toBe("This is a split a test")
  })

  it("splits the parent run on the receiving peer before inserting", () => {
    const peer = createTestPeer("peer-B")
    const { nodeId: runId } = peer.localInsertRun("abcdef")
    expect(peer.view.state.doc.toString()).toBe("abcdef")

    // Remote peer inserts "XY" in the middle of "abcdef" at offset 3
    // Sender split at offset 3: "abc" | "def", then inserted "XY" as child of "abc"
    const senderHlc: Hlc = { ts: Date.now() + 200_000, count: 0, peerId: "peer-A" }
    const insertNode = makeRunNode(senderHlc.ts, 0, "peer-A", "XY", runId)
    const action = makeInsertWithSplitAction("peer-A", insertNode, senderHlc, 3)

    handleRemoteMessage(actionMsg(action), peer.relayConfig)

    // Should be "abcXYdef" — insert lands between the split halves
    expect(reconstruct(peer.getDocState())).toBe("abcXYdef")
    expect(peer.view.state.doc.toString()).toBe("abcXYdef")
  })

  it("split is idempotent — already-split run is not split again", () => {
    const peer = createTestPeer("peer-B")
    const { nodeId: runId } = peer.localInsertRun("abcdef")

    // Manually split the run at offset 3 (simulating a prior local edit)
    peer.relayConfig.dispatch({ type: "SPLIT", runId, offset: 3 })
    peer.view.dispatch({
      effects: setIdMapEffect.of(peer.getDocState().index.spans),
      annotations: isRemote.of(true),
    })

    const nodeCountBefore = peer.getDocState().nodes.size

    // Remote insert with splitParentAt: 3 — should not create a duplicate split
    const senderHlc: Hlc = { ts: Date.now() + 200_000, count: 0, peerId: "peer-A" }
    const insertNode = makeRunNode(senderHlc.ts, 0, "peer-A", "XY", runId)
    const action = makeInsertWithSplitAction("peer-A", insertNode, senderHlc, 3)

    handleRemoteMessage(actionMsg(action), peer.relayConfig)

    // Only 1 new node added (the insert), not 2 (no duplicate split node)
    expect(peer.getDocState().nodes.size).toBe(nodeCountBefore + 1)
    expect(reconstruct(peer.getDocState())).toBe("abcXYdef")
    expect(peer.view.state.doc.toString()).toBe("abcXYdef")
  })

  it("insert without splitParentAt works at end of run (no split needed)", () => {
    const peer = createTestPeer("peer-B")
    const { nodeId: runId } = peer.localInsertRun("hello")
    expect(peer.view.state.doc.toString()).toBe("hello")

    // Remote insert at end of run — no splitParentAt needed
    const senderHlc: Hlc = { ts: Date.now() + 200_000, count: 0, peerId: "peer-A" }
    const insertNode = makeRunNode(senderHlc.ts, 0, "peer-A", " world", runId)
    const action = makeInsertAction("peer-A", insertNode, senderHlc)

    handleRemoteMessage(actionMsg(action), peer.relayConfig)

    expect(reconstruct(peer.getDocState())).toBe("hello world")
    expect(peer.view.state.doc.toString()).toBe("hello world")
  })

  it("extended run is correctly split by remote insert with splitParentAt", () => {
    // This tests the core EXTEND_RUN + splitParentAt interaction:
    // Peer-A types "abcdef" character-by-character (one run via EXTEND_RUN),
    // then Peer-B inserts mid-run and the split propagates correctly.
    const peerA = createTestPeer("peer-A")
    const peerB = createTestPeer("peer-B")

    // Both start with "abcdef" (one run, simulating EXTEND_RUN coalescing)
    const baseTs = Date.now() + 1_000_000
    const baseNode = makeRunNode(baseTs, 0, "peer-A", "abcdef", ROOT_ID)

    for (const peer of [peerA, peerB]) {
      peer.relayConfig.dispatch({ type: "INSERT_RUN", node: baseNode })
      peer.view.dispatch({
        changes: { from: 0, insert: "abcdef" },
        effects: setIdMapEffect.of(peer.getDocState().index.spans),
        annotations: isRemote.of(true),
      })
    }

    // Peer-B splits at offset 3 and inserts "XY" (like typing in the middle)
    // Locally on Peer-B: "abc" | "def" → "abc" + "XY" + "def"
    peerB.relayConfig.dispatch({ type: "SPLIT", runId: baseNode.id, offset: 3 })
    const hlcX: Hlc = { ts: baseTs + 2, count: 0, peerId: "peer-B" }
    const nodeX = makeRunNode(baseTs + 2, 0, "peer-B", "XY", baseNode.id)
    peerB.relayConfig.dispatch({ type: "INSERT_RUN", node: nodeX })
    peerB.view.dispatch({
      changes: { from: 3, insert: "XY" },
      effects: setIdMapEffect.of(peerB.getDocState().index.spans),
      annotations: isRemote.of(true),
    })
    expect(peerB.view.state.doc.toString()).toBe("abcXYdef")

    // Peer-A receives the insert with splitParentAt: 3
    const actionX = makeInsertWithSplitAction("peer-B", nodeX, hlcX, 3)
    handleRemoteMessage(actionMsg(actionX), peerA.relayConfig)

    // Both peers must converge to "abcXYdef"
    expect(reconstruct(peerA.getDocState())).toBe("abcXYdef")
    expect(peerA.view.state.doc.toString()).toBe("abcXYdef")
    expect(reconstruct(peerB.getDocState())).toBe("abcXYdef")
  })
})
