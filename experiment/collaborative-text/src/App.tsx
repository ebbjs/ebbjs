/**
 * Editor App — Ebb-Native Wire Protocol
 *
 * A narrative walkthrough of how ebb's collaborative editing works,
 * from the inside out. The page is structured as an interactive article:
 *
 * 1. Hero — what this demo shows
 * 2. Live Editors — two side-by-side CodeMirror peers
 * 3. The Wire Protocol — event log showing Actions & Updates
 * 4. The Document Model — causal tree visualization
 * 5. Clock Synchronization — HLC state display
 *
 * Wire protocol follows ebb's Action -> Update[] model:
 * - Each CM transaction produces a single Action containing one or more Updates
 * - SPLIT actions are local-only (not included in Actions)
 * - INSERT_RUN -> Action with a "put" Update carrying a causal_tree_run field
 * - DELETE_RANGE -> Action with a "delete" Update carrying a causal_tree_range field
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
} from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
} from "@codemirror/language";
import { createHlc, type Hlc } from "./hlc.ts";
import {
  createDocState,
  docReducer,
  reconstruct,
  type DocAction,
  type DocState,
} from "./causal-tree.ts";
import {
  createBridgeExtension,
  createIdMapField,
  setIdMapEffect,
  type BridgeConfig,
} from "./cm-bridge.ts";
import {
  useRelay,
  type Action,
  type Update,
  type SyncMessage,
} from "./relay.ts";
import { usePresence, createPresenceExtension } from "./presence.ts";
import { logEvent, updateHlc, updateDocState } from "./inspector-store.ts";
import {
  EventLogSection,
  CausalTreeSection,
  HlcStateSection,
} from "./InspectorPanel.tsx";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANNEL_NAME = "collab-text";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Counter for generating unique update IDs within this peer's session. */
let nextUpdateId = 0;

/**
 * Convert a DocAction into an ebb-native Update.
 *
 * - INSERT_RUN -> "put" Update with a "causal_tree_run" field value
 * - EXTEND_RUN -> "patch" Update with a "causal_tree_append" field value
 * - DELETE_RANGE -> "delete" Update with a "causal_tree_range" field value
 * - SPLIT -> returns undefined (local-only, not broadcast)
 *
 * Each Update targets a single entity (RunNode) with self-describing
 * typed field data, mirroring ebb's per-field merge dispatch.
 */
const docActionToUpdate = (
  action: DocAction,
  hlc: Hlc,
  peerId: string,
): Update | undefined => {
  switch (action.type) {
    case "INSERT_RUN":
      return {
        id: `${peerId}_upd_${nextUpdateId++}`,
        subject_id: action.node.id,
        subject_type: "run",
        method: "put",
        data: {
          fields: {
            run: {
              type: "causal_tree_run",
              value: action.node,
              hlc,
              // Include the split offset so the receiving peer can split
              // the parent run before inserting. Without this, a mid-run
              // insert would land at the wrong position on peers that
              // haven't split the parent yet.
              ...(action.splitParentAt !== undefined && {
                splitParentAt: action.splitParentAt,
              }),
            },
          },
        },
      };
    case "EXTEND_RUN":
      return {
        id: `${peerId}_upd_${nextUpdateId++}`,
        subject_id: action.runId,
        subject_type: "run",
        method: "patch",
        data: {
          fields: {
            append: {
              type: "causal_tree_append",
              value: { text: action.appendText },
              hlc,
            },
          },
        },
      };
    case "DELETE_RANGE":
      return {
        id: `${peerId}_upd_${nextUpdateId++}`,
        subject_id: action.runId,
        subject_type: "run",
        method: "delete",
        data: {
          fields: {
            range: {
              type: "causal_tree_range",
              value: { offset: action.offset, count: action.count },
              hlc,
            },
          },
        },
      };
    case "SPLIT":
      // SPLIT is a local consequence — not broadcast.
      // Each peer performs its own splits when it receives a "put" Update.
      return undefined;
  }
};

/** Counter for generating unique action IDs within this peer's session. */
let nextActionId = 0;

/**
 * Wrap a list of Updates into an ebb-native Action.
 *
 * An Action is the atomic sync unit: all Updates are applied together,
 * and the action ID is used for dedup. This mirrors ebb's guarantee
 * that Actions are never split across sync pages.
 */
const createAction = (
  updates: readonly Update[],
  hlc: Hlc,
  peerId: string,
): Action => ({
  id: `${peerId}_act_${nextActionId++}`,
  actor_id: peerId,
  hlc,
  updates,
});

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

const Section = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <section className="w-full py-8 sm:py-10">
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <h2 className="text-2xl sm:text-3xl font-bold text-stone-100 tracking-tight text-balance mb-6">
        {title}
      </h2>
      {children}
    </div>
  </section>
);

// ---------------------------------------------------------------------------
// PeerEditor component
// ---------------------------------------------------------------------------

type PeerEditorProps = {
  peerId: string;
  onViewReady?: (view: EditorView) => void;
  onFocus?: () => void;
  ghostActive?: boolean;
};

const PeerEditor = ({
  peerId,
  onViewReady,
  onFocus,
  ghostActive,
}: PeerEditorProps) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const hlcRef = useRef<Hlc>(createHlc(peerId));

  // Causal Tree state via useReducer
  const [docState, treeDispatch] = useReducer(
    docReducer,
    undefined,
    createDocState,
  );

  // Stable ref to latest docState (so callbacks can read it without stale closures)
  const docStateRef = useRef<DocState>(docState);
  docStateRef.current = docState;

  // Create the ID map StateField once
  const idMapField = useMemo(() => createIdMapField(), []);

  // Presence tracking
  const presence = usePresence(peerId, idMapField);
  const getLocalPresenceIdsRef = useRef(presence.getLocalPresenceIds);
  getLocalPresenceIdsRef.current = presence.getLocalPresenceIds;

  // Ref to hold the relay broadcast function (avoids circular dep with useRelay)
  const broadcastRef = useRef<((message: SyncMessage) => void) | null>(null);

  // ---------------------------------------------------------------------------
  // Update batching — collects Updates within a CM transaction, flushes as one Action
  // ---------------------------------------------------------------------------

  // Pending updates accumulator. Within a single CM transaction, the bridge
  // may call localDispatch multiple times (e.g., delete 3 runs = 3 calls).
  // We collect the resulting Updates here, then flush them as one Action
  // after the transaction completes (via microtask).
  const pendingUpdatesRef = useRef<Update[]>([]);
  const flushScheduledRef = useRef(false);

  /**
   * Flush all pending Updates into a single ebb-native Action and broadcast.
   *
   * This runs as a microtask after the current event-loop tick, ensuring
   * all DocActions from a single CM transaction are batched together.
   * A multi-run delete produces 1 Action with N "delete" Updates, not N
   * separate messages — matching ebb's atomic Action guarantee.
   */
  const flushPendingUpdates = useCallback(() => {
    flushScheduledRef.current = false;
    const updates = pendingUpdatesRef.current;
    if (updates.length === 0) return;

    pendingUpdatesRef.current = [];

    const action = createAction(updates, hlcRef.current, peerId);
    broadcastRef.current?.({ type: "ACTION", action });

    // Inspector instrumentation
    logEvent(peerId, "sent", action);
    updateHlc(peerId, hlcRef.current);
    updateDocState(peerId, docStateRef.current);
  }, [peerId]);

  // Dispatch used by the CM Bridge (local edits): updates tree AND collects Updates.
  // We update docStateRef synchronously so that any subsequent reads of
  // getDocState() within the same event-loop tick see the latest state
  // (React's useReducer batches updates and won't flush until the next render).
  const localDispatch = useCallback(
    (action: DocAction) => {
      docStateRef.current = docReducer(docStateRef.current, action);
      treeDispatch(action);

      // Convert to an ebb-native Update and collect it for batching
      const update = docActionToUpdate(action, hlcRef.current, peerId);
      if (update) {
        pendingUpdatesRef.current.push(update);

        // Schedule a flush as a microtask — this ensures all DocActions from
        // the current CM transaction are collected before we create the Action.
        if (!flushScheduledRef.current) {
          flushScheduledRef.current = true;
          queueMicrotask(flushPendingUpdates);
        }
      }
    },
    [peerId, flushPendingUpdates],
  );

  // Dispatch used by the Relay (remote edits): updates tree only, no re-broadcast.
  // Same synchronous ref update so rapid sequential BroadcastChannel messages
  // each see the tree state left by the previous message.
  const remoteDispatch = useCallback(
    (action: DocAction) => {
      docStateRef.current = docReducer(docStateRef.current, action);
      treeDispatch(action);

      // Inspector instrumentation
      updateDocState(peerId, docStateRef.current);
    },
    [peerId],
  );

  // Set up the relay
  const relay = useRelay({
    channelName: CHANNEL_NAME,
    peerId,
    hlcRef,
    dispatch: remoteDispatch,
    getDocState: () => docStateRef.current,
    viewRef,
    idMapField,
    updatePresence: presence.updatePresence,
    onRemoteMessage: (message) => {
      if (message.type === "ACTION") {
        logEvent(peerId, "received", message.action);
      }
      updateHlc(peerId, hlcRef.current);
    },
  });

  // Wire broadcast ref once relay is available
  broadcastRef.current = relay.broadcast;

  // Initialize CodeMirror
  useEffect(() => {
    if (!editorRef.current) return;

    const bridgeConfig: BridgeConfig = {
      peerId,
      getHlc: () => hlcRef.current,
      setHlc: (hlc: Hlc) => {
        hlcRef.current = hlc;
      },
      dispatch: localDispatch,
      getDocState: () => docStateRef.current,
    };

    const state = EditorState.create({
      doc: "",
      extensions: [
        // Minimal setup (no undo — conflicts with Causal Tree)
        keymap.of([...defaultKeymap]),
        drawSelection(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle),
        bracketMatching(),
        // Bridge extension — connects CM to the Causal Tree
        createBridgeExtension(bridgeConfig, idMapField),
        // Presence extension — renders remote cursors and selections
        createPresenceExtension({
          localPeerId: peerId,
          getPresenceMap: () => presence.presenceMapRef.current,
          idMapField,
          getDocState: () => docStateRef.current,
        }),
        // Selection change listener — broadcasts local cursor position.
        EditorView.updateListener.of((update) => {
          const hasIdMapUpdate = update.transactions.some((tr) =>
            tr.effects.some((e) => e.is(setIdMapEffect)),
          );
          const pureSelectionChange = update.selectionSet && !update.docChanged;

          if (hasIdMapUpdate || pureSelectionChange) {
            const refs = getLocalPresenceIdsRef.current(update.state);
            broadcastRef.current?.({
              type: "PRESENCE",
              peerId,
              anchorId: refs.anchor.runId,
              anchorOffset: refs.anchor.offset,
              headId: refs.head.runId,
              headOffset: refs.head.offset,
            });
          }
        }),
        // Basic sizing — colors are handled in index.css
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { overflow: "auto" },
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;
    onViewReady?.(view);

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — CM view is created once

  // Debug: log consistency check on every docState change
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const treeText = reconstruct(docState);
    const cmText = view.state.doc.toString();

    if (treeText !== cmText) {
      console.error(
        `[${peerId}] INCONSISTENCY DETECTED!\n` +
          `  Causal Tree: "${treeText}"\n` +
          `  CodeMirror:  "${cmText}"`,
      );
    }
  }, [docState, peerId]);

  const isPeerA = peerId === "peer-A";
  const peerColor = isPeerA ? "text-blue-400" : "text-amber-400";
  const peerLabel = isPeerA ? "peer-A" : "peer-B";

  return (
    <div className="flex flex-col flex-1 min-w-0">
      {/* Window chrome */}
      <div className="border border-stone-700 rounded-lg bg-stone-950 overflow-hidden">
        {/* Title bar */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-stone-700">
          <span className="w-3 h-3 rounded-full bg-stone-700" />
          <span className="w-3 h-3 rounded-full bg-stone-700" />
          <span className="w-3 h-3 rounded-full bg-stone-700" />
          <span className={`font-mono text-xs ml-2 ${peerColor}`}>
            {peerLabel}
          </span>
          {ghostActive && (
            <span className="font-mono text-xs text-stone-500 ml-1">
              (ghost)
            </span>
          )}
          <span className="font-mono text-xs text-stone-500 ml-auto">
            {docState.nodes.size - 1} runs
          </span>
        </div>
        {/* Editor area */}
        <div ref={editorRef} className="h-64 sm:h-72" onFocus={onFocus} />
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Ghost peer typing
// ---------------------------------------------------------------------------

const GHOST_MESSAGE = "Hello from the other side.";
const GHOST_START_DELAY = 1500;
const GHOST_CHAR_MIN_DELAY = 80;
const GHOST_CHAR_MAX_DELAY = 120;

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------

export const App = () => {
  const [ghostActive, setGhostActive] = useState(true);
  const peerBViewRef = useRef<EditorView | null>(null);
  const ghostTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Start ghost typing after delay
  useEffect(() => {
    if (!ghostActive) return;

    const typeNextChar = (index: number) => {
      const view = peerBViewRef.current;
      if (!view || index >= GHOST_MESSAGE.length || !ghostActive) {
        setGhostActive(false);
        return;
      }

      // Insert the character at the current cursor position
      const char = GHOST_MESSAGE[index]!;
      view.dispatch(view.state.replaceSelection(char));

      // Schedule next character with random delay
      const delay =
        GHOST_CHAR_MIN_DELAY +
        Math.random() * (GHOST_CHAR_MAX_DELAY - GHOST_CHAR_MIN_DELAY);
      ghostTimeoutRef.current = setTimeout(
        () => typeNextChar(index + 1),
        delay,
      );
    };

    // Start typing after initial delay
    ghostTimeoutRef.current = setTimeout(() => {
      typeNextChar(0);
    }, GHOST_START_DELAY);

    return () => {
      if (ghostTimeoutRef.current) {
        clearTimeout(ghostTimeoutRef.current);
      }
    };
  }, [ghostActive]);

  const handlePeerBViewReady = useCallback((view: EditorView) => {
    peerBViewRef.current = view;
  }, []);

  const handlePeerBFocus = useCallback(() => {
    setGhostActive(false);
    if (ghostTimeoutRef.current) {
      clearTimeout(ghostTimeoutRef.current);
    }
  }, []);

  return (
    <div className="min-h-screen bg-stone-950 text-stone-100 antialiased">
      {/* Hero */}
      <section className="w-full pt-12 sm:pt-16 pb-6 sm:pb-8">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <h1 className="text-3xl sm:text-5xl font-bold tracking-tight text-balance max-w-3xl">
            Collaborative Editing, From the Inside Out
          </h1>
          <p className="text-base text-stone-200 mt-6 sm:mt-8 leading-relaxed max-w-3xl">
            Collaborative text editing is one of the hardest problems in
            distributed systems. The standard approach — use a CRDT library —
            works, but at a cost: the ordering algorithm is a{" "}
            <strong className="text-white font-semibold">
              black box you can't inspect or adapt
            </strong>
            , concurrent edits can produce{" "}
            <strong className="text-white font-semibold">
              results users interpret as corruption
            </strong>
            , and integration with real editor frameworks creates layers of{" "}
            <strong className="text-white font-semibold">
              impedance mismatch
            </strong>
            .
          </p>
          <p className="text-base text-stone-200 mt-4 leading-relaxed max-w-3xl">
            A growing body of work argues there's a simpler path. Label each
            character with a unique ID, reference neighbors instead of indices,
            and let a deterministic ordering rule handle the rest. The conflict
            resolution lives in the data structure itself — not in a server, not
            in a library you can't inspect. This demo builds that data structure
            from scratch: a{" "}
            <strong className="text-white font-semibold">Causal Tree</strong>{" "}
            ordered by{" "}
            <strong className="text-white font-semibold">
              Hybrid Logical Clocks
            </strong>
            .
          </p>
        </div>
      </section>

      {/* Step 1: Live Editors */}
      <Section title="Hello from the other side">
        <p className="text-base text-stone-200 leading-relaxed mb-8 max-w-3xl">
          Two independent editors, each with their own copy of the document. A
          ghost is typing in peer-B — watch the operations propagate to peer-A
          in real time. Type in peer-A yourself and see both editors converge to
          the same result, every time.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 sm:gap-6">
          <PeerEditor peerId="peer-A" />
          <PeerEditor
            peerId="peer-B"
            onViewReady={handlePeerBViewReady}
            onFocus={handlePeerBFocus}
            ghostActive={ghostActive}
          />
        </div>
      </Section>

      {/* Step 2: The Document Model */}
      <Section title="Identity over indices">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.5fr] gap-8 lg:gap-12 items-start">
          <div>
            <p className="text-base text-stone-200 leading-relaxed mb-4">
              The core problem with collaborative text editing is deceptively
              simple: when two users type concurrently, array indices become
              meaningless. Alice inserts at position 3, shifting everything
              after it — but Bob's concurrent insert at position 17 doesn't know
              that yet.
            </p>
            <p className="text-base text-stone-200 leading-relaxed mb-4">
              The fix: stop thinking in indices. Give each run of characters a
              stable ID and reference neighbors instead.{" "}
              <code className="text-white font-mono bg-stone-800 px-1.5 py-0.5 rounded">
                insert after node X
              </code>{" "}
              works no matter what else has changed. These parent references
              form a{" "}
              <strong className="text-white font-semibold">Causal Tree</strong>{" "}
              — sequential typing creates chains, concurrent edits at the same
              position create branches. Reading in depth-first order
              reconstructs the document deterministically.
            </p>
            <p className="text-base text-stone-200 leading-relaxed">
              Run-length optimization means sequential characters by the same
              peer are stored as a single node, keeping the tree compact even
              for long documents.
            </p>
          </div>
          <CausalTreeSection />
        </div>
      </Section>

      {/* Step 3: Clock Synchronization */}
      <Section title="Order without authority">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-8 lg:gap-12 items-start">
          <div>
            <p className="text-base text-stone-200 leading-relaxed mb-4">
              A tree of character runs solves the identity problem, but you
              still need a rule for ordering siblings — when two users type at
              the exact same position, who goes first?
            </p>
            <p className="text-base text-stone-200 leading-relaxed mb-4">
              CRDTs typically solve this with complex, algorithm-specific total
              orders. We use a{" "}
              <strong className="text-white font-semibold">
                Hybrid Logical Clock
              </strong>
              : a wall-clock timestamp combined with a monotonic counter that
              guarantees every operation gets a unique, totally-ordered ID. The
              ordering rule is deterministic — peers converge to the same result
              regardless of whether a server relays the operations or they
              arrive peer-to-peer.
            </p>
            <p className="text-base text-stone-200 leading-relaxed">
              When a remote operation arrives, the peer merges the remote clock
              with its own, ensuring time only moves forward. The tie-break rule
              — higher HLC wins — is what makes convergence deterministic
              without any central coordination.
            </p>
          </div>
          <HlcStateSection />
        </div>
      </Section>

      {/* Step 4: The Wire Protocol */}
      <Section title="Sync you can inspect">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.5fr] gap-8 lg:gap-12 items-start">
          <div>
            <p className="text-base text-stone-200 leading-relaxed mb-4">
              One of the strongest critiques of CRDT libraries is that they're
              opaque — operations go in, state comes out, and when something
              goes wrong, you can't see why. Our wire protocol is fully
              transparent: every edit produces an{" "}
              <strong className="text-white font-semibold">Action</strong>{" "}
              containing self-describing{" "}
              <strong className="text-white font-semibold">Updates</strong>,
              each targeting a specific run node with a named method and typed
              field data.
            </p>
            <ul className="space-y-2 text-stone-200 text-base">
              <li className="flex gap-2">
                <span className="font-mono text-stone-500 shrink-0">--</span>
                <span>
                  <strong className="text-emerald-400 font-mono font-semibold">
                    PUT
                  </strong>{" "}
                  inserts a new run into the tree
                </span>
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-stone-500 shrink-0">--</span>
                <span>
                  <strong className="text-amber-400 font-mono font-semibold">
                    PATCH
                  </strong>{" "}
                  appends characters to an existing run
                </span>
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-stone-500 shrink-0">--</span>
                <span>
                  <strong className="text-red-400 font-mono font-semibold">
                    DELETE
                  </strong>{" "}
                  tombstones a character range within a run
                </span>
              </li>
            </ul>
            <p className="text-base text-stone-200 mt-4 leading-relaxed">
              A multi-character delete produces one Action with multiple DELETE
              Updates — not separate messages. You can read every operation,
              trace every mutation, and understand exactly why the document
              looks the way it does.
            </p>
          </div>
          <EventLogSection />
        </div>
      </Section>

      {/* Footer spacer */}
      <div className="pb-12 sm:pb-16" />
    </div>
  );
};
