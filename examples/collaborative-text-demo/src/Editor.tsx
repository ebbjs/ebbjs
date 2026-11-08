/**
 * Editor component — CodeMirror 6 wired to a TextDocument via
 * @ebbjs/codemirror.
 *
 * Responsibilities:
 * - Construct the EditorView with the bridge extension.
 * - Open the TextDocument on `client.textDocument(docId)`.
 * - Subscribe to incoming SSE events and pipe their Actions into the
 *   TextDocument (the bridge then reflects them in CM).
 * - Periodically flush `doc.pendingActions()` to the server via
 *   `client.write()`.
 */

import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language";
import type { Action } from "@ebbjs/core";
import type { CursorPresence, PeerPresence } from "@ebbjs/client";
import {
  createBridgeExtension,
  createIdMapField,
  createPresenceExtension,
  getPositionOfRun,
  getRunAtPosition,
  mountEditorBridge,
  setIdMapEffect,
} from "@ebbjs/codemirror";

import type { DemoClient } from "./bootstrap";

interface Props {
  client: DemoClient;
  docId: string;
  actorId: string;
  groupIds: readonly string[];
  /**
   * Actions to replay into the doc on open. From `bootstrap.ts`'s
   * catchUp — without this, a new tab starts with an empty document
   * even if other tabs (or earlier sessions) have written to it.
   */
  caughtUpActions: readonly Action[];
}

const FLUSH_INTERVAL_MS = 250;

export function Editor({ client, docId, actorId, groupIds, caughtUpActions }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const bridgeRef = useRef<{ detach: () => void } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const doc = client.textDocument(docId);
    const idMapField = createIdMapField();

    // Seed the doc with caught-up actions so it opens with the
    // current document state. SSE only delivers future actions, so
    // without this a fresh tab would start empty even if other tabs
    // have already typed text.
    for (const action of caughtUpActions) {
      doc.applyActions([action]);
    }

    // Stash a ref so the bridge extension can read the view at runtime
    // (the listener fires synchronously inside CM dispatch). The
    // localEdit tracker is flipped on/off by the extension during a
    // local-CM→doc dispatch; mountEditorBridge reads it to skip
    // applying cmChanges for events raised during a local edit (CM
    // already has the new text from the user input — re-applying
    // would double characters and push mid-run inserts to the wrong
    // side of the parent because the spans StateField hasn't caught
    // up yet).
    const viewRefLocal = { current: null as EditorView | null };
    const localEdit = { active: false };
    const extension = createBridgeExtension({
      doc,
      idMapField,
      getView: () => viewRefLocal.current,
      localEdit,
    });

    // Forward local selection / doc changes to the presence stream.
    // Reads `view` lazily through `viewRefLocal` so the listener can
    // be registered before the view is constructed.
    const sendLocalCursor = (): void => {
      const v = viewRefLocal.current;
      if (!v) return;
      const sel = v.state.selection.main;
      const anchor = getRunAtPosition(v.state, sel.anchor, idMapField);
      const head = getRunAtPosition(v.state, sel.head, idMapField);
      if (!anchor || !head) return;
      client.presence.set(docId, "cursor", {
        anchorId: anchor.runId,
        anchorOffset: anchor.offset,
        headId: head.runId,
        headOffset: head.offset,
      });
    };

    const state = EditorState.create({
      doc: "",
      extensions: [
        // Disable undo history: it conflicts with the causal-tree semantics
        // (every change is a remote-mutable run, not an in-memory edit stack).
        // We keep the historyKeymap registered but with no actual history —
        // effectively a no-op, but bindings still exist.
        keymap.of([...defaultKeymap, ...historyKeymap]),
        lineNumbers(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle),
        bracketMatching(),
        extension,
        // Render remote peers' cursors/selections. Reads the doc's `cursor`
        // channel from client.presence and the bridge's idMapField to
        // translate run-id coordinates to CM positions.
        createPresenceExtension({
          getPresence: (): ReadonlyMap<string, PeerPresence<CursorPresence>> =>
            client.presence.forEntity(docId, "cursor"),
          getPositionOfRun: (runId, offset) => {
            const v = viewRefLocal.current;
            if (!v) return 0;
            return getPositionOfRun(v.state, runId, offset, idMapField);
          },
          getRunAtPosition: (position) => {
            const v = viewRefLocal.current;
            const r = getRunAtPosition(v?.state ?? state, position, idMapField);
            return r ? { runId: r.runId, offset: r.offset } : undefined;
          },
        }),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet || u.docChanged) sendLocalCursor();
        }),
        // Re-broadcast the local cursor whenever the bridge refreshes
        // the spans StateField. The first updateListener fires inside
        // the same dispatch as a local edit's `docChanged` transaction,
        // but at that point `idMapField` still holds the pre-edit
        // spans — `getRunAtPosition` returns `undefined` for the just-
        // typed position and `sendLocalCursor` silently no-ops. The
        // bridge dispatches a follow-up transaction carrying
        // `setIdMapEffect` once the new spans are in place; this
        // listener catches that and re-invokes the cursor send. The
        // 100ms presence debounce coalesces consecutive cursor moves
        // so the extra call doesn't spam the server.
        EditorView.updateListener.of((u) => {
          if (u.transactions.some((tr) => tr.effects.some((e) => e.is(setIdMapEffect)))) {
            sendLocalCursor();
          }
        }),
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { overflow: "auto" },
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRefLocal.current = view;
    viewRef.current = view;

    const bridge = mountEditorBridge(view, doc, idMapField, localEdit);
    bridgeRef.current = bridge;

    // Test seam: when the Playwright spec opts in via
    // `window.__EBB_DEMO_TEST_CONFIG__.exposeState`, expose a
    // minimal test handle on `window.__EBB_DEMO_TEST_STATE__`.
    // The conflict e2e reads `getRunIds()` to discover existing runs
    // and `forceExtend(runId, text, hlc)` to dispatch a localExtend
    // with a forced HLC — bypassing the auto-advance so two tabs can
    // produce concurrent field updates without racing the clock.
    // The handle is opt-in (only set when the test config requests
    // it) and only exposes what the conflict scenario needs, so the
    // audit surface stays small.
    // Populated once the live subscription exists; the test handle reads
    // through it so a forced reconnect tears down and re-opens cleanly.
    const reconnectRef: { current: () => void } = { current: () => {} };
    const exposeState = window.__EBB_DEMO_TEST_CONFIG__?.exposeState;
    if (exposeState) {
      // Document order, deduped: a run can appear as several spans when a
      // peer inserts inside it, and the last id is the run at the text end.
      const getRunIds = (): readonly string[] => [
        ...new Set(doc.docState.index.spans.map((span) => span.runId)),
      ];
      window.__EBB_DEMO_TEST_STATE__ = {
        docId,
        actorId,
        getRunIds,
        getText: () => doc.text,
        forceExtend: (runId: string, appendText: string, hlc: string) => {
          // localExtend accepts an `hlc` override; we use it to pin
          // the HLC to a value the test controls so two tabs can
          // produce concurrent updates without HLC drift.
          return doc.localExtend({ runId, appendText, hlc: hlc as never });
        },
        flushPending: async () => {
          const pending = doc.pendingActions();
          if (pending.length === 0) return { rejected: [] };
          return client.write(pending);
        },
        reconnect: () => reconnectRef.current(),
        // Read-only snapshot of the presence map for the document.
        // Useful for debugging tests that exercise the cursor/selection
        // surfacing path.
        getPresenceEntries: (): readonly {
          actorId: string;
          anchorId: string;
          anchorOffset: number;
        }[] => {
          const entries = client.presence.forEntity(docId, "cursor");
          return Array.from(entries.values()).map((e) => ({
            actorId: e.actorId,
            anchorId: e.data.anchorId,
            anchorOffset: e.data.anchorOffset,
          }));
        },
      };
    }
    const unsubscribePresence = client.presence.onUpdate((change) => {
      // Only the doc's own cursor channel affects these decorations; a
      // 20 Hz camera channel on the same entity must not rebuild them.
      if (change.entityId !== docId || change.channel !== "cursor") return;
      // Force the ViewPlugin to rebuild decorations by dispatching
      // a no-op transaction. CM6 only re-runs ViewPlugin.update() on
      // actual transactions, so we need to nudge it.
      view.dispatch({});
    });
    view.dispatch({ effects: [] }); // ensure initial send runs after mount
    sendLocalCursor();

    // Subscribe to SSE for live updates. The @ebbjs/client SSE
    // implementation sends the actor id via the x-ebb-actor-id
    // header (fetch-based, works the same in browser and Node).
    const onEvent: Parameters<typeof client.subscribe>[2] = (event) => {
      if (event.type === "data") {
        doc.applyActions([event.action]);
      } else if (event.type === "control" && (event.control as { reconnect?: boolean }).reconnect) {
        // Server told us our cursor is stale — let subscribe's
        // own retry logic handle the reconnect; just log.
        // eslint-disable-next-line no-console
        console.warn("[editor] server requested reconnect:", event.control);
      }
    };
    let unsubscribe = client.subscribe(groupIds, onEvent);
    reconnectRef.current = () => {
      // A new subscribe replaces the previous stream, so reconnecting is
      // just another call; the returned unsubscribe replaces the old one.
      unsubscribe = client.subscribe(groupIds, onEvent);
    };

    // Periodic flush of pending actions to the server.
    const flushTimer = window.setInterval(() => {
      const pending = doc.pendingActions();
      if (pending.length === 0) return;
      void client.write(pending).then((res) => {
        // Acknowledge rejected actions (e.g., HLC drift, permission)
        // by removing them from the pending queue. For the prototype
        // we don't roll back the tree — the optimistic local apply
        // stays.
        if (res.rejected.length > 0) {
          doc.ackPending(res.rejected.map((r) => r.id));
          // eslint-disable-next-line no-console
          console.warn("[editor] write rejected:", res.rejected);
        } else {
          doc.ackPending(pending.map((a) => a.id));
        }
      });
    }, FLUSH_INTERVAL_MS);

    return () => {
      window.clearInterval(flushTimer);
      unsubscribePresence();
      unsubscribe();
      bridge.detach();
      view.destroy();
      viewRef.current = null;
      bridgeRef.current = null;
    };
  }, [client, docId, actorId, groupIds]);

  return (
    <div className="h-full">
      <div ref={containerRef} className="h-full" />
    </div>
  );
}
