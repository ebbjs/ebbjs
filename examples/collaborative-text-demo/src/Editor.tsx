/**
 * Editor component — CodeMirror 6 wired to a TextDocument via
 * @ebbjs/collaborative-text-editor.
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
import { createClient } from "@ebbjs/client";
import {
  createBridgeExtension,
  createIdMapField,
  mountEditorBridge,
} from "@ebbjs/collaborative-text-editor";

interface Props {
  client: ReturnType<typeof createClient>;
  docId: string;
  actorId: string;
  groupIds: readonly string[];
}

const FLUSH_INTERVAL_MS = 250;

export function Editor({ client, docId, actorId, groupIds }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const bridgeRef = useRef<{ detach: () => void } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const doc = client.textDocument(docId);
    const idMapField = createIdMapField();

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

    // Subscribe to SSE for live updates. The browser's EventSource
    // can't set custom request headers, so the @ebbjs/client SSE
    // client passes the actor id via the ?actor_id= query param.
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
