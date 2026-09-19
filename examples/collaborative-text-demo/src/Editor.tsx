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
const POLL_INTERVAL_MS = 250;

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

    // We poll catchUp() instead of using SSE for live updates. Vite's
    // dev proxy buffers SSE streams (a long-standing issue with
    // http-proxy + text/event-stream in dev mode), so subscribe()
    // hangs without ever delivering events. catchUp is plain chunked
    // JSON and flows through the proxy fine. For production deploys
    // behind nginx/Caddy, switch back to client.subscribe().
    let cancelled = false;
    let cursor = 0;
    const poll = async (): Promise<void> => {
      if (cancelled) return;
      try {
        for (const gid of groupIds) {
          const result = await client.catchUp(gid, cursor);
          for (const action of result.actions) {
            doc.applyActions([action]);
            if (action.gsn > cursor) cursor = action.gsn;
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[editor] catchUp error:", err);
      }
      if (!cancelled) setTimeout(poll, POLL_INTERVAL_MS);
    };
    void poll();

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
      cancelled = true;
      window.clearInterval(flushTimer);
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
