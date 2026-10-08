/**
 * Top-level demo app.
 *
 * Connects to the server at http://localhost:4000 and bootstraps the
 * demo group + member + doc via `seed()`.
 *
 * The actor identity is selected by:
 *   1. The `?actor=<id>` URL parameter (initial deep-link seed, e.g.
 *      `?actor=drew` for two-tab shareable demos), falling back to "drew".
 *   2. The in-app ActorPicker header control, which overrides (1)
 *      without touching the URL.
 *
 * Switching the actor triggers a full re-bootstrap: the old client's
 * SSE subscription is torn down and a new one opens under the new
 * identity. The same code path is exercised as a fresh tab load, which
 * surfaces bugs that would otherwise hide behind sticky connections.
 *
 * Layout: full-width CodeMirror editor + connection badge in the
 * corner + a collapsible conflict panel on the right.
 */

import { useEffect, useRef, useState } from "react";
import { Editor } from "./Editor";
import { ConnectionBadge } from "./ConnectionBadge";
import { ConflictPanel } from "./ConflictPanel";
import { ActorPicker, KNOWN_ACTORS, type ActorId, type KnownActor } from "./ActorPicker";
import { bootstrap, type BootstrapResult } from "./bootstrap";

const SERVER_URL = "";
const DEFAULT_ACTOR: ActorId = "drew";

/** Resolve the actor id from `?actor=` once on first render. */
function readInitialActor(): ActorId {
  if (typeof window === "undefined") return DEFAULT_ACTOR;
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("actor");
  if (fromUrl && KNOWN_ACTORS.includes(fromUrl as KnownActor)) return fromUrl as ActorId;
  if (fromUrl) return fromUrl as ActorId;
  return DEFAULT_ACTOR;
}

type AppState =
  | { status: "loading"; message: string }
  | { status: "error"; error: string }
  | { status: "ready"; bootstrap: BootstrapResult };

export function App() {
  const [actorId, setActorId] = useState<ActorId>(() => readInitialActor());
  const [state, setState] = useState<AppState>({
    status: "loading",
    message: "Connecting…",
  });

  useEffect(() => {
    let cancelled = false;
    // The bootstrap effect owns the client so its cleanup closes the
    // client this effect created. Closing it from a child's effect would
    // tear down the live client on React StrictMode's mount/unmount probe
    // (the child remounts with the same client value).
    let createdClient: BootstrapResult["client"] | null = null;
    void (async () => {
      try {
        setState({ status: "loading", message: `Connecting as ${actorId}\u2026` });
        const result = await bootstrap({ serverUrl: SERVER_URL, actorId });
        createdClient = result.client;
        if (cancelled) {
          result.client.close();
          return;
        }
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
      createdClient?.close();
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

  return (
    <Ready
      bootstrap={state.bootstrap}
      actorId={actorId}
      serverUrl={SERVER_URL}
      onActorChange={setActorId}
    />
  );
}

function Ready({
  bootstrap,
  actorId,
  serverUrl,
  onActorChange,
}: {
  bootstrap: BootstrapResult;
  actorId: ActorId;
  serverUrl: string;
  onActorChange: (actorId: ActorId) => void;
}) {
  const { client, groupIds, docId, docGroupId } = bootstrap;
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const conflictsButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b border-stone-800 px-4 py-2">
        <div className="font-mono text-xs text-stone-500">ebb collaborative text demo</div>
        <ActorPicker value={actorId} onChange={onActorChange} />
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
            docId={docId}
            actorId={actorId}
            groupIds={groupIds}
            caughtUpActions={bootstrap.caughtUpActions}
          />
        </div>
        {conflictsOpen && (
          <aside className="w-80 shrink-0 border-l border-stone-800 overflow-y-auto">
            <ConflictPanel client={client} docId={docId} groupId={docGroupId} />
          </aside>
        )}
      </div>

      <footer className="border-t border-stone-800 px-4 py-2 font-mono text-xs text-stone-500">
        Open this URL in another tab with{" "}
        <code className="bg-stone-800 px-1 rounded">?actor=alice</code> to see live editing, or pick
        another actor above.
      </footer>
    </div>
  );
}
