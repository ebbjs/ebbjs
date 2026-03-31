/**
 * Relay tests
 *
 * Tests the handleRemoteMessage function directly (pure-ish, no
 * BroadcastChannel needed). Uses a real CM EditorView in happy-dom
 * to verify that remote operations apply correctly.
 *
 * @vitest-environment happy-dom
 */

import { describe, expect, it, vi } from "vitest"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { createHlc, increment, toString, type Hlc } from "../hlc.ts"
import {
  buildPositionMap,
  createDocState,
  docReducer,
  reconstruct,
  ROOT_ID,
  type CharNode,
  type DocAction,
  type DocState,
} from "../causal-tree.ts"
import {
  createBridgeExtension,
  createIdMapField,
  isRemote,
  type BridgeConfig,
} from "../cm-bridge.ts"
import {
  handleRemoteMessage,
  type InsertMessage,
  type DeleteMessage,
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

  // Bridge config (for local edits — not used in relay tests, but needed for CM setup)
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
    /** Helper: locally insert text by directly manipulating the tree + CM */
    localInsert: (text: string) => {
      for (let i = 0; i < text.length; i++) {
        hlcRef.current = increment(hlcRef.current)
        const nodeId = toString(hlcRef.current)
        const posMap = buildPositionMap(docState)
        const parentId =
          posMap.idAtPosition.length > 0
            ? posMap.idAtPosition[posMap.idAtPosition.length - 1]!
            : ROOT_ID

        const node: CharNode = {
          id: nodeId,
          value: text[i]!,
          parentId,
          deleted: false,
        }
        docState = docReducer(docState, { type: "INSERT", node })

        // Apply to CM — the ID map StateField auto-rebuilds on docChanged
        const pos = view.state.doc.length
        view.dispatch({
          changes: { from: pos, insert: text[i]! },
          annotations: isRemote.of(true),
        })
      }
    },
  }
}

/** Create a CharNode with a specific HLC. */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleRemoteMessage — INSERT", () => {
  it("applies a remote insert to an empty document", () => {
    const peer = createTestPeer("peer-B")
    const senderHlc: Hlc = { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" }
    const node = makeNode(senderHlc.ts, 0, "peer-A", "a", ROOT_ID)

    const message: InsertMessage = {
      type: "INSERT",
      peerId: "peer-A",
      node,
      hlc: senderHlc,
    }

    handleRemoteMessage(message, peer.relayConfig)

    expect(reconstruct(peer.getDocState())).toBe("a")
    expect(peer.view.state.doc.toString()).toBe("a")
  })

  it("applies a remote insert at the correct position in an existing document", () => {
    const peer = createTestPeer("peer-B")
    // Locally insert "ac"
    peer.localInsert("ac")
    expect(peer.view.state.doc.toString()).toBe("ac")

    // Get the ID of "a" so we can parent the remote insert to it
    const posMap = buildPositionMap(peer.getDocState())
    const aId = posMap.idAtPosition[0]!

    // Remote peer-A inserts "b" after "a"
    const senderHlc: Hlc = { ts: Date.now() + 200_000, count: 0, peerId: "peer-A" }
    const bNode = makeNode(senderHlc.ts, 0, "peer-A", "b", aId)

    handleRemoteMessage(
      { type: "INSERT", peerId: "peer-A", node: bNode, hlc: senderHlc },
      peer.relayConfig,
    )

    // "b" is child of "a", with higher HLC than "c" (which is also child of "a")
    // Higher HLC first among siblings → b comes before c
    expect(reconstruct(peer.getDocState())).toBe("abc")
    expect(peer.view.state.doc.toString()).toBe("abc")
  })

  it("merges the remote HLC into the local HLC", () => {
    const peer = createTestPeer("peer-B")
    const localHlcBefore = { ...peer.hlcRef.current }

    const remoteFutureHlc: Hlc = {
      ts: Date.now() + 500_000,
      count: 10,
      peerId: "peer-A",
    }
    const node = makeNode(remoteFutureHlc.ts, 10, "peer-A", "x", ROOT_ID)

    handleRemoteMessage(
      { type: "INSERT", peerId: "peer-A", node, hlc: remoteFutureHlc },
      peer.relayConfig,
    )

    // After merge, local HLC should be >= remote HLC
    expect(peer.hlcRef.current.ts).toBeGreaterThanOrEqual(remoteFutureHlc.ts)
  })

  it("is idempotent — duplicate remote insert is a no-op for both tree and CM", () => {
    const peer = createTestPeer("peer-B")
    const senderHlc: Hlc = { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" }
    const node = makeNode(senderHlc.ts, 0, "peer-A", "a", ROOT_ID)
    const message: InsertMessage = {
      type: "INSERT",
      peerId: "peer-A",
      node,
      hlc: senderHlc,
    }

    handleRemoteMessage(message, peer.relayConfig)
    handleRemoteMessage(message, peer.relayConfig)

    // Causal Tree is correct — no duplicate
    expect(reconstruct(peer.getDocState())).toBe("a")
    // CM view is also correct — the relay's idempotency guard skips
    // the second applyRemoteInsert, so no duplicate character
    expect(peer.view.state.doc.toString()).toBe("a")
  })
})

describe("handleRemoteMessage — DELETE", () => {
  it("applies a remote delete", () => {
    const peer = createTestPeer("peer-B")
    peer.localInsert("abc")
    expect(peer.view.state.doc.toString()).toBe("abc")

    // Get the ID of "b"
    const posMap = buildPositionMap(peer.getDocState())
    const bId = posMap.idAtPosition[1]!

    const senderHlc: Hlc = { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" }

    handleRemoteMessage(
      { type: "DELETE", peerId: "peer-A", nodeId: bId, hlc: senderHlc },
      peer.relayConfig,
    )

    expect(reconstruct(peer.getDocState())).toBe("ac")
    expect(peer.view.state.doc.toString()).toBe("ac")
  })

  it("handles delete of already-deleted node gracefully", () => {
    const peer = createTestPeer("peer-B")
    peer.localInsert("a")

    const posMap = buildPositionMap(peer.getDocState())
    const aId = posMap.idAtPosition[0]!

    const senderHlc: Hlc = { ts: Date.now() + 100_000, count: 0, peerId: "peer-A" }
    const msg: DeleteMessage = {
      type: "DELETE",
      peerId: "peer-A",
      nodeId: aId,
      hlc: senderHlc,
    }

    // Delete once
    handleRemoteMessage(msg, peer.relayConfig)
    expect(reconstruct(peer.getDocState())).toBe("")

    // Delete again — should not crash or change anything
    handleRemoteMessage(msg, peer.relayConfig)
    expect(reconstruct(peer.getDocState())).toBe("")
  })

  it("merges the remote HLC on delete", () => {
    const peer = createTestPeer("peer-B")
    peer.localInsert("a")

    const posMap = buildPositionMap(peer.getDocState())
    const aId = posMap.idAtPosition[0]!

    const remoteFutureHlc: Hlc = {
      ts: Date.now() + 500_000,
      count: 5,
      peerId: "peer-A",
    }

    handleRemoteMessage(
      { type: "DELETE", peerId: "peer-A", nodeId: aId, hlc: remoteFutureHlc },
      peer.relayConfig,
    )

    expect(peer.hlcRef.current.ts).toBeGreaterThanOrEqual(remoteFutureHlc.ts)
  })
})

describe("handleRemoteMessage — own message filtering", () => {
  it("ignores messages from the same peerId", () => {
    const peer = createTestPeer("peer-A")
    const node = makeNode(Date.now() + 100_000, 0, "peer-A", "x", ROOT_ID)

    handleRemoteMessage(
      {
        type: "INSERT",
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
// Slice 3: Concurrent Conflict (Tie-Break)
// ---------------------------------------------------------------------------

describe("concurrent conflict — tie-break convergence", () => {
  it("two peers inserting at the same position converge to the same document", () => {
    const peerA = createTestPeer("peer-A")
    const peerB = createTestPeer("peer-B")

    // Both peers start with "ab" (a→ROOT, b→a)
    // Use a shared base timestamp far in the future so HLC comparisons are stable
    const baseTs = Date.now() + 1_000_000

    const nodeA = makeNode(baseTs, 0, "peer-A", "a", ROOT_ID)
    const nodeB = makeNode(baseTs + 1, 0, "peer-A", "b", nodeA.id)

    // Apply base state to both peers
    for (const peer of [peerA, peerB]) {
      peer.relayConfig.dispatch({ type: "INSERT", node: nodeA })
      peer.relayConfig.dispatch({ type: "INSERT", node: nodeB })
      // ID map auto-rebuilds on docChanged
      peer.view.dispatch({
        changes: { from: 0, insert: "ab" },
        annotations: isRemote.of(true),
      })
    }

    // Verify both start with "ab"
    expect(peerA.view.state.doc.toString()).toBe("ab")
    expect(peerB.view.state.doc.toString()).toBe("ab")

    // Peer A inserts "X" after "a" (parent = nodeA.id)
    const hlcX: Hlc = { ts: baseTs + 2, count: 0, peerId: "peer-A" }
    const nodeX = makeNode(baseTs + 2, 0, "peer-A", "X", nodeA.id)

    // Apply X locally on Peer A
    peerA.relayConfig.dispatch({ type: "INSERT", node: nodeX })
    // ID map auto-rebuilds on docChanged
    peerA.view.dispatch({
      changes: { from: 1, insert: "X" },
      annotations: isRemote.of(true),
    })
    expect(peerA.view.state.doc.toString()).toBe("aXb")

    // Peer B inserts "Y" after "a" (parent = nodeA.id) — BEFORE receiving X
    const hlcY: Hlc = { ts: baseTs + 2, count: 0, peerId: "peer-B" }
    const nodeY = makeNode(baseTs + 2, 0, "peer-B", "Y", nodeA.id)

    // Apply Y locally on Peer B
    peerB.relayConfig.dispatch({ type: "INSERT", node: nodeY })
    peerB.view.dispatch({
      changes: { from: 1, insert: "Y" },
      annotations: isRemote.of(true),
    })
    expect(peerB.view.state.doc.toString()).toBe("aYb")

    // Now exchange messages:
    // Peer A receives Peer B's Y
    handleRemoteMessage(
      { type: "INSERT", peerId: "peer-B", node: nodeY, hlc: hlcY },
      peerA.relayConfig,
    )

    // Peer B receives Peer A's X
    handleRemoteMessage(
      { type: "INSERT", peerId: "peer-A", node: nodeX, hlc: hlcX },
      peerB.relayConfig,
    )

    // Both peers must converge to the same document
    const textA = reconstruct(peerA.getDocState())
    const textB = reconstruct(peerB.getDocState())
    expect(textA).toBe(textB)

    // Y has higher HLC (peer-B > peer-A at same ts:count) → Y comes first
    // b (ts=baseTs+1) has lower HLC than both X and Y (ts=baseTs+2) → b is last among a's children
    expect(textA).toBe("aYXb")

    // CM views must also match
    expect(peerA.view.state.doc.toString()).toBe("aYXb")
    expect(peerB.view.state.doc.toString()).toBe("aYXb")
  })

  it("duplicate messages during concurrent conflict are handled correctly", () => {
    const peerA = createTestPeer("peer-A")
    const peerB = createTestPeer("peer-B")

    // Insert base character "a"
    const baseTs = Date.now() + 1_000_000
    const nodeA = makeNode(baseTs, 0, "peer-A", "a", ROOT_ID)

    for (const peer of [peerA, peerB]) {
      peer.relayConfig.dispatch({ type: "INSERT", node: nodeA })
      // ID map auto-rebuilds on docChanged
      peer.view.dispatch({
        changes: { from: 0, insert: "a" },
        annotations: isRemote.of(true),
      })
    }

    // Peer B sends "X" after "a"
    const hlcX: Hlc = { ts: baseTs + 1, count: 0, peerId: "peer-B" }
    const nodeX = makeNode(baseTs + 1, 0, "peer-B", "X", nodeA.id)
    const msgX: InsertMessage = {
      type: "INSERT",
      peerId: "peer-B",
      node: nodeX,
      hlc: hlcX,
    }

    // Peer A receives the message twice (simulating network replay)
    handleRemoteMessage(msgX, peerA.relayConfig)
    handleRemoteMessage(msgX, peerA.relayConfig)

    // Should be "aX" not "aXX"
    expect(reconstruct(peerA.getDocState())).toBe("aX")
    expect(peerA.view.state.doc.toString()).toBe("aX")
  })
})

describe("two-peer simulation", () => {
  it("syncs a sequence of inserts between two peers", () => {
    const peerA = createTestPeer("peer-A")
    const peerB = createTestPeer("peer-B")

    // Peer A types "hi"
    // Simulate: A inserts locally, then broadcasts to B
    const aHlc1 = increment(peerA.hlcRef.current)
    peerA.hlcRef.current = aHlc1
    const nodeH: CharNode = {
      id: toString(aHlc1),
      value: "h",
      parentId: ROOT_ID,
      deleted: false,
    }

    // Apply locally on A — ID map auto-rebuilds on docChanged
    peerA.relayConfig.dispatch({ type: "INSERT", node: nodeH })
    peerA.view.dispatch({
      changes: { from: 0, insert: "h" },
      annotations: isRemote.of(true),
    })

    // Broadcast to B
    handleRemoteMessage(
      { type: "INSERT", peerId: "peer-A", node: nodeH, hlc: aHlc1 },
      peerB.relayConfig,
    )

    // Second char: "i" parented to "h"
    const aHlc2 = increment(peerA.hlcRef.current)
    peerA.hlcRef.current = aHlc2
    const nodeI: CharNode = {
      id: toString(aHlc2),
      value: "i",
      parentId: nodeH.id,
      deleted: false,
    }

    peerA.relayConfig.dispatch({ type: "INSERT", node: nodeI })
    peerA.view.dispatch({
      changes: { from: 1, insert: "i" },
      annotations: isRemote.of(true),
    })

    handleRemoteMessage(
      { type: "INSERT", peerId: "peer-A", node: nodeI, hlc: aHlc2 },
      peerB.relayConfig,
    )

    // Both peers should show "hi"
    expect(reconstruct(peerA.getDocState())).toBe("hi")
    expect(reconstruct(peerB.getDocState())).toBe("hi")
    expect(peerA.view.state.doc.toString()).toBe("hi")
    expect(peerB.view.state.doc.toString()).toBe("hi")
  })
})
