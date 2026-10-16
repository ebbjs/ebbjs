/**
 * Top-level issue-tracker app.
 *
 * The actor identity comes from `?actor=<id>` (initial deep-link seed,
 * default `alice`) and can be changed in-app with the ActorPicker.
 * Switching actor tears the old client down and re-bootstraps under the
 * new identity — the same path a fresh load takes.
 *
 * Ready state is wrapped in `EbbProvider`, so the header's
 * `useConnection()` badge, the workspace switcher, the profile card, and
 * the issue list all read the typed client from context.
 */

import { useEffect, useState } from "react";
import { EbbProvider } from "@ebbjs/react";
import { ActorPicker, type ActorId } from "./ActorPicker";
import { ConnectionBadge } from "./ConnectionBadge";
import { IssueCreateForm } from "./IssueCreateForm";
import { IssueDetail } from "./IssueDetail";
import { IssueList } from "./IssueList";
import { ProfileCard } from "./ProfileCard";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { bootstrap, type BootstrapResult } from "./bootstrap";

const SERVER_URL = "";
const DEFAULT_ACTOR: ActorId = "alice";

/** Resolve the actor id from `?actor=` once on first render. */
function readInitialActor(): ActorId {
  if (typeof window === "undefined") return DEFAULT_ACTOR;
  const fromUrl = new URLSearchParams(window.location.search).get("actor");
  if (fromUrl === null || fromUrl === "") return DEFAULT_ACTOR;
  return fromUrl;
}

type AppState =
  | { status: "loading"; message: string }
  | { status: "error"; error: string }
  | { status: "ready"; bootstrap: BootstrapResult };

export function App() {
  const [actorId, setActorId] = useState<ActorId>(() => readInitialActor());
  const [state, setState] = useState<AppState>({ status: "loading", message: "Connecting…" });

  useEffect(() => {
    let cancelled = false;
    // The effect owns the client it creates, so its cleanup closes that
    // client. A child closing it would tear the live client down on
    // StrictMode's mount/unmount probe.
    let created: BootstrapResult | null = null;
    void (async () => {
      try {
        setState({ status: "loading", message: `Connecting as ${actorId}\u2026` });
        const result = await bootstrap({ serverUrl: SERVER_URL, actorId });
        created = result;
        if (cancelled) {
          result.unsubscribe();
          result.client.close();
          return;
        }
        setState({ status: "ready", bootstrap: result });
      } catch (err) {
        if (cancelled) return;
        setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
      created?.unsubscribe();
      created?.client.close();
    };
  }, [actorId]);

  if (state.status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-stone-400">
          <div className="mb-2 font-mono text-sm">actor: {actorId}</div>
          <div>{state.message}</div>
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="max-w-md text-center">
          <div className="mb-2 font-mono text-sm text-red-400">connection error</div>
          <div className="text-sm text-stone-300">{state.error}</div>
          <div className="mt-4 text-xs text-stone-500">
            Is <code className="rounded bg-stone-800 px-1">mix dev</code> running on port 4000?
          </div>
        </div>
      </div>
    );
  }

  return (
    <EbbProvider client={state.bootstrap.client}>
      <AppShell
        key={actorId}
        actorId={actorId}
        onActorChange={setActorId}
        defaultGroupId={state.bootstrap.defaultGroupId}
      />
    </EbbProvider>
  );
}

function AppShell({
  actorId,
  onActorChange,
  defaultGroupId,
}: {
  actorId: ActorId;
  onActorChange: (actorId: ActorId) => void;
  defaultGroupId: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-4 border-b border-stone-800 px-4 py-2">
        <div className="font-mono text-xs text-stone-500">ebb issue tracker</div>
        <ActorPicker value={actorId} onChange={onActorChange} />
        <WorkspaceSwitcher />
        <div className="ml-auto" />
        <ConnectionBadge />
      </header>

      <main className="flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto p-4">
        <ProfileCard actorId={actorId} />
        <div className="grid gap-4 xl:grid-cols-2">
          <IssueList
            selectedId={selectedId}
            onSelect={(id) => {
              setCreating(false);
              setSelectedId(id);
            }}
            onNewIssue={() => {
              setCreating(true);
              setSelectedId(null);
            }}
          />
          {creating ? (
            <IssueCreateForm
              groupId={defaultGroupId}
              onCreated={(id) => {
                setCreating(false);
                setSelectedId(id);
              }}
              onCancel={() => setCreating(false)}
            />
          ) : (
            selectedId !== null && (
              <IssueDetail
                issueId={selectedId}
                onClose={() => setSelectedId(null)}
                onDeleted={() => setSelectedId(null)}
              />
            )
          )}
        </div>
      </main>

      <footer className="border-t border-stone-800 px-4 py-2 font-mono text-xs text-stone-500">
        Open this URL in another tab with{" "}
        <code className="rounded bg-stone-800 px-1">?actor=bob</code> to seed a second actor, or
        pick another actor above.
      </footer>
    </div>
  );
}
