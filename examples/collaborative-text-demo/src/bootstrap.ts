/**
 * Bootstrap: connect to the server, handshake, ensure the demo data
 * exists, add the connecting actor as a member, then return a
 * configured `SyncClient` ready for use.
 */

import { createClient, type Action, type SyncClient } from "@ebbjs/client";
import { addMember, buildDemoSeed, seed } from "./seed";

export interface BootstrapResult {
  client: SyncClient;
  groupIds: readonly string[];
  /** True if we ran the seed call (group may or may not be new). */
  didSeed: boolean;
  /**
   * Actions replayed from `catchUp` for every group the actor is in.
   * The Editor applies these to the freshly-created TextDocument
   * BEFORE opening its SSE subscription, so a new tab (even with
   * the same `?actor=` as an existing one) starts with the current
   * document state instead of an empty doc.
   */
  caughtUpActions: readonly Action[];
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

  // eslint-disable-next-line no-console
  console.log("[bootstrap] actor=", actorId, "handshake groups=", JSON.stringify(groupIds));

  // 4. Catch up — replay every committed action since GSN 0 so the
  // demo doc starts with the current state. Without this, a fresh
  // tab (even for an actor that was already connected in another
  // tab) would start empty and only catch up on the next SSE event.
  const caughtUpActions: Action[] = [];
  for (const gid of groupIds) {
    let cursor = 0;
    // catchUp is paginated but the demo has at most a handful of
    // historical actions — loop until the server says we're caught up.
    // Hard cap as a safety net.
    for (let i = 0; i < 1000; i++) {
      const result = await client.catchUp(gid, cursor);
      // eslint-disable-next-line no-console
      console.log(
        "[bootstrap] actor=",
        actorId,
        "gid=",
        gid,
        "catchUp iter=",
        i,
        "actions=",
        result.actions.length,
        "upToDate=",
        result.upToDate,
        "cursor=",
        cursor,
      );
      if (result.actions.length === 0) break;
      caughtUpActions.push(...result.actions);
      cursor += result.actions.length;
      if (result.upToDate) break;
    }
  }
  // eslint-disable-next-line no-console
  console.log("[bootstrap] actor=", actorId, "total caughtUp=", caughtUpActions.length);

  // The SSE subscription opened by Editor.tsx will move the state
  // machine to "live" once the stream connects — no need to set it
  // manually here.

  return { client, groupIds, didSeed, caughtUpActions };
}
