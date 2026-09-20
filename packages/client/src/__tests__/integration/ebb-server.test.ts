/**
 * Integration tests for the @ebbjs/client sync stack against a real
 * ebb_server. Exhaustive unit tests for the wire layer live in
 * `__tests__/wire.test.ts` and friends; this file exercises the full
 * client → HTTP → server → storage → catchUp → client round-trip.
 *
 * See `packages/client/README.md` for how to run this file (requires
 * a live server on `EBB_TEST_URL` or the default `localhost:4000`).
 *
 * ## What gets covered
 *
 * - Bootstrap: handshake returns groups; client.setState drives the
 *   state machine; write from a non-member is rejected.
 * - localInsert round-trip: text typed in client A surfaces in client B
 *   after write → catchUp → applyActions.
 * - localExtend round-trip: extend (no new run) round-trips.
 * - localDelete round-trip: tombstone deletes the run in a peer.
 *
 * ## What does NOT get covered (covered elsewhere)
 *
 * - Wire-format parsing in isolation: wire.test.ts.
 * - Causal-tree reducer in isolation: tree.test.ts.
 * - Conflict surfacing: conflict.test.ts + collaborative-text-editor
 *   integration tests.
 *
 * ## Skip semantics
 *
 * Every `it` block calls `shouldRun()` and short-circuits when the
 * server isn't reachable — the test counts as passing in that case,
 * matching the convention that integration tests must never make a
 * plain `pnpm test` run fail because of a missing server.
 *
 * Each test run creates its own isolated group + actor (named with a
 * per-run random suffix), so the test is reentrant against the same
 * server — running it twice in a row does not collide.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAction, createClock, encodeSync, localEvent, type Action } from "@ebbjs/core";
import { createClient, type SyncClient } from "../..";

const SERVER_URL = process.env.EBB_TEST_URL ?? "http://localhost:4000";

const TEST_SEEDER = "test_seeder";

/** Unique per run so the test is reentrant against the same server. */
const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const TEST_GROUP_ID = `grp_it_${RUN_ID}`;
/**
 * Each test that exercises the doc lifecycle gets its own unique
 * docId so the per-test action stream doesn't accumulate across
 * tests. The group is shared because adding members is cheap and
 * the actor-perm lookup is by member id.
 */
const testDocId = (suffix: string): string => `doc_it_${RUN_ID}_${suffix}`;

let serverReachable: boolean | null = null;

async function ping(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/sync/handshake`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ebb-actor-id": TEST_SEEDER },
      body: "{}",
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function ensureServerReachable(): Promise<boolean> {
  if (serverReachable !== null) return serverReachable;
  serverReachable = await ping(SERVER_URL);
  return serverReachable;
}

beforeAll(async () => {
  if (!(await ensureServerReachable())) {
    console.warn(`[skip] ebb server not reachable at ${SERVER_URL}`);
    return;
  }

  // Bootstrap the test group in ONE action so the server's
  // group_bootstrap? check passes (it requires group + groupMember for
  // the actor + relationship, all in the same action set).
  const bootstrapDocId = testDocId("bootstrap");
  const bootstrapRelId = `rel_${RUN_ID}_bootstrap`;
  const clock = createClock();
  const updates = [
    {
      subject_id: TEST_GROUP_ID,
      subject_type: "group",
      method: "put" as const,
      data: {
        name: {
          value: `Integration Test ${RUN_ID}`,
          update_id: "seed",
          hlc: localEvent(clock),
        },
      },
    },
    {
      subject_id: `gm_${TEST_SEEDER}`,
      subject_type: "groupMember",
      method: "put" as const,
      data: {
        actor_id: { value: TEST_SEEDER, update_id: "seed", hlc: localEvent(clock) },
        group_id: { value: TEST_GROUP_ID, update_id: "seed", hlc: localEvent(clock) },
        permissions: {
          value: ["text_document.*", "group.*", "groupMember.*", "relationship.*"],
          update_id: "seed",
          hlc: localEvent(clock),
        },
      },
    },
    {
      subject_id: bootstrapDocId,
      subject_type: "text_document",
      method: "put" as const,
      data: { fields: {} },
    },
    {
      subject_id: bootstrapRelId,
      subject_type: "relationship",
      method: "put" as const,
      data: {
        source_id: { value: bootstrapDocId, update_id: "seed", hlc: localEvent(clock) },
        target_id: { value: TEST_GROUP_ID, update_id: "seed", hlc: localEvent(clock) },
        type: { value: "text_document", update_id: "seed", hlc: localEvent(clock) },
        field: { value: "ownedBy", update_id: "seed", hlc: localEvent(clock) },
      },
    },
  ];
  const { action } = createAction({ actorId: TEST_SEEDER, updates, clock });
  const body = encodeSync({ actions: [action] });

  const res = await fetch(`${SERVER_URL}/sync/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/msgpack",
      "x-ebb-actor-id": TEST_SEEDER,
    },
    body: body as BodyInit,
  });
  if (!res.ok) {
    throw new Error(`failed to seed test group: ${res.status} ${await res.text()}`);
  }
}, 30_000);

afterAll(async () => {
  // No teardown — the test group is uniquely named and the server
  // doesn't care about leftover groups. Clear the data dir manually
  // if it grows too much.
});

/**
 * Add an actor as a member of the test group. Sent on behalf of the
 * seeder (which has groupMember.* permission).
 */
async function addMemberAsSeeder(actorId: string): Promise<void> {
  const clock = createClock();
  const memberId = `gm_${actorId}`;
  const update = {
    subject_id: memberId,
    subject_type: "groupMember",
    method: "put" as const,
    data: {
      fields: {
        actor_id: { value: actorId, update_id: "add", hlc: localEvent(clock) },
        group_id: { value: TEST_GROUP_ID, update_id: "add", hlc: localEvent(clock) },
        permissions: {
          value: ["text_document.*", "group.read", "groupMember.*", "relationship.*"],
          update_id: "add",
          hlc: localEvent(clock),
        },
      },
    },
  };
  const { action } = createAction({ actorId: TEST_SEEDER, updates: [update], clock });
  const body = encodeSync({ actions: [action] });

  const res = await fetch(`${SERVER_URL}/sync/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/msgpack",
      "x-ebb-actor-id": TEST_SEEDER,
    },
    body: body as BodyInit,
  });
  if (!res.ok) {
    throw new Error(`failed to add member ${actorId}: ${res.status} ${await res.text()}`);
  }
}

/**
 * Create a client, add the actor as a member, handshake, return it.
 * The state machine is advanced to "live" so ConnectionBadge-style
 * consumers render sensibly.
 */
async function connectAs(actorId: string): Promise<SyncClient> {
  await addMemberAsSeeder(actorId);
  const client = createClient({ serverUrl: SERVER_URL, actorId });
  const { groups } = await client.handshake();
  if (!groups.find((g) => g.id === TEST_GROUP_ID)) {
    throw new Error(
      `actor ${actorId} did not join ${TEST_GROUP_ID} after handshake; groups: ${groups
        .map((g) => g.id)
        .join(",")}`,
    );
  }
  client.setState("live");
  return client;
}

/** Catch up to the latest action for the test group. */
async function fetchActions(fromGsn = 0): Promise<readonly Action[]> {
  const res = await fetch(`${SERVER_URL}/sync/groups/${TEST_GROUP_ID}?offset=${fromGsn}`, {
    headers: { "x-ebb-actor-id": TEST_SEEDER },
  });
  if (!res.ok) {
    throw new Error(`catchUp failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as Action[];
}

/**
 * Create an empty text_document in the test group + its ownedBy
 * relationship. Tests call this to get a fresh, isolated doc.
 */
async function createTestDoc(docId: string): Promise<void> {
  const clock = createClock();
  const updates = [
    {
      subject_id: docId,
      subject_type: "text_document",
      method: "put" as const,
      data: { fields: {} },
    },
    {
      subject_id: `rel_${RUN_ID}_${docId}`,
      subject_type: "relationship",
      method: "put" as const,
      data: {
        source_id: { value: docId, update_id: "seed", hlc: localEvent(clock) },
        target_id: { value: TEST_GROUP_ID, update_id: "seed", hlc: localEvent(clock) },
        type: { value: "text_document", update_id: "seed", hlc: localEvent(clock) },
        field: { value: "ownedBy", update_id: "seed", hlc: localEvent(clock) },
      },
    },
  ];
  const { action } = createAction({ actorId: TEST_SEEDER, updates, clock });
  const body = encodeSync({ actions: [action] });
  const res = await fetch(`${SERVER_URL}/sync/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/msgpack",
      "x-ebb-actor-id": TEST_SEEDER,
    },
    body: body as BodyInit,
  });
  if (!res.ok) {
    throw new Error(`failed to create doc ${docId}: ${res.status} ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Test runner: skip if the server isn't reachable
// ---------------------------------------------------------------------------

/**
 * Returns true if the test should run. Resolved at the start of each
 * `it` so the suite is skipped as a whole when the server isn't up.
 */
async function shouldRun(): Promise<boolean> {
  return await ensureServerReachable();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integration: bootstrap", () => {
  it("handshake returns the test group for an authorized actor", async () => {
    if (!(await shouldRun())) return;
    const client = await connectAs("bootstrap_actor");
    try {
      expect(client.state).toBe("live");
    } finally {
      client.close();
    }
  });

  it("handshake returns zero groups for an actor that never joined", async () => {
    if (!(await shouldRun())) return;
    const client = createClient({ serverUrl: SERVER_URL, actorId: "stranger_actor" });
    try {
      const { groups } = await client.handshake();
      expect(groups.find((g) => g.id === TEST_GROUP_ID)).toBeUndefined();
    } finally {
      client.close();
    }
  });

  it("write rejects actions from a non-member actor", async () => {
    if (!(await shouldRun())) return;
    const client = createClient({ serverUrl: SERVER_URL, actorId: "stranger_actor" });
    try {
      const doc = client.textDocument(testDocId("stranger"));
      doc.localInsert("nope");
      const pending = doc.pendingActions();
      const result = await client.write(pending);
      expect(result.rejected.length).toBe(pending.length);
    } finally {
      client.close();
    }
  });
});

describe("integration: localInsert round-trip", () => {
  it("text typed by A appears in B after write + catchUp + applyActions", async () => {
    if (!(await shouldRun())) return;
    const docId = testDocId("insert_roundtrip");
    await createTestDoc(docId);

    const actorA = "alice_roundtrip";
    const actorB = "bob_roundtrip";
    const a = await connectAs(actorA);
    const b = await connectAs(actorB);

    try {
      const docA = a.textDocument(docId);
      const docB = b.textDocument(docId);

      docA.localInsert("hello ");
      docA.localInsert("world");
      docA.localInsert("!");

      expect(docA.text).toBe("hello world!");

      const write = await a.write(docA.pendingActions());
      expect(write.rejected.length).toBe(0);
      docA.ackPending(docA.pendingActions().map((act) => act.id));

      const actions = await fetchActions();
      // Filter to actions targeting our test doc only (other tests may
      // share the group).
      const docActions = actions.filter((a) => a.updates.some((u) => u.subject_id === docId));
      expect(docActions.length).toBeGreaterThanOrEqual(3);
      docB.applyActions(docActions);

      expect(docB.text).toBe("hello world!");
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("integration: localExtend round-trip", () => {
  it("extending a run in A appears as a full-text update in B (no run split)", async () => {
    if (!(await shouldRun())) return;
    const docId = testDocId("extend_roundtrip");
    await createTestDoc(docId);

    const actorA = "alice_extend";
    const actorB = "bob_extend";
    const a = await connectAs(actorA);
    const b = await connectAs(actorB);

    try {
      const docA = a.textDocument(docId);
      const docB = b.textDocument(docId);

      docA.localInsert("hello");
      const write1 = await a.write(docA.pendingActions());
      expect(write1.rejected.length).toBe(0);
      docA.ackPending(docA.pendingActions().map((act) => act.id));

      const actions1 = (await fetchActions()).filter((a) =>
        a.updates.some((u) => u.subject_id === docId),
      );
      docB.applyActions(actions1);
      const bRunId = docB.docState.children.get("ROOT")![0]!;
      const bRun = docB.docState.nodes.get(bRunId)!;
      expect(bRun.text).toBe("hello");

      docA.localExtend({ runId: bRunId, appendText: " world" });
      expect(docA.text).toBe("hello world");

      const write2 = await a.write(docA.pendingActions());
      expect(write2.rejected.length).toBe(0);
      docA.ackPending(docA.pendingActions().map((act) => act.id));

      const actions2 = (await fetchActions()).filter((a) =>
        a.updates.some((u) => u.subject_id === docId),
      );
      docB.applyActions(actions2);
      expect(docB.text).toBe("hello world");
      expect(docB.docState.children.get("ROOT")!.length).toBe(1);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("integration: localDelete round-trip", () => {
  it("tombstoning a run in A removes the text in B", async () => {
    if (!(await shouldRun())) return;
    const docId = testDocId("delete_roundtrip");
    await createTestDoc(docId);

    const actorA = "alice_delete";
    const actorB = "bob_delete";
    const a = await connectAs(actorA);
    const b = await connectAs(actorB);

    try {
      const docA = a.textDocument(docId);
      const docB = b.textDocument(docId);

      docA.localInsert("delete me please");
      const write1 = await a.write(docA.pendingActions());
      expect(write1.rejected.length).toBe(0);
      docA.ackPending(docA.pendingActions().map((act) => act.id));

      const actions1 = (await fetchActions()).filter((a) =>
        a.updates.some((u) => u.subject_id === docId),
      );
      docB.applyActions(actions1);
      const bRunId = docB.docState.children.get("ROOT")![0]!;
      expect(docB.text).toBe("delete me please");

      docA.localDelete({ runId: bRunId, offset: 0, count: docA.text.length });
      expect(docA.text).toBe("");

      const write2 = await a.write(docA.pendingActions());
      expect(write2.rejected.length).toBe(0);
      docA.ackPending(docA.pendingActions().map((act) => act.id));

      const actions2 = (await fetchActions()).filter((a) =>
        a.updates.some((u) => u.subject_id === docId),
      );
      docB.applyActions(actions2);
      expect(docB.text).toBe("");
    } finally {
      a.close();
      b.close();
    }
  });
});
