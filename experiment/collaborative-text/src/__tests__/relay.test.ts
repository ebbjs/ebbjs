/**
 * Relay tests (Run-Optimized)
 *
 * Tests the handleRemoteMessage function directly (pure-ish, no
 * BroadcastChannel needed). Uses a real CM EditorView in happy-dom
 * to verify that remote operations apply correctly.
 *
 * Key changes from per-character relay tests:
 * - Messages are INSERT_RUN / DELETE_RANGE (not INSERT / DELETE)
 * - RunNode.text can be multi-character
 * - Remote inserts apply the full run text in one CM transaction
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
  type InsertRunMessage,
  type DeleteRangeMessage,
  type PresenceMessage,
  type RelayConfig,
} from "../relay.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

describe("handleRemoteMessage — INSERT_RUN", () => {
  it("applies a remote insert to an empty document", () => {
    const peer = createTestPeer("peer-B")
    const senderHlc: Hlc = { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" }
    const node = makeRunNode(senderHlc.ts, 0, "peer-A", "hello", ROOT_ID)

    const message: InsertRunMessage = {
      type: "INSERT_RUN",
      peerId: "peer-A",
      node,
      hlc: senderHlc,
    }

    handleRemoteMessage(message, peer.relayConfig)

    expect(reconstruct(peer.getDocState())).toBe("hello")
    expect(peer.view.state.doc.toString()).toBe("hello")
  })

  it("applies a multi-character remote insert in one CM transaction", () => {
    const peer = createTestPeer("peer-B")
    const senderHlc: Hlc = { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" }
    const node = makeRunNode(senderHlc.ts, 0, "peer-A", "hello world", ROOT_ID)

    handleRemoteMessage(
      { type: "INSERT_RUN", peerId: "peer-A", node, hlc: senderHlc },
      peer.relayConfig,
    )

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

    handleRemoteMessage(
      { type: "INSERT_RUN", peerId: "peer-A", node: bNode, hlc: senderHlc },
      peer.relayConfig,
    )

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

    handleRemoteMessage(
      { type: "INSERT_RUN", peerId: "peer-A", node, hlc: remoteFutureHlc },
      peer.relayConfig,
    )

    // After merge, local HLC should be >= remote HLC
    expect(peer.hlcRef.current.ts).toBeGreaterThanOrEqual(remoteFutureHlc.ts)
  })

  it("is idempotent — duplicate remote insert is a no-op for both tree and CM", () => {
    const peer = createTestPeer("peer-B")
    const senderHlc: Hlc = { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" }
    const node = makeRunNode(senderHlc.ts, 0, "peer-A", "hello", ROOT_ID)
    const message: InsertRunMessage = {
      type: "INSERT_RUN",
      peerId: "peer-A",
      node,
      hlc: senderHlc,
    }

    handleRemoteMessage(message, peer.relayConfig)
    handleRemoteMessage(message, peer.relayConfig)

    // Causal Tree is correct — no duplicate
    expect(reconstruct(peer.getDocState())).toBe("hello")
    // CM view is also correct — the relay's idempotency guard skips
    // the second applyRemoteInsert, so no duplicate text
    expect(peer.view.state.doc.toString()).toBe("hello")
  })
})

describe("handleRemoteMessage — DELETE_RANGE", () => {
  it("applies a remote delete", () => {
    const peer = createTestPeer("peer-B")
    const { nodeId } = peer.localInsertRun("abc")
    expect(peer.view.state.doc.toString()).toBe("abc")

    const senderHlc: Hlc = { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" }

    // Delete "b" from "abc" (offset 1, count 1)
    handleRemoteMessage(
      {
        type: "DELETE_RANGE",
        peerId: "peer-A",
        runId: nodeId,
        offset: 1,
        count: 1,
        hlc: senderHlc,
      },
      peer.relayConfig,
    )

    expect(reconstruct(peer.getDocState())).toBe("ac")
    expect(peer.view.state.doc.toString()).toBe("ac")
  })

  it("applies a remote full-run delete", () => {
    const peer = createTestPeer("peer-B")
    const { nodeId } = peer.localInsertRun("hello")
    expect(peer.view.state.doc.toString()).toBe("hello")

    const senderHlc: Hlc = { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" }

    handleRemoteMessage(
      {
        type: "DELETE_RANGE",
        peerId: "peer-A",
        runId: nodeId,
        offset: 0,
        count: 5,
        hlc: senderHlc,
      },
      peer.relayConfig,
    )

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

    handleRemoteMessage(
      {
        type: "DELETE_RANGE",
        peerId: "peer-A",
        runId: nodeId,
        offset: 0,
        count: 1,
        hlc: remoteFutureHlc,
      },
      peer.relayConfig,
    )

    expect(peer.hlcRef.current.ts).toBeGreaterThanOrEqual(remoteFutureHlc.ts)
  })
})

describe("handleRemoteMessage — own message filtering", () => {
  it("ignores messages from the same peerId", () => {
    const peer = createTestPeer("peer-A")
    const node = makeRunNode(Date.now() + 100_000, 0, "peer-A", "x", ROOT_ID)

    handleRemoteMessage(
      {
        type: "INSERT_RUN",
        peerId: "peer-A", // same as local peer
        node,
        hlc: { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" },
      },
      peer.relayConfig,
    )

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
      headId: "some-id",
    }

    handleRemoteMessage(message, configWithPresence)

    expect(updatePresence).toHaveBeenCalledWith("peer-A", "some-id", "some-id")
  })

  it("does not crash if updatePresence is not provided", () => {
    const peer = createTestPeer("peer-B")

    const message: PresenceMessage = {
      type: "PRESENCE",
      peerId: "peer-A",
      anchorId: "some-id",
      headId: "some-id",
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

    // Now exchange messages:
    // Peer A receives Peer B's YY
    handleRemoteMessage(
      { type: "INSERT_RUN", peerId: "peer-B", node: nodeY, hlc: hlcY },
      peerA.relayConfig,
    )

    // Peer B receives Peer A's XX
    handleRemoteMessage(
      { type: "INSERT_RUN", peerId: "peer-A", node: nodeX, hlc: hlcX },
      peerB.relayConfig,
    )

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

  it("duplicate messages during concurrent conflict are handled correctly", () => {
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

    // Peer B sends "XX" after "a"
    const hlcX: Hlc = { ts: baseTs + 1, count: 0, peerId: "peer-B" }
    const nodeX = makeRunNode(baseTs + 1, 0, "peer-B", "XX", baseNode.id)
    const msgX: InsertRunMessage = {
      type: "INSERT_RUN",
      peerId: "peer-B",
      node: nodeX,
      hlc: hlcX,
    }

    // Peer A receives the message twice (simulating network replay)
    handleRemoteMessage(msgX, peerA.relayConfig)
    handleRemoteMessage(msgX, peerA.relayConfig)

    // Should be "aXX" not "aXXXX"
    expect(reconstruct(peerA.getDocState())).toBe("aXX")
    expect(peerA.view.state.doc.toString()).toBe("aXX")
  })
})

describe("two-peer simulation (run-level)", () => {
  it("syncs a sequence of run inserts between two peers", () => {
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

    // Broadcast to B
    handleRemoteMessage(
      { type: "INSERT_RUN", peerId: "peer-A", node: nodeHello, hlc: aHlc1 },
      peerB.relayConfig,
    )

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

    handleRemoteMessage(
      { type: "INSERT_RUN", peerId: "peer-A", node: nodeWorld, hlc: aHlc2 },
      peerB.relayConfig,
    )

    // Both peers should show "hello world"
    expect(reconstruct(peerA.getDocState())).toBe("hello world")
    expect(reconstruct(peerB.getDocState())).toBe("hello world")
    expect(peerA.view.state.doc.toString()).toBe("hello world")
    expect(peerB.view.state.doc.toString()).toBe("hello world")
  })
})
