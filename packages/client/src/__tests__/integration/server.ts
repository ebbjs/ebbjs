/**
 * Shared scaffold for the integration suites in this directory.
 *
 * Every suite here talks to a real ebb_server. `serverReachable` is probed once
 * as this module loads, and each suite gates its `it`s on it through
 * `itIfServer`, so an absent server reports the tests as skipped. A per-`it`
 * `if (!ready) return;` would report them as passing.
 *
 * A suite whose fixtures (or auth mode) are a second gate on top of
 * reachability builds its own wrapper from `itIf(...)`.
 */

import { it } from "vitest";

/** `EBB_TEST_URL`, or the local default the client README documents. */
export const SERVER_URL = process.env.EBB_TEST_URL ?? "http://localhost:4000";

/**
 * The tailscale-mode suite's URL. A tailscale-mode server binds loopback only,
 * so its default is `127.0.0.1` rather than the `localhost` every other suite
 * uses. `EBB_TEST_URL` still applies to it when a caller sets one.
 */
export const TAILSCALE_SERVER_URL =
  process.env.EBB_TAILSCALE_TEST_URL ?? process.env.EBB_TEST_URL ?? "http://127.0.0.1:4000";

/** A suffix unique to this run, so a suite is reentrant against one server. */
export const runId = (): string =>
  `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** The actor the reachability probe handshakes as; no grant is needed for one. */
const PROBE_ACTOR = "integration-probe";

/**
 * One request, or `null` when nothing answered. A 4xx counts as an answer:
 * reachability is "a server is listening", not "this actor is authorized".
 */
export async function probe(url: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, init);
  } catch {
    return null;
  }
}

/** A handshake body for `actorId`, the endpoint every suite uses as its probe. */
export const handshakeInit = (actorId: string): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", "x-ebb-actor-id": actorId },
  body: "{}",
});

const probed = await probe(`${SERVER_URL}/sync/handshake`, handshakeInit(PROBE_ACTOR));

/** Whether an ebb server answered at {@link SERVER_URL}. Probed once per run. */
export const serverReachable = probed !== null && probed.status < 500;

if (!serverReachable) {
  console.warn(`[skip] integration tests — no ebb server reachable at ${SERVER_URL}`);
}

/** Registers `name` as a test when `ready`, and as a reported skip otherwise. */
export const itIf =
  (ready: boolean) =>
  (name: string, body: () => unknown): void => {
    if (ready) it(name, body);
    else it.skip(name, body);
  };

/** The suites' default gate: a server answered at load time. */
export const itIfServer = itIf(serverReachable);
