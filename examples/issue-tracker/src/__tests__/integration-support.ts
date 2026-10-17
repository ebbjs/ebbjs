/**
 * Shared harness for the issue-tracker integration tests: the server
 * probe every `it` short-circuits on, and the `catchUp` drain the
 * fixtures use. Kept out of the two `*.integration.test.ts` files so the
 * ping/skip pattern is defined once.
 */

import type { SyncClient } from "@ebbjs/client";
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

/** Drive `client.catchUp` until the server reports `upToDate: true`. */
export async function catchUpUntilCurrent(client: SyncClient, groupId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const { upToDate } = await client.catchUp(groupId);
    if (upToDate) return;
  }
  throw new Error(`catchUpUntilCurrent: exhausted retries for group ${groupId}`);
}
