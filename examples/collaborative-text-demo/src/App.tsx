/**
 * Top-level demo app.
 *
 * Reads the `?actor=<id>` URL parameter (default: "drew") and connects
 * to the server at http://localhost:4000. On first load it bootstraps
 * the demo group + member + doc via `seed()`.
 *
 * Layout: full-width CodeMirror editor + connection badge in the
 * corner + a collapsible conflict panel on the right.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Editor } from "./Editor";
import { ConnectionBadge } from "./ConnectionBadge";
import { ConflictPanel } from "./ConflictPanel";
import { bootstrap, type BootstrapResult } from "./bootstrap";
import { DEMO_DOC_ID, DEMO_GROUP_ID } from "./seed";

const SERVER_URL = "";
type AppState =
  | { status: "loading"; message: string }
  | { status: "error"; error: string }
  | { status: "ready"; bootstrap: BootstrapResult };

export function App() {
  const actorId = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("actor") ?? "drew";
  }, []);

  const [state, setState] = useState<AppState>({
    status: "loading",
    message: "Connecting…",
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        setState({ status: "loading", message: "Seeding demo data…" });
        const result = await bootstrap({ serverUrl: SERVER_URL, actorId });
        if (cancelled) return;
        setState({ status: "ready", bootstrap: result });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actorId]);

  if (state.status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-stone-400">
          <div className="text-sm font-mono mb-2">actor: {actorId}</div>
          <div>{state.message}</div>
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="max-w-md text-center">
          <div className="text-red-400 font-mono text-sm mb-2">connection error</div>
          <div className="text-stone-300 text-sm">{state.error}</div>
          <div className="text-stone-500 text-xs mt-4">
            Is <code className="bg-stone-800 px-1 rounded">mix dev</code> running on port 4000?
          </div>
        </div>
      </div>
    );
  }

  return <Ready bootstrap={state.bootstrap} actorId={actorId} serverUrl={SERVER_URL} />;
}

function Ready({
  bootstrap,
  actorId,
  serverUrl,
}: {
  bootstrap: BootstrapResult;
  actorId: string;
  serverUrl: string;
}) {
  const { client, groupIds } = bootstrap;
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const conflictsButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b border-stone-800 px-4 py-2">
        <div className="font-mono text-xs text-stone-500">ebb collaborative text demo</div>
        <div className="font-mono text-xs text-stone-300">
          actor: <span className="text-emerald-400">{actorId}</span>
        </div>
        <div className="font-mono text-xs text-stone-500 ml-auto">
          server: <span className="text-stone-300">{serverUrl}</span>
        </div>
        <button
          ref={conflictsButtonRef}
          onClick={() => setConflictsOpen((v) => !v)}
          className="rounded border border-stone-700 px-2 py-1 font-mono text-xs text-stone-300 hover:border-stone-500"
        >
          {conflictsOpen ? "Hide conflicts" : "Show conflicts"}
        </button>
        <ConnectionBadge client={client} />
      </header>

      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0">
          <Editor
            client={client}
            docId={DEMO_DOC_ID}
            actorId={actorId}
            groupIds={groupIds}
            caughtUpActions={bootstrap.caughtUpActions}
          />
        </div>
        {conflictsOpen && (
          <aside className="w-80 shrink-0 border-l border-stone-800 overflow-y-auto">
            <ConflictPanel client={client} docId={DEMO_DOC_ID} groupId={DEMO_GROUP_ID} />
          </aside>
        )}
      </div>

      <footer className="border-t border-stone-800 px-4 py-2 font-mono text-xs text-stone-500">
        Open this URL in another tab with{" "}
        <code className="bg-stone-800 px-1 rounded">?actor=alice</code> to see live editing.
      </footer>
    </div>
  );
}
