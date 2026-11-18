/**
 * The sync client's HTTP contract: the identity header, the base-URL shape,
 * and one policy for reading a response.
 *
 * Every request the client makes goes out with {@link actorHeaders}, and
 * every request whose body it reads comes back through {@link exchange}, so
 * a header, a failure message, or a body-read rule changes in one place
 * rather than per endpoint. The SSE stream keeps its own fetch wrapper (it
 * reads a stream, not a body) but shares the header builder and the
 * failure message.
 *
 * ## The body-read policy
 *
 * A response body is read exactly once, as text, guarded: a body that
 * cannot be read is `""` rather than a thrown error. JSON stays in the
 * caller's hands by parsing that text, which means the failure text a
 * thrown error carries is the same bytes the success path would have
 * parsed — no second read that could throw "body already consumed".
 *
 * A non-2xx response is an error naming the endpoint; a 2xx response whose
 * body is not JSON is an error naming the endpoint and echoing the body,
 * rather than a bare `SyntaxError` from `response.json()`.
 *
 * ## Teardown
 *
 * {@link withAbortSignal} is the one place a request learns how to be
 * cancelled: the sync client wraps its `fetch` with it at construction, so
 * `close()` reaches every call site that goes through {@link exchange}
 * without any of them naming a signal.
 */

/** Header carrying the acting identity on every sync request. */
export const ACTOR_HEADER = "x-ebb-actor-id";

/** The header bag for one request: the actor, plus whatever the call adds. */
export const actorHeaders = (
  actorId: string,
  extra: Record<string, string> = {},
): Record<string, string> => ({ [ACTOR_HEADER]: actorId, ...extra });

/**
 * A server base URL without its trailing slash, so a route builder can
 * append its own path.
 */
export const normalizeBaseUrl = (url: string): string => url.replace(/\/$/, "");

/** One response and the body text it was read into. */
export interface HttpExchange {
  readonly response: Response;
  /**
   * The response body, `""` when it could not be read. The only read of it:
   * `response.json()` would fail on a consumed body.
   */
  readonly text: string;
}

/** Read a body as text, degrading an unreadable one to `""`. */
export const readBody = async (response: Response): Promise<string> =>
  response.text().catch(() => "");

/**
 * The error for a failed request: the endpoint label, the status, and the
 * server's own body so a refusal explains itself.
 *
 * `body` is the text {@link exchange} already read; pass it, because a
 * second read of a response body throws.
 */
export const httpError = (response: Response, label: string, body = ""): Error =>
  new Error(`${label} failed: ${response.status} ${body}`.trim());

/** `JSON.parse` that answers `null` instead of throwing. */
export const tryParseJson = <T>(text: string): T | null => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

/**
 * Parse a 2xx body, naming the endpoint when the server answered with
 * something that is not JSON. A proxy's HTML error page is the common
 * case, and the body is the only thing that identifies it.
 */
export const parseJsonBody = <T>(text: string, label: string): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label}: server returned non-JSON response: ${text}`);
  }
};

/** Fetch `url` and read its body, without deciding what the status means. */
export const exchange = async (
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<HttpExchange> => {
  const response = await fetchImpl(url, init);
  return { response, text: await readBody(response) };
};

/**
 * Fetch `url` and answer its parsed JSON body, throwing a labelled error
 * for a failed status or a body that is not JSON. The endpoints that need
 * the response itself — a status with its own meaning, a header carrying a
 * cursor — use {@link exchange} instead.
 */
export const requestJson = async <T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  label: string,
): Promise<T> => {
  const { response, text } = await exchange(fetchImpl, url, init);
  if (!response.ok) throw httpError(response, label, text);
  return parseJsonBody<T>(text, label);
};

/**
 * Wrap `base` so every request carries `clientSignal`, merged with whatever
 * `signal` the call site supplied.
 *
 * One wrap, not a parameter per call site: {@link exchange} and
 * {@link requestJson} are the only ways a request leaves the client, so
 * handshake, catch-up, writes, entity reads, function calls, and the group
 * listing all inherit teardown from the constructor.
 *
 * `AbortSignal.any` would express the merge in one call, but it is Node 20.3+
 * while `sse.ts` documents Node 18 for consumers, so the listeners are managed
 * here. Two things follow from `clientSignal` being the one long-lived signal:
 *
 * - With no caller signal it is passed through unchanged, which keeps the
 *   whole response — body included — cancellable and registers no listener.
 * - With one, the two are merged and the client's listener detaches when the
 *   fetch settles (at the response headers, for a stream), so a request cannot
 *   leave a listener behind on the session-long signal. From there the caller
 *   owns the body, which is how `eventsource-client` tears a stream down.
 */
export const withAbortSignal =
  (base: typeof fetch, clientSignal: AbortSignal): typeof fetch =>
  (input, init) => {
    const callerSignal = init?.signal;
    if (callerSignal === undefined || callerSignal === null) {
      return base(input, { ...init, signal: clientSignal });
    }
    const merged = new AbortController();
    const abortFromClient = (): void => merged.abort(clientSignal.reason);
    const abortFromCaller = (): void => merged.abort(callerSignal.reason);
    const detachClient = (): void => {
      clientSignal.removeEventListener("abort", abortFromClient);
    };
    clientSignal.addEventListener("abort", abortFromClient, { once: true });
    callerSignal.addEventListener("abort", abortFromCaller, { once: true });
    // An already-aborted signal fires no event, so it is forwarded by hand.
    if (clientSignal.aborted) abortFromClient();
    if (callerSignal.aborted) abortFromCaller();
    let request: Promise<Response>;
    try {
      request = base(input, { ...init, signal: merged.signal });
    } catch (error) {
      // A malformed request throws before a promise exists to settle.
      detachClient();
      throw error;
    }
    return request.finally(detachClient);
  };
