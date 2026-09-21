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
import { createClient, type Action } from "@ebbjs/client";
import {
  createBridgeExtension,
  createIdMapField,
  createPresenceExtension,
  getPositionOfRun,
  getRunAtPosition,
  mountEditorBridge,
  setIdMapEffect,
} from "@ebbjs/codemirror";

interface Props {
  client: ReturnType<typeof createClient>;
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
      client.presence.setLocalCursor(docId, {
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
        // Render remote peers' cursors/selections. Reads from
        // client.presence and the bridge's idMapField to translate
        // run-id coordinates to CM positions.
        createPresenceExtension({
          getPresence: () => client.presence.forEntity(docId),
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

    // Open the local cursor/selection stream. The SSE stream the
    // client opens carries presence events back from other actors;
    // `client.presence` maintains the per-entity map.
    client.presence.start();
    client.presence.onUpdate(() => {
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
    const unsubscribe = client.subscribe(groupIds, 0, (event) => {
      if (event.type === "data") {
        doc.applyActions([event.action]);
      } else if (event.type === "control" && (event.control as { reconnect?: boolean }).reconnect) {
        // Server told us our cursor is stale — let subscribe's
        // own retry logic handle the reconnect; just log.
        // eslint-disable-next-line no-console
        console.warn("[editor] server requested reconnect:", event.control);
      }
    });

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
