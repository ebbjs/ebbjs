/**
 * Bootstrap: connect to the server, handshake, ensure the demo data
 * exists, add the connecting actor as a member, then return a
 * configured `SyncClient` ready for use.
 */

import { createClient, type SyncAction, type SyncClient } from "@ebbjs/client";
import { addMember, buildDemoSeed, DEMO_GROUP_ID, deriveSeedIds, seed } from "./seed";

/**
 * Shape of `window.__EBB_DEMO_TEST_CONFIG__` — opt-in test seams read
 * by the Editor when present. Set by Playwright via
 * `page.addInitScript()` to influence the demo's runtime behavior
 * without baking test-only branches into production code paths.
 *
 * Currently:
 * - `exposeState` makes the Editor publish a minimal handle on
 *   `window.__EBB_DEMO_TEST_STATE__` so the conflict-surfacing e2e
 *   can read run ids and dispatch a pinned-HLC `localExtend` without
 *   poking through React internals.
 * - `groupId` swaps the seed group for an isolated one so each Playwright
 *   spec gets its own `cf_actions` namespace (see #197). When set,
 *   `bootstrap` seeds `deriveSeedIds(groupId)` and joins that group.
 *
 * Adding new test seams: prefer reading from this object so the
 * surface stays auditable in one place.
 */
export interface DemoTestConfig {
  /**
   * If true, the Editor exposes the underlying TextDocument on
   * `window.__EBB_DEMO_TEST_STATE__` once mounted. Lets the conflict
   * e2e read run ids and call `localExtend` directly without poking
   * through React internals.
   */
  exposeState?: boolean;
  /**
   * Override the demo's seed group id. Each Playwright spec that sets
   * this gets a fresh group (with its own member / relationship / doc)
   * so actions from prior specs don't leak into the next via catchUp.
   * See #197 for the latent bug this isolates.
   */
  groupId?: string;
}

declare global {
  interface Window {
    __EBB_DEMO_TEST_CONFIG__?: DemoTestConfig;
    __EBB_DEMO_TEST_STATE__?: {
      docId: string;
      actorId: string;
      getRunIds: () => readonly string[];
      /** Force a localExtend on a run with a pinned HLC. */
      forceExtend: (runId: string, appendText: string, hlc: string) => string | null;
      /** Flush any locally-queued actions to the server. */
      flushPending: () => Promise<{
        rejected: readonly { id: string; reason: string; details?: string | null }[];
      }>;
      /** Snapshot the presence map for the doc (for diagnostics). */
      getPresenceEntries: () => readonly {
        actorId: string;
        anchorId: string;
        anchorOffset: number;
      }[];
    };
  }
}

export interface BootstrapResult {
  client: SyncClient;
  groupIds: readonly string[];
  /**
   * The group id the demo's doc belongs to. Mirrors `groupIds[0]`
   * in the default config but is the isolated `groupId` test config
   * set when present. Callers pass it to the editor and conflict
   * panel so they don't have to hardcode `DEMO_GROUP_ID`.
   */
  docGroupId: string;
  /** The doc entity id derived from the seeded group. */
  docId: string;
  /** True if we ran the seed call (group may or may not be new). */
  didSeed: boolean;
  /**
   * Actions replayed from `catchUp` for every group the actor is in.
   * The Editor applies these to the freshly-created TextDocument
   * BEFORE opening its SSE subscription, so a new tab (even with
   * the same `?actor=` as an existing one) starts with the current
   * document state instead of an empty doc.
   */
  caughtUpActions: readonly SyncAction[];
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

  // `__EBB_DEMO_TEST_CONFIG__.groupId` lets a Playwright spec seed an
  // isolated group instead of the shared `grp_demo`. See #197 — under
  // `workers: 1` the spec's `cf_actions` would otherwise carry the
  // previous spec's data into its catchUp replay.
  const testConfig = typeof window !== "undefined" ? window.__EBB_DEMO_TEST_CONFIG__ : undefined;
  const seedGroupId = testConfig?.groupId;
  const fallbackGroupId = seedGroupId ?? DEMO_GROUP_ID;
  const { docId } = deriveSeedIds(fallbackGroupId);

  const client = createClient({
    serverUrl,
    actorId,
  });

  // 1. Seed (best-effort).
  let didSeed = false;
  if (ensureSeeded) {
    try {
      await seed(serverUrl, "demo-seeder", buildDemoSeed(seedGroupId));
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
    await addMember(serverUrl, actorId, seedGroupId);
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

  // 4. Catch up — replay every committed action since GSN 0 so the
  // demo doc starts with the current state. Without this, a fresh
  // tab (even for an actor that was already connected in another
  // tab) would start empty and only catch up on the next SSE event.
  const caughtUpActions: SyncAction[] = [];
  for (const gid of groupIds) {
    let cursor = 0;
    // catchUp is paginated but the demo has at most a handful of
    // historical actions — loop until the server says we're caught up.
    // Hard cap as a safety net.
    for (let i = 0; i < 1000; i++) {
      const result = await client.catchUp(gid, cursor);
      if (result.actions.length === 0) break;
      caughtUpActions.push(...result.actions);
      cursor += result.actions.length;
      if (result.upToDate) break;
    }
  }

  // The SSE subscription opened by Editor.tsx will move the state
  // machine to "live" once the stream connects — no need to set it
  // manually here.

  return {
    client,
    groupIds,
    docGroupId: fallbackGroupId,
    docId,
    didSeed,
    caughtUpActions,
  };
}
