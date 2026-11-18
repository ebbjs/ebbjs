/**
 * The egress guardrail: a `fetch` shim installed for the duration of one
 * invocation.
 *
 * The process boundary is not a security sandbox; native `fetch` stays
 * reachable through `new Function`. This shim is the guardrail the runtime can
 * offer inside the process, and the deployment's egress policy is the real
 * boundary. What the shim enforces:
 *
 * - an allowlist, when the host states one: a request whose URL hostname (and,
 *   when the entry names one, port) is not listed is refused before it is sent;
 * - a response byte cap: a `content-length` over the cap is refused without
 *   reading, and a chunked body that grows past it errors the stream the
 *   handler is reading.
 *
 * An allowlist is validated when the guard is built, before the handler runs.
 * A list containing an entry this module cannot read fails the invocation
 * rather than compiling to a shorter one: a dropped entry is wider egress, and
 * the failure mode of the tempting spellings (`10.0.0.0/8`, `*.corp.example`)
 * has to be a clear error, never a silently unrestricted or silently empty
 * allowlist. Wildcards are not supported; list each host.
 *
 * What it does not enforce: the same socket can be reached by other globals
 * (Bun's `Bun.fetch`, a native module), a handler can keep a response it
 * obtained before the shim was restored, and an audit frame records the
 * response, not what the handler read from it. A blocked request is audited
 * with `status: null`; a response refused for size is audited with its real
 * status, because the request completed.
 */

import { DEFAULT_LIMITS, type FetchAuditFields } from "@ebbjs/functions-protocol";

/** The response cap when the host states none. */
export const DEFAULT_MAX_FETCH_RESPONSE_BYTES = DEFAULT_LIMITS.max_fetch_response_bytes;

/** The response statuses that cannot carry a body, so cannot be rebuilt. */
const BODYLESS_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/** A request the allowlist refused, before anything was sent. */
export class FetchBlockedError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(`fetch blocked: ${url} is not on this function's fetch allowlist`);
    this.name = "FetchBlockedError";
    this.url = url;
  }
}

/**
 * An allowlist entry the shim cannot read, raised before the handler runs.
 *
 * Throwing is the fail-closed answer: a request the list did not name must not
 * be reachable just because the list itself was malformed.
 */
export class FetchAllowlistError extends Error {
  readonly entry: unknown;

  constructor(entry: unknown, reason: string) {
    super(
      `fetch allowlist entry ${describeEntry(entry)} ${reason}; ` +
        "refusing the invocation rather than running it with egress the list did not name",
    );
    this.name = "FetchAllowlistError";
    this.entry = entry;
  }
}

/** A response the shim refused because it is larger than the cap. */
export class FetchResponseTooLargeError extends Error {
  readonly url: string;
  readonly limit: number;

  constructor(url: string, limit: number) {
    super(`fetch response from ${url} exceeds the ${limit}-byte response limit`);
    this.name = "FetchResponseTooLargeError";
    this.url = url;
    this.limit = limit;
  }
}

export interface FetchGuardOptions {
  /**
   * The host's allowlist as it arrived. `undefined`, `null`, or an empty list
   * means unrestricted; a non-empty list is read as `host`, `host:port`,
   * `[v6]:port`, or URL entries, and every other value — `*` included, and
   * anything that is not a list of strings — is a `FetchAllowlistError`.
   */
  readonly allowlist: unknown;
  readonly maxResponseBytes?: number;
  /** Called once per request, on completion or failure. Must not throw. */
  readonly audit: (fields: FetchAuditFields) => void;
}

/** One allowlist entry: a hostname, and the port when the entry pins one. */
interface AllowlistEntry {
  readonly hostname: string;
  readonly port: string | null;
}

/**
 * Installs the guarded `fetch` on `globalThis` and returns the restore.
 *
 * The shim is installed for every invocation, allowlist or not, because the
 * response cap and the audit frame apply either way. Throws
 * `FetchAllowlistError` before touching `globalThis.fetch` when the allowlist
 * does not compile.
 */
export function installFetchGuard(options: FetchGuardOptions): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = createGuardedFetch(original, options);

  return () => {
    globalThis.fetch = original;
  };
}

/** The guarded `fetch` itself, with the original passed in so it is testable. */
export function createGuardedFetch(
  original: typeof globalThis.fetch,
  options: FetchGuardOptions,
): typeof globalThis.fetch {
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_FETCH_RESPONSE_BYTES;
  const allowlist = compileAllowlist(options.allowlist);

  return async (input, init) => {
    const started = performance.now();
    const url = urlOf(input);
    const method = methodOf(input, init);

    const audit = (status: number | null, blocked: boolean): void => {
      try {
        options.audit({
          method,
          url,
          status,
          duration_ms: Math.max(0, Math.round(performance.now() - started)),
          blocked,
        });
      } catch {
        // Telemetry must never fail the request it describes.
      }
    };

    if (allowlist.length > 0 && !isAllowed(allowlist, url)) {
      audit(null, true);
      throw new FetchBlockedError(url);
    }

    let response: Response;
    try {
      response = await original(input, init);
    } catch (error) {
      audit(null, false);
      throw error;
    }

    const declared = declaredLength(response);
    if (declared !== null && declared > maxBytes) {
      audit(response.status, false);
      await discard(response);
      throw new FetchResponseTooLargeError(url, maxBytes);
    }

    audit(response.status, false);
    // A declared length that fits is proof enough: pass the original response
    // through so `url`, `redirected`, and the header set are untouched. Only a
    // body of unknown length needs the streaming wrapper.
    return declared !== null ? response : cappedResponse(response, url, maxBytes);
  };
}

/** The response's declared body length, or `null` when it declares none. */
function declaredLength(response: Response): number | null {
  const header = response.headers.get("content-length");
  if (header === null) return null;

  const length = Number(header);
  return Number.isFinite(length) && length >= 0 ? length : null;
}

/**
 * The response with its body capped as it is read.
 *
 * A rebuilt `Response` is the portable way to cap a stream, at the cost of
 * `url`, `redirected`, `type`, and the exact `set-cookie` list, none of which
 * are carried over. A response that cannot carry a body is passed through
 * untouched: there is nothing to cap.
 */
function cappedResponse(response: Response, url: string, maxBytes: number): Response {
  if (response.body === null || response.status === 0 || BODYLESS_STATUSES.has(response.status)) {
    return response;
  }

  try {
    return new Response(response.body.pipeThrough(byteLimit(url, maxBytes)), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch {
    // A status or header set this runtime refuses to rebuild: the response the
    // handler already has is better than failing a request that succeeded.
    return response;
  }
}

/** A transform that errors the body once it has produced more than `maxBytes`. */
function byteLimit(url: string, maxBytes: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;

  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(new FetchResponseTooLargeError(url, maxBytes));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

/** Best-effort: stop reading a response we are about to refuse. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is refused either way.
  }
}

/** The request URL, without touching a `Request`'s body or a URL's parts. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (typeof input === "object" && input !== null && "url" in input) {
    return String((input as { readonly url: unknown }).url);
  }

  return String(input);
}

/** The request method: `init` wins over the `Request`'s own. */
function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  if (typeof init?.method === "string" && init.method !== "") return init.method.toUpperCase();
  if (typeof input === "object" && input !== null && "method" in input) {
    return String((input as { readonly method: unknown }).method).toUpperCase();
  }

  return "GET";
}

/**
 * Compiles the host's allowlist, one entry at a time.
 *
 * An entry may be a bare hostname, `host:port`, a bracketed IPv6 literal, or a
 * full URL. An entry without a port allows every port on that host; an entry
 * with one requires it. Any other entry throws `FetchAllowlistError`: dropping
 * it would narrow the list, and a narrowed list is not the one the host wrote.
 * `undefined` and `null` mean the host stated no allowlist; a value that is
 * not a list throws for the same reason.
 */
export function compileAllowlist(value: unknown): readonly AllowlistEntry[] {
  if (value === undefined || value === null) return [];

  if (!Array.isArray(value)) {
    throw new FetchAllowlistError(value, "is not a list of host entries");
  }

  return value.map(parseAllowlistEntry);
}

function parseAllowlistEntry(entry: unknown): AllowlistEntry {
  if (typeof entry !== "string") {
    throw new FetchAllowlistError(entry, "is not a string");
  }

  const trimmed = entry.trim().toLowerCase();
  if (trimmed === "") {
    throw new FetchAllowlistError(entry, "is empty");
  }

  if (trimmed.includes("*")) {
    throw new FetchAllowlistError(entry, 'contains "*", but wildcards are not supported');
  }

  if (trimmed.includes("://")) {
    const url = parseUrl(trimmed, entry);
    if (url.hostname === "") {
      throw new FetchAllowlistError(entry, "names no host");
    }
    return { hostname: url.hostname, port: url.port || null };
  }

  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(trimmed);
  if (bracketed !== null) {
    const [, hostname, port] = bracketed;
    if (hostname === undefined) throw new FetchAllowlistError(entry, "names no host");
    // `URL.hostname` keeps the brackets on an IPv6 literal, so the entry does too.
    return { hostname: `[${hostname}]`, port: port ?? null };
  }

  const hostPort = /^([^:\s/]+)(?::(\d{1,5}))?$/.exec(trimmed);
  if (hostPort === null) {
    throw new FetchAllowlistError(entry, "is not a host, host:port, [v6]:port, or URL");
  }

  const [, hostname, port] = hostPort;
  if (hostname === undefined) throw new FetchAllowlistError(entry, "names no host");
  return { hostname, port: port ?? null };
}

function parseUrl(trimmed: string, entry: unknown): URL {
  try {
    return new URL(trimmed);
  } catch {
    throw new FetchAllowlistError(entry, "is not a URL");
  }
}

/** The entry as the operator wrote it, for a message a human can act on. */
function describeEntry(entry: unknown): string {
  if (typeof entry === "string") return JSON.stringify(entry);

  try {
    return JSON.stringify(entry) ?? String(entry);
  } catch {
    return String(entry);
  }
}

/** Whether `rawUrl` matches an allowlist entry. A relative URL matches none. */
function isAllowed(allowlist: readonly AllowlistEntry[], rawUrl: string): boolean {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  const port = effectivePort(url);

  return allowlist.some(
    (entry) => entry.hostname === hostname && (entry.port === null || entry.port === port),
  );
}

/** The URL's port, with the scheme's default filled in when it states none. */
function effectivePort(url: URL): string {
  if (url.port !== "") return url.port;
  if (url.protocol === "https:") return "443";
  if (url.protocol === "http:") return "80";

  return "";
}
