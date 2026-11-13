/**
 * End-to-end coverage for `resolveIdentity` against a server booted in
 * `EBB_AUTH_MODE=tailscale`.
 *
 * The browser never sees the Tailscale headers — a gateway injects them — so
 * the tests wrap `fetch` to play that gateway. That is also the seam a real
 * app uses: `resolveIdentity({ serverUrl, fetchImpl })` with the wrapper.
 *
 * `EBB_AUTH_MODE=tailscale` binds the server to loopback, so the default
 * `http://127.0.0.1:4000` is the right address. A bypass or external server
 * rejects the identity probe and every test short-circuits, matching the
 * skip-don't-fail convention of the other integration suites.
 *
 * Run it with:
 *
 * ```bash
 * cd ebb_server && EBB_AUTH_MODE=tailscale MIX_ENV=dev mix run --no-halt
 * pnpm --filter @ebbjs/client test:integration
 * ```
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildSeedAction } from "@ebbjs/core/seed";
import { createClient, resolveIdentity, type SyncClient } from "../..";

const SERVER_URL =
  process.env.EBB_TAILSCALE_TEST_URL ?? process.env.EBB_TEST_URL ?? "http://127.0.0.1:4000";

const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const LOGIN = `ts_${RUN_ID}@example.com`;
const DISPLAY_NAME = `Tailscale ${RUN_ID}`;
const GROUP_ID = `grp_ts_${RUN_ID}`;
const MEMBER_ID = `gm_ts_${RUN_ID}`;
const SEEDED_ENTITY = `issue_ts_seed_${RUN_ID}`;
const WRITTEN_ENTITY = `issue_ts_write_${RUN_ID}`;

/** The platform permissions this suite's seeds need, plus `issue.*`. */
const PERMISSIONS = ["ebb/group.*", "ebb/grant.*", "ebb/membership.*", "issue.*"];

/** Play the gateway: every request carries the Tailscale identity headers. */
const gatewayFetch =
  (login: string, displayName = DISPLAY_NAME): typeof fetch =>
  (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("tailscale-user-login", login);
    headers.set("tailscale-user-name", displayName);
    return fetch(input, { ...init, headers });
  };

let reachable: boolean | null = null;

/** Probe once: only a tailscale-mode server answers the headerless read. */
async function tailscaleModeAvailable(): Promise<boolean> {
  if (reachable !== null) return reachable;
  try {
    const response = await fetch(`${SERVER_URL}/sync/identity`, {
      headers: {
        "tailscale-user-login": LOGIN,
        "tailscale-user-name": DISPLAY_NAME,
      },
    });
    if (!response.ok) {
      reachable = false;
    } else {
      const body = (await response.json()) as { provider?: unknown };
      reachable = body.provider === "tailscale";
    }
  } catch {
    reachable = false;
  }
  if (!reachable) {
    console.warn(
      `[skip] no tailscale-mode ebb server at ${SERVER_URL}; ` +
        "boot one with EBB_AUTH_MODE=tailscale to run this suite",
    );
  }
  return reachable;
}

/** Seed this run's group, membership, entity, and its visibility row. */
async function seedGroup(client: SyncClient): Promise<void> {
  await client.seed({
    groups: [{ id: GROUP_ID, name: `Tailscale ${RUN_ID}` }],
    groupMembers: [
      {
        id: MEMBER_ID,
        actorId: LOGIN,
        groupId: GROUP_ID,
        permissions: [...PERMISSIONS],
      },
    ],
    entities: [
      {
        id: SEEDED_ENTITY,
        type: "issue",
        patches: [{ fields: { title: "seeded" } }],
      },
    ],
    entityGroups: [{ id: `eg_seed_${RUN_ID}`, entityId: SEEDED_ENTITY, groupId: GROUP_ID }],
  });
}

let client: SyncClient | null = null;

beforeAll(async () => {
  if (!(await tailscaleModeAvailable())) return;
  client = createClient({
    serverUrl: SERVER_URL,
    actorId: LOGIN,
    fetchImpl: gatewayFetch(LOGIN),
  });
  await seedGroup(client);
});

afterAll(() => {
  client?.close();
});

describe("integration: server-derived identity", () => {
  it("resolves the actor from the injected Tailscale headers", async () => {
    if (!(await tailscaleModeAvailable())) return;

    const identity = await resolveIdentity({
      serverUrl: SERVER_URL,
      fetchImpl: gatewayFetch(LOGIN),
    });

    expect(identity).toMatchObject({
      actorId: LOGIN,
      provider: "tailscale",
      displayName: DISPLAY_NAME,
    });
  });

  it("handshakes, writes, and streams with the resolved actor", async () => {
    if (!(await tailscaleModeAvailable()) || client === null) return;
    const active = client;

    const { groups } = await active.handshake();
    expect(groups.map((group) => group.id)).toContain(GROUP_ID);

    await active.catchUp(GROUP_ID);
    const seeded = await active.storage.entities.get(SEEDED_ENTITY);
    expect(seeded?.data?.fields?.["title"]?.value).toBe("seeded");

    const received: string[] = [];
    const unsubscribe = active.subscribe([GROUP_ID], (event) => {
      if (event.type === "data") received.push(event.action.id);
    });

    // `subscribe` opens the stream asynchronously; a write before it is live
    // would not reach this subscriber's SSE window.
    await vi.waitFor(() => expect(active.state).toBe("live"), { timeout: 15_000 });

    const write = buildSeedAction(LOGIN, {
      groups: [],
      groupMembers: [],
      entities: [
        {
          id: WRITTEN_ENTITY,
          type: "issue",
          patches: [{ fields: { title: "written" } }],
        },
      ],
      entityGroups: [{ id: `eg_write_${RUN_ID}`, entityId: WRITTEN_ENTITY, groupId: GROUP_ID }],
    });

    try {
      const result = await active.write([write]);
      expect(result.rejected).toEqual([]);

      // The write comes back over the live stream as its own action.
      await vi.waitFor(() => expect(received).toContain(write.id), { timeout: 15_000 });

      await active.catchUp(GROUP_ID);
      const row = await active.storage.entities.get(WRITTEN_ENTITY);
      expect(row?.data?.fields?.["title"]?.value).toBe("written");
    } finally {
      unsubscribe();
    }
  });

  it("rejects a stale cached actor with actor_mismatch", async () => {
    if (!(await tailscaleModeAvailable())) return;

    const staleActor = `stale_${RUN_ID}@example.com`;
    const stale = createClient({
      serverUrl: SERVER_URL,
      actorId: staleActor,
      // The gateway always authenticates LOGIN, whatever the client believes.
      fetchImpl: gatewayFetch(LOGIN),
    });

    try {
      const staleWrite = buildSeedAction(staleActor, {
        groups: [],
        groupMembers: [],
        entities: [
          {
            id: `issue_ts_stale_${RUN_ID}`,
            type: "issue",
            patches: [{ fields: { title: "stale" } }],
          },
        ],
      });

      const result = await stale.write([staleWrite]);

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]).toMatchObject({ reason: "actor_mismatch" });
    } finally {
      stale.close();
    }
  });
});
