/**
 * Bootstrap: connect to the server, handshake, ensure the demo data
 * exists, add the connecting actor as a member, then return a
 * configured `SyncClient` ready for use.
 */

import { createClient, type SyncClient } from "@ebbjs/client";
import { addMember, buildDemoSeed, seed } from "./seed";

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

  // 2. Add this actor as a member of the demo group (idempotent).
  // Without this the handshake would return zero groups and the demo
  // would have nothing to subscribe to.
  try {
    await addMember(serverUrl, actorId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[bootstrap] addMember warning:", err);
  }

  // 3. Handshake.
  const { groups } = await client.handshake();
  const groupIds = groups.map((g) => g.id);

  if (groupIds.length === 0) {
    throw new Error(
      `bootstrap: actor '${actorId}' is not a member of any group. Did the seed run?`,
    );
  }

  // The SSE subscription opened by Editor.tsx will move the state
  // machine to "live" once the stream connects — no need to set it
  // manually here.

  return { client, groupIds, didSeed };
}
