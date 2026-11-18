/**
 * End-to-end coverage for `resolveIdentity` against a server booted in
 * `EBB_AUTH_MODE=tailscale`.
 *
 * The browser never sees the Tailscale headers — a gateway injects them — so
 * the tests wrap `fetch` to play that gateway. That is also the seam a real
 * app uses: `resolveIdentity({ serverUrl, fetchImpl })` with the wrapper.
 *
 * `EBB_AUTH_MODE=tailscale` binds the server to loopback, so the default
 * `http://127.0.0.1:4000` (see `./server`) is the right address. A bypass or
 * external server rejects the identity probe, and the suite reports its tests
 * as skipped rather than passing them through an early return.
 *
 * Run it with:
 *
 * ```bash
 * cd ebb_server && EBB_AUTH_MODE=tailscale MIX_ENV=dev mix run --no-halt
 * pnpm --filter @ebbjs/client test:integration
 * ```
 */

import { afterAll, beforeAll, describe, expect, vi } from "vitest";
import { buildSeedAction } from "@ebbjs/core/seed";
import { createClient, resolveIdentity, type SyncClient } from "../..";
import { itIf, probe, runId, TAILSCALE_SERVER_URL } from "./server";

const SERVER_URL = TAILSCALE_SERVER_URL;

const RUN_ID = runId();
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

/**
 * Probe once, at load time: only a tailscale-mode server answers the identity
 * read, so the probe is also the gate the wrapper below is built from.
 */
async function tailscaleModeAvailable(): Promise<boolean> {
  const response = await probe(`${SERVER_URL}/sync/identity`, {
    headers: {
      "tailscale-user-login": LOGIN,
      "tailscale-user-name": DISPLAY_NAME,
    },
  });
  if (response === null || !response.ok) return false;
  const body = (await response.json()) as { provider?: unknown };
  return body.provider === "tailscale";
}

const reachable = await tailscaleModeAvailable();

if (!reachable) {
  console.warn(
    `[skip] no tailscale-mode ebb server at ${SERVER_URL}; ` +
      "boot one with EBB_AUTH_MODE=tailscale to run this suite",
  );
}

const itIfTailscale = itIf(reachable);

/** Seed this run's group, membership, entity, and its visibility row. */
async function seedGroup(client: SyncClient): Promise<void> {
  await client.seed({
    groups: [{ id: GROUP_ID, name: `Tailscale ${RUN_ID}` }],
    grants: [
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
        model: "issue",
        patches: [{ fields: { title: "seeded" } }],
      },
    ],
    memberships: [{ id: `eg_seed_${RUN_ID}`, entityId: SEEDED_ENTITY, groupId: GROUP_ID }],
  });
}

let client: SyncClient | null = null;

beforeAll(async () => {
  if (!reachable) return;
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
  itIfTailscale("resolves the actor from the injected Tailscale headers", async () => {
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

  itIfTailscale("handshakes, writes, and streams with the resolved actor", async () => {
    const active = client;
    if (active === null) throw new Error("beforeAll did not seed a client");

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
      grants: [],
      entities: [
        {
          id: WRITTEN_ENTITY,
          model: "issue",
          patches: [{ fields: { title: "written" } }],
        },
      ],
      memberships: [{ id: `eg_write_${RUN_ID}`, entityId: WRITTEN_ENTITY, groupId: GROUP_ID }],
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

  itIfTailscale("rejects a stale cached actor with actor_mismatch", async () => {
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
        grants: [],
        entities: [
          {
            id: `issue_ts_stale_${RUN_ID}`,
            model: "issue",
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
