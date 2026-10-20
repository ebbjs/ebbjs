/**
 * Shared harness for the issue-tracker integration tests: the server
 * probe every `it` short-circuits on, and the row lookup the query
 * grammar still needs. The group catch-up helpers live in
 * `../sync-groups` so bootstrap and the tests share one implementation.
 */

import { SEEDER_ACTOR_ID } from "../seed";

export const SERVER_URL = process.env.EBB_TEST_URL ?? "http://localhost:4000";

let reachable: boolean | null = null;

async function ping(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/sync/handshake`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ebb-actor-id": SEEDER_ACTOR_ID },
      body: "{}",
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Probe once per run; every test returns early when the server is down. */
export async function serverIsReachable(): Promise<boolean> {
  if (reachable !== null) return reachable;
  reachable = await ping(SERVER_URL);
  return reachable;
}

/**
 * Pick one projected row out of a query result by its `id`. The query
 * grammar has no id predicate yet, so a single-row assertion reads the
 * visible collection and selects the row here.
 */
export function findRow<T extends { readonly id: string }>(
  rows: readonly T[],
  id: string,
): T | undefined {
  return rows.find((row) => row.id === id);
}
