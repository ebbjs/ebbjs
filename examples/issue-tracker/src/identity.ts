/**
 * The demo's actor onboarding.
 *
 * `bootstrap` needs an actor id, and the demo runs in two auth worlds:
 *
 * - **bypass** — the actor is the `?actor=` pick, so the app must keep its
 *   picker. A headerless `GET /sync/identity` is rejected there, which is the
 *   signal that the deployment is not server-derived.
 * - **tailscale** (and any future server-derived mode) — the gateway knows the
 *   login and the browser does not. Ask `resolveIdentity`, skip the picker,
 *   and use the resolved id.
 *
 * Resolution is the one online step. The id is cached per server so a later
 * load can start offline; a successful resolve that names a different actor
 * overwrites the cache (a Tailscale login change is a new actor, not an error
 * at page load).
 */

import {
  ActionRejectedError,
  IdentityResolutionError,
  resolveIdentity,
  type IdentityProvider,
} from "@ebbjs/client";

const CACHE_PREFIX = "ebb-issue-tracker:identity:";

/** The slice of `localStorage` this module needs, so tests avoid a DOM. */
export interface IdentityCache {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DemoIdentity {
  readonly actorId: string;
  readonly provider: IdentityProvider;
  readonly displayName?: string;
  /** True when the server was unreachable and the id came from the cache. */
  readonly cached: boolean;
}

export interface ResolveDemoIdentityOptions {
  readonly serverUrl: string;
  /** The `?actor=` pick, used when the server is not server-derived. */
  readonly fallbackActorId: string;
  readonly fetchImpl?: typeof fetch;
  /** Defaults to `localStorage` in the browser; `null` disables caching. */
  readonly cache?: IdentityCache | null;
  readonly signal?: AbortSignal;
}

/** The demo's actor picker belongs to bypass auth only. */
export function usesActorPicker(provider: IdentityProvider): boolean {
  return provider === "bypass";
}

function cacheKey(serverUrl: string): string {
  return `${CACHE_PREFIX}${serverUrl === "" ? "same-origin" : serverUrl}`;
}

function defaultCache(): IdentityCache | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // A browser can deny storage (private mode, blocked cookies).
    return null;
  }
}

function readCache(key: string, cache: IdentityCache | null): DemoIdentity | null {
  if (cache === null) return null;
  try {
    const raw = cache.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as {
      actorId?: unknown;
      provider?: unknown;
      displayName?: unknown;
    };
    if (typeof parsed.actorId !== "string" || parsed.actorId === "") return null;
    if (parsed.provider !== "tailscale" && parsed.provider !== "external") return null;
    return {
      actorId: parsed.actorId,
      provider: parsed.provider,
      ...(typeof parsed.displayName === "string" ? { displayName: parsed.displayName } : {}),
      cached: true,
    };
  } catch {
    return null;
  }
}

function writeCache(key: string, cache: IdentityCache | null, identity: DemoIdentity): void {
  if (cache === null || identity.provider === "bypass") return;
  try {
    cache.setItem(
      key,
      JSON.stringify({
        actorId: identity.actorId,
        provider: identity.provider,
        ...(identity.displayName === undefined ? {} : { displayName: identity.displayName }),
      }),
    );
  } catch {
    // A full or denied storage is not worth failing onboarding over.
  }
}

/**
 * Resolve the actor the app should bootstrap as.
 *
 * A `network` failure falls back to the cached identity so an installed app
 * starts offline. Every other failure is rethrown: an unauthenticated request
 * (401, the bypass path) resolves to the `?actor=` pick, while an HTML proxy
 * page or a 5xx should stop onboarding with an explanation rather than
 * pretending a cached identity is current.
 */
export async function resolveDemoIdentity(opts: ResolveDemoIdentityOptions): Promise<DemoIdentity> {
  const cache = opts.cache === undefined ? defaultCache() : opts.cache;
  const key = cacheKey(opts.serverUrl);

  try {
    const identity = await resolveIdentity({
      serverUrl: opts.serverUrl,
      fetchImpl: opts.fetchImpl,
      signal: opts.signal,
    });
    const resolved: DemoIdentity = {
      actorId: identity.actorId,
      provider: identity.provider,
      ...(identity.displayName === undefined ? {} : { displayName: identity.displayName }),
      cached: false,
    };
    writeCache(key, cache, resolved);
    return resolved;
  } catch (err) {
    if (err instanceof IdentityResolutionError && err.kind === "unauthorized") {
      return { actorId: opts.fallbackActorId, provider: "bypass", cached: false };
    }
    if (err instanceof IdentityResolutionError && err.kind === "network") {
      const cached = readCache(key, cache);
      if (cached !== null) return cached;
    }
    throw err;
  }
}

/** An onboarding failure the app can show, with the recovery it implies. */
export function describeIdentityFailure(err: unknown): string {
  if (err instanceof IdentityResolutionError) {
    switch (err.kind) {
      case "unauthorized":
        return (
          "The server did not authenticate this browser. In Tailscale mode, " +
          "open the app through the Tailscale-served URL so the gateway can inject your identity."
        );
      case "invalid-response":
        return (
          "Something other than the ebb server answered /sync/identity — " +
          "often a proxy login page. Check the server URL."
        );
      case "http":
        return `The server could not report an identity (HTTP ${err.status ?? "error"}).`;
      case "network":
        return (
          "Could not reach the server to learn your identity. A first run needs " +
          "connectivity; after that the cached actor starts the app offline."
        );
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turn a server refusal into advice the user can act on. A Tailscale login
 * change makes the cached actor stale, and every write is then rejected with
 * `actor_mismatch`; retrying cannot help, but a reload re-resolves the identity
 * and re-bootstraps under the new actor.
 */
export function describeWriteError(err: unknown): string | null {
  if (
    err instanceof ActionRejectedError &&
    err.rejections.some((rejection) => rejection.reason === "actor_mismatch")
  ) {
    return (
      "Your server-side identity changed (a different Tailscale login). " +
      "Reload the page to sign in with the new identity — retrying this write cannot succeed."
    );
  }
  return null;
}
