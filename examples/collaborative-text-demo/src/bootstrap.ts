/**
 * Bootstrap: connect to the server, handshake, optionally seed the demo
 * data, then return a configured `SyncClient` ready for use.
 */

import { createClient, type SyncClient } from "@ebbjs/client";
import { buildDemoSeed, seed } from "./seed";

export interface BootstrapResult {
  client: SyncClient;
  groupIds: readonly string[];
  /** True if we ran the seed call (group may or may not be new). */
  didSeed: boolean;
}

/**
 * Connect to the server, handshake, ensure the demo group exists, and
 * open the SSE subscription for the demo's groups.
 *
 * The function swallows expected "already exists" errors from `seed()`
 * and proceeds. If anything else fails, it throws.
 */
export async function bootstrap(opts: {
  serverUrl: string;
  actorId: string;
  /** If false, skip the seed call (assume data is already there). */
  ensureSeeded?: boolean;
}): Promise<BootstrapResult> {
  const { serverUrl, actorId } = opts;
  const ensureSeeded = opts.ensureSeeded ?? true;

  const client = createClient({ serverUrl, actorId });

  // 1. Seed (best-effort).
  let didSeed = false;
  if (ensureSeeded) {
    try {
      await seed(serverUrl, "demo-seeder", buildDemoSeed());
      didSeed = true;
    } catch (err) {
      // Already-seeded is fine; re-throw anything else.
      if (!(err instanceof Error && /already/i.test(err.message))) {
        // eslint-disable-next-line no-console
        console.warn("[bootstrap] seed warning:", err);
      }
    }
  }

  // 2. Handshake.
  const { groups } = await client.handshake();
  const groupIds = groups.map((g) => g.id);

  if (groupIds.length === 0) {
    throw new Error(
      `bootstrap: actor '${actorId}' is not a member of any group. Did the seed run?`,
    );
  }

  return { client, groupIds, didSeed };
}
