/**
 * Server-derived actor identity.
 *
 * `SyncClient` is constructed with the actor it writes as, and the server
 * rejects an Action whose `actor_id` differs from the authenticated actor
 * (`actor_mismatch`). In `tailscale` mode the browser cannot know that actor
 * before asking: a gateway resolves the Tailscale user from its own session
 * and injects the identity headers. {@link resolveIdentity} is the one read
 * that closes that gap — it asks `GET /sync/identity` who the server thinks
 * the caller is, and the caller then builds the client with that id.
 *
 * The helper is transport-thin: one GET, a typed result, and an error kind a
 * caller can branch on. It deliberately sends no `x-ebb-actor-id`; the server
 * is authoritative, and a client-supplied id would defeat the point.
 *
 * ## Consequences worth designing around
 *
 * - **First run needs connectivity.** There is no way to learn an actor the
 *   server derived while offline, so cache the resolved id for the app's
 *   storage key and start from the cache when the request fails.
 * - **A login change is a new actor.** A client still holding the old id
 *   writes with it, gets `actor_mismatch`, and cannot recover by retrying:
 *   re-resolve, build a new `SyncClient` for the new `actorId`, and use that
 *   actor's storage. Storage keys are per actor, so the old cache stays
 *   behind with the old actor, which is what you want.
 */

/** The auth mode that resolved the request's actor. */
export type IdentityProvider = "bypass" | "external" | "tailscale";

/** Why {@link resolveIdentity} failed. */
export type IdentityResolutionErrorKind = "network" | "unauthorized" | "invalid-response" | "http";

/** The actor the server derived from the request. */
export interface ResolvedIdentity {
  /** The actor id `createClient` requires; stable for a given login. */
  readonly actorId: string;
  /** Which auth mode produced the actor. */
  readonly provider: IdentityProvider;
  /** Human-readable name from the identity provider, when it supplies one. */
  readonly displayName?: string;
  /** Numeric provider user id, when the identity provider supplies one. Never authorization. */
  readonly providerId?: number;
}

/** What {@link resolveIdentity} takes. */
export interface ResolveIdentityOptions {
  /** Base URL of the ebb server; trailing slashes are ignored. */
  readonly serverUrl: string;
  /** Test / custom-transport seam; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Aborts the request; a rejection surfaces as a `network` error. */
  readonly signal?: AbortSignal;
}

/**
 * A failed identity resolution.
 *
 * `kind` is the actionable part: `network` means the request never got an
 * answer (start from a cached actor if there is one); `unauthorized` means
 * the server could not authenticate this client (log in through its provider,
 * then resolve again); `invalid-response` means something other than an ebb
 * server answered (a proxy, a captive portal, a wrong `serverUrl`); `http` is
 * any other status, in `status`.
 */
export class IdentityResolutionError extends Error {
  readonly kind: IdentityResolutionErrorKind;
  readonly status: number | undefined;

  constructor(
    kind: IdentityResolutionErrorKind,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "IdentityResolutionError";
    this.kind = kind;
    this.status = options.status;
  }
}

const PROVIDERS: readonly IdentityProvider[] = ["bypass", "external", "tailscale"];

const isProvider = (value: unknown): value is IdentityProvider =>
  typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);

/**
 * Ask the server which actor it derived for this request.
 *
 * Resolve before `createClient`, then pass `identity.actorId`; see the module
 * docs for the offline-start and login-change consequences. A failed
 * resolution throws {@link IdentityResolutionError} with a `kind` that says
 * what to do about it — never retry in a loop.
 *
 * @example
 * ```ts
 * const identity = await resolveIdentity({ serverUrl });
 * const client = createClient({ serverUrl, actorId: identity.actorId });
 * ```
 */
export async function resolveIdentity(opts: ResolveIdentityOptions): Promise<ResolvedIdentity> {
  const serverUrl = opts.serverUrl.replace(/\/+$/, "");
  const url = `${serverUrl}/sync/identity`;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: opts.signal,
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new IdentityResolutionError(
      "network",
      `identity request to ${url} failed: the server could not be reached (${detail}). ` +
        "Check that the ebb server is running at that url and reachable from here; a first run " +
        "needs connectivity, while a cached actor id can start the app offline.",
      { cause },
    );
  }

  if (response.status === 401) {
    throw new IdentityResolutionError(
      "unauthorized",
      `identity request was rejected (401): the server did not authenticate this client. ` +
        "Log in through the server's auth provider (a Tailscale login, an external identity " +
        "header, or bypass mode) and resolve again; `x-ebb-actor-id` is not a fallback.",
      { status: 401 },
    );
  }
  if (!response.ok) {
    throw new IdentityResolutionError(
      "http",
      `identity request failed: ${response.status} ${response.statusText}`.trim() +
        `. Check the server's logs and that ${serverUrl} points at a running ebb server.`,
      { status: response.status },
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new IdentityResolutionError(
      "invalid-response",
      `identity response from ${url} was not JSON: a proxy login page, a captive portal, or ` +
        "something other than the ebb server is answering this origin.",
      { cause },
    );
  }

  return parseIdentity(body, url);
}

function parseIdentity(body: unknown, url: string): ResolvedIdentity {
  const invalid = (detail: string): IdentityResolutionError =>
    new IdentityResolutionError(
      "invalid-response",
      `identity response from ${url} is not an ebb identity: ${detail}. ` +
        'The endpoint answers `{"actor_id", "provider", ...}`; a proxy or a wrong serverUrl ' +
        "usually answers differently.",
    );

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalid("expected a JSON object");
  }
  const raw = body as Record<string, unknown>;

  if (typeof raw.actor_id !== "string" || raw.actor_id === "") {
    throw invalid("`actor_id` is missing or not a non-empty string");
  }
  if (!isProvider(raw.provider)) {
    throw invalid("`provider` is not one of bypass, external, tailscale");
  }

  const displayName = raw.display_name;
  if (displayName !== undefined && typeof displayName !== "string") {
    throw invalid("`display_name` is not a string");
  }
  const providerId = raw.provider_id;
  if (providerId !== undefined && typeof providerId !== "number") {
    throw invalid("`provider_id` is not a number");
  }

  const identity: {
    actorId: string;
    provider: IdentityProvider;
    displayName?: string;
    providerId?: number;
  } = { actorId: raw.actor_id, provider: raw.provider };
  if (displayName !== undefined) identity.displayName = displayName;
  if (providerId !== undefined) identity.providerId = providerId;

  return identity;
}
