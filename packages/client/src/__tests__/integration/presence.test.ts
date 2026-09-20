/**
 * Presence round-trip integration test against a running ebb_server.
 *
 * Two clients (drew and alice) both connect to grp_demo. Drew calls
 * `setLocalCursor`; alice should see drew's cursor in
 * `client.presence.forEntity` within a couple of seconds (the
 * 100ms debounce + SSE delivery).
 *
 * Requires a pre-seeded `grp_demo` group with a `demo-seeder` member
 * that the standard integration CI job does not bootstrap. The test
 * probes for that fixture at load time and skips cleanly with a
 * warning when it's missing. See `packages/client/README.md` for how
 * to seed the demo fixtures locally.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@ebbjs/client";
import type { SyncClient } from "@ebbjs/client";

const SERVER_URL = process.env.EBB_TEST_URL ?? "http://localhost:4000";
const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const GROUP_ID = "grp_demo";

interface ClientHandle {
  client: SyncClient;
  close: () => void;
}

async function ping(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/sync/handshake`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ebb-actor-id": "presence-test-ping" },
      body: "{}",
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Probe the demo fixture: this test requires a pre-seeded `grp_demo`
 * group with a `demo-seeder` member. The standard integration CI job
 * does not bootstrap those fixtures, so the test should skip cleanly
 * when they're absent. Probe by handshaking as `demo-seeder`; if the
 * group isn't returned, the fixture is missing.
 */
async function demoFixtureSeeded(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/sync/handshake`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ebb-actor-id": "demo-seeder" },
      body: "{}",
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { groups?: Array<{ id: string }> };
    return (body.groups ?? []).some((g) => g.id === GROUP_ID);
  } catch {
    return false;
  }
}

const serverReachable = await ping(SERVER_URL);
const fixtureSeeded = serverReachable && (await demoFixtureSeeded(SERVER_URL));

if (!serverReachable) {
  console.warn(`[skip] presence integration tests — ebb server not reachable at ${SERVER_URL}`);
} else if (!fixtureSeeded) {
  console.warn(
    `[skip] presence integration tests — grp_demo with demo-seeder not seeded on ${SERVER_URL}`,
  );
}

const itIfReady = serverReachable && fixtureSeeded ? it : it.skip;

/**
 * Add an actor as a member of grp_demo (sent as demo-seeder, who has
 * groupMember.* permission). Idempotent — tolerates already_exists.
 */
async function addMemberAsSeeder(actorId: string): Promise<void> {
  const { encodeSync, createAction, createClock, localEvent } = await import("@ebbjs/core");
  const clock = createClock();
  const update = {
    subject_id: `gm_${actorId}`,
    subject_type: "groupMember",
    method: "put" as const,
    data: {
      fields: {
        actor_id: { value: actorId, update_id: "add", hlc: localEvent(clock) },
        group_id: { value: GROUP_ID, update_id: "add", hlc: localEvent(clock) },
        permissions: {
          value: ["text_document.*", "group.*", "groupMember.*", "relationship.*"],
          update_id: "add",
          hlc: localEvent(clock),
        },
      },
    },
  };
  const { action } = createAction({ actorId: "demo-seeder", updates: [update], clock });
  const body = encodeSync({ actions: [action] });

  const res = await fetch(`${SERVER_URL}/sync/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/msgpack",
      "x-ebb-actor-id": "demo-seeder",
    },
    body: body as BodyInit,
  });
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => "");
    if (!text.includes("already")) {
      throw new Error(`addMember failed: ${res.status} ${text}`);
    }
  }
}

async function setupActor(actorId: string): Promise<ClientHandle> {
  await addMemberAsSeeder(actorId);

  const client = createClient({ serverUrl: SERVER_URL, actorId });
  const { groups } = await client.handshake();
  if (!groups.find((g) => g.id === GROUP_ID)) {
    throw new Error(`actor ${actorId} is not a member of ${GROUP_ID}`);
  }
  return {
    client,
    close: () => {
      client.close();
    },
  };
}

describe("integration: presence", () => {
  let drew: ClientHandle | null = null;
  let alice: ClientHandle | null = null;

  beforeAll(async () => {
    if (!serverReachable || !fixtureSeeded) return;
    drew = await setupActor(`drew_presence_${RUN_ID}`);
    alice = await setupActor(`alice_presence_${RUN_ID}`);
  });

  afterAll(() => {
    drew?.close();
    alice?.close();
  });

  itIfReady("alice sees drew's cursor via the SSE presence stream", async () => {
    if (!drew || !alice) throw new Error("test setup failed");

    drew.client.presence.start();
    alice.client.presence.start();

    // Give the SSE streams a moment to establish on both sides.
    await new Promise((r) => setTimeout(r, 500));

    const anchor = "r:drew:" + RUN_ID;
    const head = anchor;

    drew.client.presence.setLocalCursor("doc_demo", {
      anchorId: anchor,
      anchorOffset: 0,
      headId: head,
      headOffset: 5,
    });

    // Poll alice's presence map for drew's entry.
    const deadline = Date.now() + 3000;
    let drewEntry: ReturnType<typeof alice.client.presence.forEntity> extends Map<string, infer V>
      ? V | undefined
      : never;
    while (Date.now() < deadline) {
      const map = alice.client.presence.forEntity("doc_demo");
      const entry = map.get(drew.client.actorId);
      if (entry) {
        drewEntry = entry as typeof drewEntry;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(drewEntry).toBeDefined();
    expect(drewEntry?.cursor.anchorId).toBe(anchor);
    expect(drewEntry?.cursor.headOffset).toBe(5);
  });
});
