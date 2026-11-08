/**
 * Bootstrap: connect to the server, handshake, ensure the demo data
 * exists, add the connecting actor as a member, then return a
 * configured `SyncClient` ready for use.
 */

import { createClient, definePresence } from "@ebbjs/client";
import { Type } from "@sinclair/typebox";
import type { Action } from "@ebbjs/core/seed";
import { buildAddMemberSeed, buildDemoSeed, DEMO_GROUP_ID, deriveSeedIds } from "./seed";

/**
 * The demo's presence channels. `cursor` keeps the client's default 30 s TTL
 * on purpose: a peer that stops moving ages out, which is the expiry path a
 * real app lives with (#677).
 */
const cursorPresenceSchema = Type.Object({
  anchorId: Type.String(),
  anchorOffset: Type.Number(),
  headId: Type.String(),
  headOffset: Type.Number(),
});

export const demoPresence = definePresence({ cursor: cursorPresenceSchema });

/**
 * `createClient` with the demo's presence registry. The returned type carries
 * the typed `client.presence` surface into every component that takes the
 * client, so channel names and cursor payloads are checked at the call site.
 */
const createDemoClient = (opts: { serverUrl: string; actorId: string }) =>
  createClient({ ...opts, presence: demoPresence });

export type DemoClient = ReturnType<typeof createDemoClient>;

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
      /** The document's projected text (the authoritative view). */
      getText: () => string;
      /** Force a localExtend on a run with a pinned HLC. */
      forceExtend: (runId: string, appendText: string, hlc: string) => string | null;
      /** Flush any locally-queued actions to the server. */
      flushPending: () => Promise<{
        rejected: readonly { id: string; reason: string; details?: string | null }[];
      }>;
      /**
       * Drop the live subscription and re-subscribe, forcing a catch-up
       * pass. Used by the conflict e2e to exercise reconnect detection
       * without relying on the browser tearing the SSE stream down.
       */
      reconnect: () => void;
      /** Snapshot the doc's `cursor` channel peers (for diagnostics). */
      getPresenceEntries: () => readonly {
        actorId: string;
        anchorId: string;
        anchorOffset: number;
      }[];
    };
  }
}

export interface BootstrapResult {
  client: DemoClient;
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
  caughtUpActions: readonly Action[];
}

/**
 * Connect to the server, handshake, ensure the demo group exists, and
 * open the SSE subscription for the demo's groups.
 *
 * Seeding is best-effort: `client.seed(...)` tolerates idempotent
 * re-seeds of an existing group, and a failed seed is logged so the
 * handshake below can report whether the actor ended up with any groups.
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

  // 1. Seed (best-effort) as the dedicated `demo-seeder` actor. One
  // short-lived client submits both the group/doc fixture and this
  // actor's membership row, then closes. `client.seed(...)` applies the
  // shared tolerance policy, so re-seeding an existing group is a no-op.
  let didSeed = false;
  if (ensureSeeded) {
    const seeder = createClient({ serverUrl, actorId: "demo-seeder" });
    try {
      await seeder.seed(buildDemoSeed(seedGroupId));
      didSeed = true;
      // Without this membership row the handshake returns zero groups
      // and the demo would have nothing to subscribe to.
      await seeder.seed(buildAddMemberSeed(actorId, seedGroupId));
    } catch (err) {
      // Already-seeded is fine; log anything else and let the handshake
      // below decide whether the demo is usable.
      // eslint-disable-next-line no-console
      console.warn("[bootstrap] seed warning:", err);
    } finally {
      seeder.close();
    }
  }

  // 2. Handshake.
  const client = createDemoClient({ serverUrl, actorId });
  const { groups } = await client.handshake();
  const groupIds = groups.map((g) => g.id);

  if (groupIds.length === 0) {
    throw new Error(
      `bootstrap: actor '${actorId}' is not a member of any group. Did the seed run?`,
    );
  }

  // 3. Catch up — replay every committed action since GSN 0 so the
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
