/**
 * Top-level issue-tracker app.
 *
 * The actor identity comes from `?actor=<id>` (initial deep-link seed,
 * default `alice`) and can be changed in-app with the ActorPicker.
 * Switching actor tears the old client down and re-bootstraps under the
 * new identity — the same path a fresh load takes.
 *
 * Ready state is wrapped in `EbbProvider`, so the header's
 * `useConnection()` badge, the workspace switcher, the membership
 * panel, the profile card, and the issue list/board all read the typed
 * client from context.
 */

import { useEffect, useState } from "react";
import { EbbProvider } from "@ebbjs/react";
import { ActorPicker, type ActorId } from "./ActorPicker";
import { ConnectionBadge } from "./ConnectionBadge";
import { IssueCreateForm } from "./IssueCreateForm";
import { IssueDetail } from "./IssueDetail";
import { IssuesPanel } from "./IssuesPanel";
import { MembershipPanel } from "./MembershipPanel";
import { ProfileCard } from "./ProfileCard";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { bootstrap, type BootstrapResult } from "./bootstrap";
import {
  describeIdentityFailure,
  resolveDemoIdentity,
  usesActorPicker,
  type DemoIdentity,
  type IdentityCache,
} from "./identity";

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
  | { status: "resolving" }
  | { status: "identity-error"; message: string }
  | { status: "loading"; message: string }
  | { status: "error"; error: string }
  | { status: "ready"; bootstrap: BootstrapResult; identity: DemoIdentity };

export interface AppProps {
  /** The onboarding test points these at a fake server and cache. */
  serverUrl?: string;
  fetchImpl?: typeof fetch;
  identityCache?: IdentityCache | null;
}

export function App({ serverUrl = SERVER_URL, fetchImpl, identityCache }: AppProps = {}) {
  const [actorId, setActorId] = useState<ActorId | null>(null);
  const [identity, setIdentity] = useState<DemoIdentity | null>(null);
  const [state, setState] = useState<AppState>({ status: "resolving" });

  // One resolve per page load. A different actor than the cached one is a
  // login change: it bootstraps as the new actor, whose per-actor storage is
  // separate from the old identity's.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resolved = await resolveDemoIdentity({
          serverUrl,
          fallbackActorId: readInitialActor(),
          fetchImpl,
          cache: identityCache,
        });
        if (cancelled) return;
        setIdentity(resolved);
        setActorId(resolved.actorId);
        setState({ status: "loading", message: `Connecting as ${resolved.actorId}\u2026` });
      } catch (err) {
        if (cancelled) return;
        setState({ status: "identity-error", message: describeIdentityFailure(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverUrl, fetchImpl, identityCache]);

  useEffect(() => {
    if (actorId === null) return;
    let cancelled = false;
    // The effect owns the client it creates, so its cleanup closes that
    // client. A child closing it would tear the live client down on
    // StrictMode's mount/unmount probe.
    let created: BootstrapResult | null = null;
    void (async () => {
      try {
        setState({ status: "loading", message: `Connecting as ${actorId}\u2026` });
        const result = await bootstrap({ serverUrl, actorId });
        created = result;
        if (cancelled) {
          result.close();
          return;
        }
        setState({
          status: "ready",
          bootstrap: result,
          identity: identity ?? { actorId, provider: "bypass", cached: false },
        });
      } catch (err) {
        if (cancelled) return;
        setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
      created?.close();
    };
  }, [actorId, serverUrl, identity]);

  if (state.status === "resolving") {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-stone-400">
          <div className="mb-2 font-mono text-sm">resolving identity…</div>
          <div>Connecting…</div>
        </div>
      </div>
    );
  }

  if (state.status === "identity-error") {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="max-w-md text-center">
          <div className="mb-2 font-mono text-sm text-red-400">identity error</div>
          <div className="text-sm text-stone-300">{state.message}</div>
        </div>
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-stone-400">
          <div className="mb-2 font-mono text-sm">actor: {actorId ?? "…"}</div>
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
        key={actorId ?? state.identity.actorId}
        actorId={actorId ?? state.identity.actorId}
        identity={state.identity}
        onActorChange={setActorId}
        defaultGroupId={state.bootstrap.defaultGroupId}
        bootstrap={state.bootstrap}
      />
    </EbbProvider>
  );
}

function AppShell({
  actorId,
  identity,
  onActorChange,
  defaultGroupId,
  bootstrap,
}: {
  actorId: ActorId;
  identity: DemoIdentity;
  onActorChange: (actorId: ActorId) => void;
  defaultGroupId: string;
  bootstrap: BootstrapResult;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-4 border-b border-stone-800 px-4 py-2">
        <div className="font-mono text-xs text-stone-500">ebb issue tracker</div>
        {usesActorPicker(identity.provider) ? (
          <ActorPicker value={actorId} onChange={onActorChange} />
        ) : (
          <span className="font-mono text-xs text-stone-400">
            signed in as {identity.displayName ?? identity.actorId}
          </span>
        )}
        <WorkspaceSwitcher />
        <div className="ml-auto" />
        <ConnectionBadge />
      </header>

      <main className="flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto p-4">
        <ProfileCard actorId={actorId} />
        <MembershipPanel actorId={actorId} bootstrap={bootstrap} />
        <div className="grid gap-4 xl:grid-cols-2">
          <IssuesPanel
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
                key={selectedId}
                issueId={selectedId}
                onClose={() => setSelectedId(null)}
                onDeleted={() => setSelectedId(null)}
              />
            )
          )}
        </div>
      </main>

      <footer className="border-t border-stone-800 px-4 py-2 font-mono text-xs text-stone-500">
        {usesActorPicker(identity.provider) ? (
          <>
            Open this URL in another tab with{" "}
            <code className="rounded bg-stone-800 px-1">?actor=bob</code> to seed a second actor, or
            pick another actor above.
          </>
        ) : (
          <>The actor is the Tailscale login the gateway reports; the demo does not ask for one.</>
        )}
      </footer>
    </div>
  );
}
