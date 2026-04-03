/**
 * Inspector Components (Ebb-Native)
 *
 * Three standalone section components, each rendering one aspect of the
 * collaborative editing architecture. These are placed inline within the
 * narrative page layout in App.tsx rather than combined in a tabbed panel.
 *
 * 1. EventLogSection — scrolling stream of ebb-native Actions
 * 2. CausalTreeSection — visual tree data structure
 * 3. HlcStateSection — live Hybrid Logical Clock display
 */

import { useEffect, useRef, useState } from "react";
import { useInspectorStore, clearEvents, type InspectorEvent } from "./inspector-store.ts";
import { ROOT_ID, reconstruct, type DocState } from "./causal-tree.ts";
import type { Hlc } from "./hlc.ts";

// ---------------------------------------------------------------------------
// Event Log Section
// ---------------------------------------------------------------------------

type PeerFilter = "all" | "peer-A" | "peer-B";

export const EventLogSection = () => {
  const store = useInspectorStore();
  return <EventLogInner events={store.events} />;
};

const EventLogInner = ({ events }: { events: readonly InspectorEvent[] }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [peerFilter, setPeerFilter] = useState<PeerFilter>("all");

  const filteredEvents =
    peerFilter === "all" ? events : events.filter((e) => e.peerId === peerFilter);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [filteredEvents.length]);

  const filterButtons: { id: PeerFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "peer-A", label: "peer-A" },
    { id: "peer-B", label: "peer-B" },
  ];

  return (
    <div className="border border-stone-700 rounded-lg bg-stone-950 overflow-hidden">
      {/* Title bar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-stone-700">
        <span className="w-3 h-3 rounded-full bg-stone-700" />
        <span className="w-3 h-3 rounded-full bg-stone-700" />
        <span className="w-3 h-3 rounded-full bg-stone-700" />
        <span className="font-mono text-xs text-stone-500 ml-2">event log</span>
        <div className="ml-auto flex items-center gap-2">
          {/* Filter pills */}
          <div className="flex gap-1">
            {filterButtons.map((btn) => {
              const isActive = peerFilter === btn.id;
              const colorClass =
                btn.id === "peer-A"
                  ? isActive
                    ? "bg-blue-400/20 text-blue-400 border-blue-400/40"
                    : "text-stone-400 border-stone-700 hover:text-blue-400 hover:border-blue-400/40"
                  : btn.id === "peer-B"
                    ? isActive
                      ? "bg-amber-400/20 text-amber-400 border-amber-400/40"
                      : "text-stone-400 border-stone-700 hover:text-amber-400 hover:border-amber-400/40"
                    : isActive
                      ? "bg-stone-700 text-stone-200 border-stone-600"
                      : "text-stone-400 border-stone-700 hover:text-stone-200 hover:border-stone-600";
              return (
                <button
                  key={btn.id}
                  onClick={() => setPeerFilter(btn.id)}
                  className={`px-2 py-0.5 text-[11px] font-mono rounded-full border transition-colors ${colorClass}`}
                >
                  {btn.label}
                </button>
              );
            })}
          </div>
          {events.length > 0 && (
            <button
              onClick={clearEvents}
              className="text-[11px] font-mono text-stone-600 hover:text-stone-400 transition-colors"
            >
              clear
            </button>
          )}
        </div>
      </div>

      {/* Event list */}
      <div ref={scrollRef} className="max-h-80 overflow-y-auto p-2">
        {events.length === 0 ? (
          <div className="text-sm text-stone-500 text-center py-8 font-mono">
            Start typing to see actions flow between peers.
          </div>
        ) : (
          <div className="font-mono text-xs space-y-0.5">
            {filteredEvents.map((event) => (
              <ActionRow key={event.id} event={event} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Render an ebb-native Action as an expandable row.
 */
const ActionRow = ({ event }: { event: InspectorEvent }) => {
  const [expanded, setExpanded] = useState(false);
  const { action, direction, peerId } = event;
  const isPeerA = peerId === "peer-A";
  const color = isPeerA ? "text-blue-400" : "text-amber-400";
  const bgColor = isPeerA ? "bg-blue-400/5" : "bg-amber-400/5";
  const arrow = direction === "sent" ? "\u2192" : "\u2190";
  const dirLabel = direction === "sent" ? "sent" : "recv";

  const time = new Date(event.timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  } as Intl.DateTimeFormatOptions);

  // Summarize the updates: count puts, patches, and deletes
  const putCount = action.updates.filter((u) => u.method === "put").length;
  const patchCount = action.updates.filter((u) => u.method === "patch").length;
  const deleteCount = action.updates.filter((u) => u.method === "delete").length;
  const summary = [
    putCount > 0 ? `${putCount} put` : "",
    patchCount > 0 ? `${patchCount} patch` : "",
    deleteCount > 0 ? `${deleteCount} del` : "",
  ]
    .filter(Boolean)
    .join(", ");

  const shortActionId = action.id.replace(/^peer-[AB]_act_/, "act:");

  return (
    <div className={`rounded ${bgColor}`}>
      {/* Action header row */}
      <div
        className={`flex items-center gap-2 px-2 py-0.5 cursor-pointer hover:bg-stone-800/50 rounded ${color}`}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-stone-600 w-4 shrink-0 text-center select-none">
          {expanded ? "\u25BC" : "\u25B6"}
        </span>
        <span className="text-stone-600 w-20 shrink-0">{time}</span>
        <span className="w-6 text-center shrink-0">{arrow}</span>
        <span className="text-stone-600 w-8 shrink-0">{dirLabel}</span>
        <span className={`${color} font-semibold w-12 shrink-0`}>
          {peerId.replace("peer-", "")}
        </span>
        <span className="px-1.5 py-0 rounded text-[11px] font-semibold shrink-0 bg-stone-800 text-stone-400 border border-stone-700">
          ACTION
        </span>
        <span className="text-stone-500 shrink-0">{shortActionId}</span>
        <span className="text-stone-600 shrink-0">
          ({action.updates.length} update{action.updates.length !== 1 ? "s" : ""}: {summary})
        </span>
      </div>

      {/* Expanded: show each Update */}
      {expanded && (
        <div className="pl-10 pb-1 space-y-0.5">
          {action.updates.map((update, i) => (
            <UpdateRow key={update.id} update={update} index={i} />
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Render a single Update within an Action.
 */
const UpdateRow = ({ update, index }: { update: import("./relay.ts").Update; index: number }) => {
  const methodBadgeColor =
    update.method === "put"
      ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/30"
      : update.method === "patch"
        ? "bg-amber-400/10 text-amber-400 border-amber-400/30"
        : "bg-red-400/10 text-red-400 border-red-400/30";

  const shortSubjectId = abbreviateId(update.subject_id);

  // Extract detail from the typed field data
  let detail = "";
  if (update.method === "put") {
    const runField = update.data.fields["run"];
    if (runField && runField.type === "causal_tree_run") {
      const node = runField.value;
      const text =
        node.text.length <= 20
          ? node.text.replace(/\n/g, "\\n")
          : node.text.slice(0, 20).replace(/\n/g, "\\n") + "...";
      const shortParent = node.parentId === ROOT_ID ? "ROOT" : abbreviateId(node.parentId);
      detail = `"${text}" (${node.text.length} chars) parent=${shortParent}`;
    }
  } else if (update.method === "patch") {
    const appendField = update.data.fields["append"];
    if (appendField && appendField.type === "causal_tree_append") {
      const text = appendField.value.text.replace(/\n/g, "\\n");
      detail = `append "${text}"`;
    }
  } else if (update.method === "delete") {
    const rangeField = update.data.fields["range"];
    if (rangeField && rangeField.type === "causal_tree_range") {
      detail = `offset=${rangeField.value.offset} count=${rangeField.value.count}`;
    }
  }

  return (
    <div className="flex items-center gap-2 px-2 py-0.5 text-stone-400">
      <span className="text-stone-700 w-4 shrink-0 text-center">{index + 1}.</span>
      <span
        className={`px-1.5 py-0 rounded text-[11px] font-semibold shrink-0 border ${methodBadgeColor}`}
      >
        {update.method.toUpperCase()}
      </span>
      <span className="text-stone-500 shrink-0">
        {update.subject_type}:{shortSubjectId}
      </span>
      <span className="text-stone-400 truncate">{detail}</span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Causal Tree Section
// ---------------------------------------------------------------------------

/** A chain of sequential single-child nodes, collapsed into one visual row. */
type ChainSegment = {
  readonly nodes: readonly { id: string; text: string; deleted: boolean; peerId: string }[];
  readonly branches: readonly ChainSegment[]; // Children at the end of the chain (or branch point)
};

/**
 * Walk the causal tree from a starting node and collapse sequential
 * single-child runs into ChainSegments.
 */
const buildChains = (docState: DocState, startId: string): readonly ChainSegment[] => {
  const childIds = docState.children.get(startId) ?? [];
  if (childIds.length === 0) return [];

  return childIds.map((childId) => {
    const nodes: { id: string; text: string; deleted: boolean; peerId: string }[] = [];
    let currentId = childId;

    while (true) {
      const node = docState.nodes.get(currentId);
      if (!node) break;

      nodes.push({
        id: node.id,
        text: node.text,
        deleted: node.deleted,
        peerId: node.peerId,
      });

      const nextChildren = docState.children.get(currentId) ?? [];
      if (nextChildren.length === 1) {
        currentId = nextChildren[0]!;
      } else {
        break;
      }
    }

    const lastNodeId = nodes[nodes.length - 1]?.id;
    const branches = lastNodeId ? buildChains(docState, lastNodeId) : [];

    return { nodes, branches };
  });
};

export const CausalTreeSection = () => {
  const store = useInspectorStore();
  const [selectedPeer, setSelectedPeer] = useState<string>("peer-A");
  const peerIds = Object.keys(store.docStates).sort();
  const docState = store.docStates[selectedPeer];

  return (
    <div className="border border-stone-700 rounded-lg bg-stone-950 overflow-hidden">
      {/* Title bar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-stone-700">
        <span className="w-3 h-3 rounded-full bg-stone-700" />
        <span className="w-3 h-3 rounded-full bg-stone-700" />
        <span className="w-3 h-3 rounded-full bg-stone-700" />
        <span className="font-mono text-xs text-stone-500 ml-2">causal tree</span>
        <div className="ml-auto flex gap-1">
          {peerIds.map((id) => (
            <button
              key={id}
              onClick={() => setSelectedPeer(id)}
              className={`px-2 py-0.5 text-[11px] font-mono rounded-full border transition-colors ${
                selectedPeer === id
                  ? "bg-stone-700 text-stone-200 border-stone-600"
                  : "text-stone-400 border-stone-700 hover:text-stone-200 hover:border-stone-600"
              }`}
            >
              {id}
            </button>
          ))}
        </div>
      </div>

      {/* Tree content */}
      <div className="p-4 max-h-80 overflow-y-auto">
        {peerIds.length === 0 || !docState ? (
          <div className="text-sm text-stone-500 text-center py-8 font-mono">
            Start typing to see the tree grow.
          </div>
        ) : (
          <TreeVisualization docState={docState} />
        )}
      </div>
    </div>
  );
};

const TreeVisualization = ({ docState }: { docState: DocState }) => {
  const treeText = reconstruct(docState);
  const nodeCount = docState.nodes.size - 1; // Exclude ROOT
  const deletedCount = Array.from(docState.nodes.values()).filter(
    (n) => n.deleted && n.id !== ROOT_ID,
  ).length;
  const visibleCount = nodeCount - deletedCount;

  const chains = buildChains(docState, ROOT_ID);

  return (
    <div>
      {/* Stats bar */}
      <div className="flex gap-4 mb-3 text-[11px] text-stone-500 font-mono">
        <span>
          <span className="font-semibold text-stone-400">{nodeCount}</span> total
        </span>
        <span>
          <span className="font-semibold text-emerald-400">{visibleCount}</span> visible
        </span>
        <span>
          <span className="font-semibold text-red-400">{deletedCount}</span> tombstoned
        </span>
      </div>

      {/* Tree */}
      <div className="font-mono text-xs bg-stone-900/50 rounded p-3 max-h-56 overflow-y-auto border border-stone-700">
        {/* ROOT row */}
        <div className="text-stone-500 font-semibold mb-1">ROOT</div>

        {chains.length === 0 ? (
          <div className="text-stone-600 pl-4">(empty)</div>
        ) : (
          <ChainList chains={chains} depth={1} />
        )}
      </div>

      {/* Reconstructed text */}
      <div className="mt-3 text-[11px] text-stone-500 font-mono">
        <span className="font-semibold text-stone-400">Reconstructed: </span>
        <span className="text-stone-300">{treeText.length > 0 ? `"${treeText}"` : "(empty)"}</span>
      </div>
    </div>
  );
};

const ChainList = ({ chains, depth }: { chains: readonly ChainSegment[]; depth: number }) => {
  const isBranch = chains.length > 1;

  return (
    <div style={{ paddingLeft: `${depth * 14}px` }}>
      {chains.map((chain, i) => (
        <div key={chain.nodes[0]?.id ?? i}>
          {/* Branch connector for multi-child splits */}
          <div className="flex items-start gap-1.5 py-0.5">
            {isBranch && (
              <span className="text-stone-700 shrink-0 select-none">
                {i < chains.length - 1 ? "\u251C" : "\u2514"}
              </span>
            )}
            <ChainRow chain={chain} />
          </div>

          {/* Recurse into branches at the end of this chain */}
          {chain.branches.length > 0 && <ChainList chains={chain.branches} depth={depth + 1} />}
        </div>
      ))}
    </div>
  );
};

/**
 * Render a single collapsed chain as one row.
 */
const ChainRow = ({ chain }: { chain: ChainSegment }) => {
  const { nodes } = chain;
  if (nodes.length === 0) return null;

  // Group consecutive nodes by deleted status for inline rendering
  type DisplayRun = { deleted: boolean; text: string; count: number };
  const runs: DisplayRun[] = [];
  for (const node of nodes) {
    const charDisplay = node.text.replace(/\n/g, "\u23CE").replace(/ /g, "\u2423");
    const last = runs[runs.length - 1];
    if (last && last.deleted === node.deleted) {
      last.text += charDisplay;
      last.count++;
    } else {
      runs.push({ deleted: node.deleted, text: charDisplay, count: 1 });
    }
  }

  const totalDeleted = nodes.filter((n) => n.deleted).length;
  const totalChars = nodes.reduce((sum, n) => sum + n.text.length, 0);

  // Peer attribution
  const peers = [...new Set(nodes.map((n) => n.peerId))];
  const peerLabel = peers.map((p) => p.replace("peer-", "")).join(", ");

  // Abbreviated IDs for the first and last node
  const firstId = abbreviateId(nodes[0]!.id);
  const lastId = nodes.length > 1 ? abbreviateId(nodes[nodes.length - 1]!.id) : null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {/* The chain text with inline deleted runs */}
      <span className="font-semibold">
        &quot;
        {runs.map((run, i) =>
          run.deleted ? (
            <span key={i} className="text-red-400/60 line-through">
              {run.text}
            </span>
          ) : (
            <span key={i} className="text-stone-200">
              {run.text}
            </span>
          ),
        )}
        &quot;
      </span>

      {/* Node count badge */}
      <span className="text-[10px] text-stone-600">
        {nodes.length === 1
          ? `1 run (${totalChars} ch)`
          : `${nodes.length} runs (${totalChars} ch)`}
        {totalDeleted > 0 && <span className="text-red-400/60 ml-0.5">({totalDeleted} del)</span>}
      </span>

      {/* Peer attribution */}
      <span
        className={`text-[10px] px-1.5 py-0 rounded-full border ${
          peers.length === 1 && peers[0] === "peer-A"
            ? "bg-blue-400/10 text-blue-400 border-blue-400/30"
            : peers.length === 1 && peers[0] === "peer-B"
              ? "bg-amber-400/10 text-amber-400 border-amber-400/30"
              : "bg-stone-800 text-stone-400 border-stone-700"
        }`}
      >
        {peerLabel}
      </span>

      {/* ID range */}
      <span className="text-[10px] text-stone-600">
        {firstId}
        {lastId && ` \u2192 ${lastId}`}
      </span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// HLC State Section
// ---------------------------------------------------------------------------

export const HlcStateSection = () => {
  const store = useInspectorStore();
  return <HlcStateInner hlcStates={store.hlcStates} />;
};

const HlcStateInner = ({ hlcStates }: { hlcStates: Readonly<Record<string, Hlc>> }) => {
  const peerIds = Object.keys(hlcStates).sort();

  return (
    <div>
      {peerIds.length === 0 ? (
        <div className="border border-stone-700 rounded-lg bg-stone-950 p-8">
          <div className="text-sm text-stone-500 text-center font-mono">
            Start typing to see the clocks advance.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {peerIds.map((peerId) => {
            const hlc = hlcStates[peerId]!;
            const isPeerA = peerId === "peer-A";
            const accentColor = isPeerA ? "text-blue-400" : "text-amber-400";
            const borderColor = isPeerA ? "border-blue-400/20" : "border-amber-400/20";

            return (
              <div key={peerId} className={`rounded-lg border ${borderColor} bg-stone-900/50 p-4`}>
                <div className={`text-sm font-mono font-semibold ${accentColor} mb-3`}>
                  {peerId}
                </div>
                <div className="space-y-2 font-mono text-xs">
                  <div className="flex justify-between">
                    <span className="text-stone-500">ts</span>
                    <span className="text-stone-300">{hlc.ts}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-stone-500">count</span>
                    <span className="text-stone-300">{hlc.count}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-stone-500">peerId</span>
                    <span className="text-stone-300">{hlc.peerId}</span>
                  </div>
                  <div className="border-t border-stone-700 pt-2 mt-2">
                    <div className="flex justify-between items-start gap-2">
                      <span className="text-stone-500 shrink-0">serialized</span>
                      <span className="text-stone-400 text-[10px] break-all text-right">
                        {formatHlcString(hlc)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

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
  const splitMarker = id.indexOf(":s:");
  if (splitMarker !== -1) {
    const baseId = id.slice(0, splitMarker);
    const offset = id.slice(splitMarker + 3);
    return abbreviateId(baseId) + `:s:${offset}`;
  }

  const parts = id.split(":");
  if (parts.length !== 3) return id;
  const ts = parts[0]!;
  const count = parts[1]!;
  const peer = parts[2]!;
  const shortTs = ts.slice(-3);
  const shortCount = count.slice(-2);
  const shortPeer = peer.replace("peer-", "");
  return `${shortTs}:${shortCount}:${shortPeer}`;
};

/** Format an HLC object as its serialized string. */
const formatHlcString = (hlc: Hlc): string => {
  const ts = String(hlc.ts).padStart(15, "0");
  const count = String(hlc.count).padStart(5, "0");
  return `${ts}:${count}:${hlc.peerId}`;
};
