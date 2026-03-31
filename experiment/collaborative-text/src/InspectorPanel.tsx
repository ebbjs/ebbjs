/**
 * Inspector Panel (Run-Optimized)
 *
 * A tabbed "Under the Hood" panel rendered below the two editors. Three tabs:
 *
 * 1. Event Log — scrolling stream of INSERT_RUN/DELETE_RANGE/PRESENCE messages
 * 2. Causal Tree — indented text visualization of the tree data structure
 * 3. HLC State — live display of each peer's Hybrid Logical Clock
 *
 * Each tab includes a short explanatory blurb so the panel doubles as
 * documentation of how the system works.
 */

import { useEffect, useRef, useState } from "react"
import {
  useInspectorStore,
  clearEvents,
  type InspectorEvent,
} from "./inspector-store.ts"
import { ROOT_ID, reconstruct, type DocState } from "./causal-tree.ts"
import type { Hlc } from "./hlc.ts"

// ---------------------------------------------------------------------------
// Tab type
// ---------------------------------------------------------------------------

type Tab = "events" | "tree" | "hlc"

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const InspectorPanel = () => {
  const [activeTab, setActiveTab] = useState<Tab>("events")
  const store = useInspectorStore()

  const tabs: { id: Tab; label: string }[] = [
    { id: "events", label: "Event Log" },
    { id: "tree", label: "Causal Tree" },
    { id: "hlc", label: "HLC State" },
  ]

  return (
    <div className="w-full max-w-5xl">
      <div className="border border-gray-300 rounded-lg overflow-hidden bg-white shadow-sm">
        {/* Tab bar */}
        <div className="flex border-b border-gray-200 bg-gray-50">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? "text-gray-900 bg-white border-b-2 border-blue-500"
                  : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="max-h-96 overflow-y-auto">
          {activeTab === "events" && (
            <EventLogTab events={store.events} />
          )}
          {activeTab === "tree" && (
            <CausalTreeTab docStates={store.docStates} />
          )}
          {activeTab === "hlc" && (
            <HlcStateTab hlcStates={store.hlcStates} />
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Event Log tab
// ---------------------------------------------------------------------------

type PeerFilter = "all" | "peer-A" | "peer-B"

const EventLogTab = ({ events }: { events: readonly InspectorEvent[] }) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [peerFilter, setPeerFilter] = useState<PeerFilter>("all")

  const filteredEvents =
    peerFilter === "all"
      ? events
      : events.filter((e) => e.peerId === peerFilter)

  // Auto-scroll the outer tab container to bottom when new events arrive
  useEffect(() => {
    const el = scrollRef.current?.closest(".overflow-y-auto") as HTMLElement | null
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [filteredEvents.length])

  const filterButtons: { id: PeerFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "peer-A", label: "peer-A" },
    { id: "peer-B", label: "peer-B" },
  ]

  return (
    <div className="p-4">
      <p className="text-sm text-gray-500 mb-3 leading-relaxed">
        Every edit generates a run-level operation (INSERT_RUN or DELETE_RANGE)
        that's broadcast to the other peer via BroadcastChannel. Each operation
        carries a{" "}
        <span className="font-semibold">Hybrid Logical Clock</span> timestamp
        that uniquely identifies the run and determines its position in the
        document. Pasting "hello world" = 1 message, not 11.
      </p>

      {events.length === 0 ? (
        <div className="text-sm text-gray-400 text-center py-6">
          No events yet. Start typing in one of the editors above.
        </div>
      ) : (
        <>
          {/* Toolbar: filter + clear */}
          <div className="flex items-center gap-2 mb-2">
            <div className="flex gap-1">
              {filterButtons.map((btn) => {
                const isActive = peerFilter === btn.id
                const colorClass =
                  btn.id === "peer-A"
                    ? isActive
                      ? "bg-blue-500 text-white"
                      : "bg-gray-100 text-gray-500 hover:bg-blue-50 hover:text-blue-600"
                    : btn.id === "peer-B"
                      ? isActive
                        ? "bg-orange-500 text-white"
                        : "bg-gray-100 text-gray-500 hover:bg-orange-50 hover:text-orange-600"
                      : isActive
                        ? "bg-gray-700 text-white"
                        : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                return (
                  <button
                    key={btn.id}
                    onClick={() => setPeerFilter(btn.id)}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors ${colorClass}`}
                  >
                    {btn.label}
                  </button>
                )
              })}
            </div>
            <div className="flex-1" />
            <button
              onClick={clearEvents}
              className="text-[11px] text-gray-400 hover:text-gray-600 transition-colors"
            >
              Clear log
            </button>
          </div>
          <div
            ref={scrollRef}
            className="font-mono text-xs space-y-0.5"
          >
            {filteredEvents.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

const EventRow = ({ event }: { event: InspectorEvent }) => {
  const { message, direction, peerId } = event
  const isPeerA = peerId === "peer-A"
  const color = isPeerA ? "text-blue-600" : "text-orange-600"
  const bgColor = isPeerA ? "bg-blue-50" : "bg-orange-50"
  const arrow = direction === "sent" ? "\u2192" : "\u2190"
  const dirLabel = direction === "sent" ? "sent" : "recv"

  const time = new Date(event.timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  } as Intl.DateTimeFormatOptions)

  let detail = ""
  switch (message.type) {
    case "INSERT_RUN": {
      const text = message.node.text.length <= 20
        ? message.node.text.replace(/\n/g, "\\n")
        : message.node.text.slice(0, 20).replace(/\n/g, "\\n") + "..."
      const shortId = abbreviateId(message.node.id)
      const shortParent =
        message.node.parentId === ROOT_ID
          ? "ROOT"
          : abbreviateId(message.node.parentId)
      detail = `"${text}" (${message.node.text.length} chars) id=${shortId} parent=${shortParent}`
      break
    }
    case "DELETE_RANGE": {
      const shortId = abbreviateId(message.runId)
      detail = `id=${shortId} offset=${message.offset} count=${message.count}`
      break
    }
    case "PRESENCE": {
      const anchor =
        message.anchorId === ROOT_ID
          ? "ROOT"
          : abbreviateId(message.anchorId)
      const head =
        message.headId === ROOT_ID ? "ROOT" : abbreviateId(message.headId)
      detail = `anchor=${anchor} head=${head}`
      break
    }
  }

  const typeBadgeColor =
    message.type === "INSERT_RUN"
      ? "bg-green-100 text-green-700"
      : message.type === "DELETE_RANGE"
        ? "bg-red-100 text-red-700"
        : "bg-purple-100 text-purple-700"

  return (
    <div
      className={`flex items-center gap-2 px-2 py-0.5 rounded ${bgColor} ${color}`}
    >
      <span className="text-gray-400 w-20 shrink-0">{time}</span>
      <span className="w-6 text-center shrink-0">{arrow}</span>
      <span className="text-gray-400 w-8 shrink-0">{dirLabel}</span>
      <span className={`${color} font-semibold w-12 shrink-0`}>{peerId.replace("peer-", "")}</span>
      <span
        className={`px-1.5 py-0 rounded text-[11px] font-semibold shrink-0 ${typeBadgeColor}`}
      >
        {message.type}
      </span>
      <span className="text-gray-600 truncate">{detail}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Causal Tree tab
// ---------------------------------------------------------------------------

/** A chain of sequential single-child nodes, collapsed into one visual row. */
type ChainSegment = {
  readonly nodes: readonly { id: string; text: string; deleted: boolean; peerId: string }[]
  readonly branches: readonly ChainSegment[] // Children at the end of the chain (or branch point)
}

/**
 * Walk the causal tree from a starting node and collapse sequential
 * single-child runs into ChainSegments. Branches appear when a node
 * has 2+ children (the interesting conflict points).
 */
const buildChains = (docState: DocState, startId: string): readonly ChainSegment[] => {
  const childIds = docState.children.get(startId) ?? []
  if (childIds.length === 0) return []

  return childIds.map((childId) => {
    const nodes: { id: string; text: string; deleted: boolean; peerId: string }[] = []
    let currentId = childId

    // Walk the chain: keep going while the current node has exactly 1 child
    while (true) {
      const node = docState.nodes.get(currentId)
      if (!node) break

      nodes.push({
        id: node.id,
        text: node.text,
        deleted: node.deleted,
        peerId: node.peerId,
      })

      const nextChildren = docState.children.get(currentId) ?? []
      if (nextChildren.length === 1) {
        // Single child — continue the chain
        currentId = nextChildren[0]!
      } else {
        // 0 or 2+ children — end the chain, recurse for branches
        break
      }
    }

    // The last node in the chain may have branches (0 or 2+ children)
    const lastNodeId = nodes[nodes.length - 1]?.id
    const branches = lastNodeId ? buildChains(docState, lastNodeId) : []

    return { nodes, branches }
  })
}

/** Extract the peer name from a node ID (format: "ts:count:peer-X"). */
const extractPeerId = (id: string): string => {
  // Handle split IDs like "ts:count:peer-X:s:offset"
  const parts = id.split(":")
  if (parts.length >= 3) {
    // For split IDs, the peer is at index 2
    return parts[2]!.startsWith("peer-") ? parts[2]! : parts.slice(2).join(":")
  }
  return "?"
}

const CausalTreeTab = ({
  docStates,
}: {
  docStates: Readonly<Record<string, DocState>>
}) => {
  const [selectedPeer, setSelectedPeer] = useState<string>("peer-A")
  const peerIds = Object.keys(docStates).sort()
  const docState = docStates[selectedPeer]

  return (
    <div className="p-4">
      <p className="text-sm text-gray-500 mb-3 leading-relaxed">
        The document is stored as a{" "}
        <span className="font-semibold">Causal Tree</span> — each run is
        a node that points to its parent (the run it was typed after).
        Sequential typing forms a chain; the tree only branches when two peers
        type at the same position (a conflict). Reading in DFS order, skipping
        tombstones, reconstructs the visible text.
      </p>

      {peerIds.length === 0 ? (
        <div className="text-sm text-gray-400 text-center py-6">
          No tree state yet. Start typing in one of the editors above.
        </div>
      ) : (
        <>
          {/* Peer selector */}
          <div className="flex gap-2 mb-3">
            {peerIds.map((id) => (
              <button
                key={id}
                onClick={() => setSelectedPeer(id)}
                className={`px-3 py-1 text-xs rounded transition-colors ${
                  selectedPeer === id
                    ? "bg-gray-800 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {id}
              </button>
            ))}
          </div>

          {docState ? (
            <TreeVisualization docState={docState} />
          ) : (
            <div className="text-sm text-gray-400 text-center py-4">
              Select a peer to view its tree.
            </div>
          )}
        </>
      )}
    </div>
  )
}

const TreeVisualization = ({ docState }: { docState: DocState }) => {
  const treeText = reconstruct(docState)
  const nodeCount = docState.nodes.size - 1 // Exclude ROOT
  const deletedCount = Array.from(docState.nodes.values()).filter(
    (n) => n.deleted && n.id !== ROOT_ID,
  ).length
  const visibleCount = nodeCount - deletedCount

  const chains = buildChains(docState, ROOT_ID)

  return (
    <div>
      {/* Stats bar */}
      <div className="flex gap-4 mb-2 text-[11px] text-gray-500">
        <span>
          <span className="font-semibold">{nodeCount}</span> total runs
        </span>
        <span>
          <span className="font-semibold text-green-600">{visibleCount}</span>{" "}
          visible
        </span>
        <span>
          <span className="font-semibold text-red-400">{deletedCount}</span>{" "}
          tombstoned
        </span>
      </div>

      {/* Tree */}
      <div className="font-mono text-xs bg-gray-50 rounded p-3 max-h-56 overflow-y-auto">
        {/* ROOT row */}
        <div className="text-gray-400 font-semibold mb-1">ROOT</div>

        {chains.length === 0 ? (
          <div className="text-gray-400 pl-4">(empty)</div>
        ) : (
          <ChainList chains={chains} depth={1} />
        )}
      </div>

      {/* Reconstructed text */}
      <div className="mt-2 text-[11px] text-gray-500">
        <span className="font-semibold">Reconstructed: </span>
        <span className="font-mono text-gray-700">
          {treeText.length > 0 ? `"${treeText}"` : "(empty)"}
        </span>
      </div>
    </div>
  )
}

const ChainList = ({
  chains,
  depth,
}: {
  chains: readonly ChainSegment[]
  depth: number
}) => {
  const isBranch = chains.length > 1

  return (
    <div style={{ paddingLeft: `${depth * 14}px` }}>
      {chains.map((chain, i) => (
        <div key={chain.nodes[0]?.id ?? i}>
          {/* Branch connector for multi-child splits */}
          <div className="flex items-start gap-1.5 py-0.5">
            {isBranch && (
              <span className="text-gray-300 shrink-0 select-none">
                {i < chains.length - 1 ? "\u251C" : "\u2514"}
              </span>
            )}
            <ChainRow chain={chain} />
          </div>

          {/* Recurse into branches at the end of this chain */}
          {chain.branches.length > 0 && (
            <ChainList chains={chain.branches} depth={depth + 1} />
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * Render a single collapsed chain as one row.
 *
 * Groups consecutive runs by deleted status into "display runs" so that
 * deleted sections show as struck-through inline within the chain.
 */
const ChainRow = ({ chain }: { chain: ChainSegment }) => {
  const { nodes } = chain
  if (nodes.length === 0) return null

  // Group consecutive nodes by deleted status for inline rendering
  type DisplayRun = { deleted: boolean; text: string; count: number }
  const runs: DisplayRun[] = []
  for (const node of nodes) {
    const charDisplay = node.text.replace(/\n/g, "\u23CE").replace(/ /g, "\u2423")
    const last = runs[runs.length - 1]
    if (last && last.deleted === node.deleted) {
      last.text += charDisplay
      last.count++
    } else {
      runs.push({ deleted: node.deleted, text: charDisplay, count: 1 })
    }
  }

  const totalVisible = nodes.filter((n) => !n.deleted).length
  const totalDeleted = nodes.filter((n) => n.deleted).length
  const totalChars = nodes.reduce((sum, n) => sum + n.text.length, 0)

  // Peer attribution — show which peer(s) authored this chain
  const peers = [...new Set(nodes.map((n) => n.peerId))]
  const peerLabel = peers
    .map((p) => p.replace("peer-", ""))
    .join(", ")

  // Abbreviated IDs for the first and last node
  const firstId = abbreviateId(nodes[0]!.id)
  const lastId = nodes.length > 1 ? abbreviateId(nodes[nodes.length - 1]!.id) : null

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {/* The chain text with inline deleted runs */}
      <span className="font-semibold">
        &quot;
        {runs.map((run, i) =>
          run.deleted ? (
            <span key={i} className="text-red-400 line-through opacity-60">
              {run.text}
            </span>
          ) : (
            <span key={i} className="text-gray-800">
              {run.text}
            </span>
          ),
        )}
        &quot;
      </span>

      {/* Node count badge */}
      <span className="text-[10px] text-gray-400">
        {nodes.length === 1
          ? `1 run (${totalChars} chars)`
          : `${nodes.length} runs (${totalChars} chars)`}
        {totalDeleted > 0 && (
          <span className="text-red-400 ml-0.5">
            ({totalDeleted} del)
          </span>
        )}
      </span>

      {/* Peer attribution */}
      <span
        className={`text-[10px] px-1.5 py-0 rounded ${
          peers.length === 1 && peers[0] === "peer-A"
            ? "bg-blue-100 text-blue-600"
            : peers.length === 1 && peers[0] === "peer-B"
              ? "bg-orange-100 text-orange-600"
              : "bg-gray-200 text-gray-600"
        }`}
      >
        {peerLabel}
      </span>

      {/* ID range */}
      <span className="text-[10px] text-gray-400">
        {firstId}
        {lastId && ` \u2192 ${lastId}`}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// HLC State tab
// ---------------------------------------------------------------------------

const HlcStateTab = ({
  hlcStates,
}: {
  hlcStates: Readonly<Record<string, Hlc>>
}) => {
  const peerIds = Object.keys(hlcStates).sort()

  return (
    <div className="p-4">
      <p className="text-sm text-gray-500 mb-3 leading-relaxed">
        Each peer maintains a{" "}
        <span className="font-semibold">Hybrid Logical Clock</span> (HLC) that
        combines a wall-clock timestamp with a logical counter. Every operation
        gets a unique, totally-ordered ID derived from the HLC — no coordination
        needed. When a peer receives a remote operation, it merges the remote
        clock with its own, ensuring clocks only move forward. The{" "}
        <span className="font-semibold">tie-break rule</span> (higher HLC wins)
        guarantees that two users typing at the exact same position converge to
        the same result.
      </p>

      {peerIds.length === 0 ? (
        <div className="text-sm text-gray-400 text-center py-6">
          No HLC state yet. Start typing in one of the editors above.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {peerIds.map((peerId) => {
            const hlc = hlcStates[peerId]!
            const isPeerA = peerId === "peer-A"
            const borderColor = isPeerA
              ? "border-blue-200"
              : "border-orange-200"
            const headerColor = isPeerA ? "text-blue-600" : "text-orange-600"
            const bgColor = isPeerA ? "bg-blue-50" : "bg-orange-50"

            return (
              <div
                key={peerId}
                className={`rounded-lg border ${borderColor} ${bgColor} p-3`}
              >
                <div
                  className={`text-sm font-semibold ${headerColor} mb-2`}
                >
                  {peerId}
                </div>
                <div className="space-y-1.5 font-mono text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-500">ts</span>
                    <span className="text-gray-800">{hlc.ts}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">count</span>
                    <span className="text-gray-800">{hlc.count}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">peerId</span>
                    <span className="text-gray-800">{hlc.peerId}</span>
                  </div>
                  <div className="border-t border-gray-200 pt-1.5 mt-1.5">
                    <div className="flex justify-between">
                      <span className="text-gray-500">serialized</span>
                      <span className="text-gray-600 text-[10px] break-all text-right max-w-[200px]">
                        {formatHlcString(hlc)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Abbreviate a node ID for display.
 * Full format: "000001743000000:00001:peer-A"
 * Abbreviated: "...000:01:A"
 */
const abbreviateId = (id: string): string => {
  // Handle split IDs: "ts:count:peer-X:s:offset"
  const splitMarker = id.indexOf(":s:")
  if (splitMarker !== -1) {
    const baseId = id.slice(0, splitMarker)
    const offset = id.slice(splitMarker + 3)
    return abbreviateId(baseId) + `:s:${offset}`
  }

  const parts = id.split(":")
  if (parts.length !== 3) return id
  const ts = parts[0]!
  const count = parts[1]!
  const peer = parts[2]!
  // Last 3 digits of ts, last 2 of count, first letter after "peer-"
  const shortTs = ts.slice(-3)
  const shortCount = count.slice(-2)
  const shortPeer = peer.replace("peer-", "")
  return `${shortTs}:${shortCount}:${shortPeer}`
}

/** Format an HLC object as its serialized string. */
const formatHlcString = (hlc: Hlc): string => {
  const ts = String(hlc.ts).padStart(15, "0")
  const count = String(hlc.count).padStart(5, "0")
  return `${ts}:${count}:${hlc.peerId}`
}
