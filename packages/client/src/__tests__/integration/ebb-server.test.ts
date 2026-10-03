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

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAction,
  createClock,
  encodeSync,
  localEvent,
  makeHlc,
  type Action,
  type UpdateInput,
} from "@ebbjs/core";
import { createClient, type SyncClient } from "../..";
import { defineEntity, e } from "../../schema/entity";
import { defineRelationship } from "../../schema/relationship";
import { EntityRegistry, EntityValidationError } from "../../schema/entity-registry";
import { defineSchema } from "../../schema/schema";
import { defineAction } from "../../schema/action";

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

/**
 * Drive `client.catchUp` in a loop until the server reports
 * `upToDate: true`. The single-shot catchUp reads one page
 * (default 200 actions); on a server with thousands of historical
 * actions the just-written entity sits past the first page and a
 * naive `await catchUp(...)` won't surface it.
 */
async function catchUpUntilCurrent(
  client: import("../..").SyncClient,
  groupId: string,
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const { upToDate } = await client.catchUp(groupId);
    if (upToDate) return;
  }
  throw new Error(`catchUpUntilCurrent: exhausted retries for group ${groupId}`);
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
  const updates: UpdateInput[] = [
    {
      subject_id: TEST_GROUP_ID,
      subject_type: "group",
      method: "put",
      data: {
        fields: {
          name: {
            value: `Integration Test ${RUN_ID}`,
            update_id: "seed",
            hlc: localEvent(clock),
          },
        },
      },
    },
    {
      subject_id: `gm_${TEST_SEEDER}`,
      subject_type: "groupMember",
      method: "put" as const,
      data: {
        fields: {
          actor_id: { value: TEST_SEEDER, update_id: "seed", hlc: localEvent(clock) },
          group_id: { value: TEST_GROUP_ID, update_id: "seed", hlc: localEvent(clock) },
          permissions: {
            value: ["text_document.*", "group.*", "groupMember.*", "relationship.*"],
            update_id: "seed",
            hlc: localEvent(clock),
          },
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
        fields: {
          source_id: { value: bootstrapDocId, update_id: "seed", hlc: localEvent(clock) },
          target_id: { value: TEST_GROUP_ID, update_id: "seed", hlc: localEvent(clock) },
          type: { value: "text_document", update_id: "seed", hlc: localEvent(clock) },
          field: { value: "ownedBy", update_id: "seed", hlc: localEvent(clock) },
          kind: { value: "member", update_id: "seed", hlc: localEvent(clock) },
        },
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
  const updates: UpdateInput[] = [
    {
      subject_id: docId,
      subject_type: "text_document",
      method: "put",
      data: { fields: {} },
    },
    {
      subject_id: `rel_${RUN_ID}_${docId}`,
      subject_type: "relationship",
      method: "put",
      data: {
        fields: {
          source_id: { value: docId, update_id: "seed", hlc: localEvent(clock) },
          target_id: { value: TEST_GROUP_ID, update_id: "seed", hlc: localEvent(clock) },
          type: { value: "text_document", update_id: "seed", hlc: localEvent(clock) },
          field: { value: "ownedBy", update_id: "seed", hlc: localEvent(clock) },
          kind: { value: "member", update_id: "seed", hlc: localEvent(clock) },
        },
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

// ---------------------------------------------------------------------------
// Issue #143: defineEntity + EntityRegistry round-trip
// ---------------------------------------------------------------------------

/**
 * Add an actor as a member of the test group with `todo.*` permissions.
 * The standard helper grants only text_document / relationship perms,
 * which is insufficient for writes to user-defined entity types.
 */
async function addMemberWithTodoPerms(actorId: string): Promise<void> {
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
          value: ["text_document.*", "group.read", "groupMember.*", "relationship.*", "todo.*"],
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
 * Connect as an actor with `todo.*` permissions. Mirrors `connectAs`
 * but uses the perm-granting helper above.
 */
async function connectAsTodoActor(actorId: string): Promise<SyncClient> {
  await addMemberWithTodoPerms(actorId);
  const client = createClient({ serverUrl: SERVER_URL, actorId });
  const { groups } = await client.handshake();
  if (!groups.find((g) => g.id === TEST_GROUP_ID)) {
    throw new Error(`actor ${actorId} did not join ${TEST_GROUP_ID}`);
  }
  client.setState("live");
  return client;
}

describe("integration: defineEntity + EntityRegistry (#143)", () => {
  it("rejects a client-side unknown-field action before any fetch", async () => {
    if (!(await shouldRun())) return;
    const actor = "todo_validation_actor";
    const client = await connectAsTodoActor(actor);
    try {
      const todo = defineEntity("todo", {
        title: e.string(),
        completed: e.boolean(),
      });
      const registry = new EntityRegistry();
      registry.register(todo);
      // Swap in our populated registry without rebuilding the client.
      (client as unknown as { registry: EntityRegistry }).registry = registry;

      // The fetch impl here is the *real* fetch — if validation let
      // it through, this would 4xx at the server (unknown field is
      // still valid at the protocol layer, so this assertion hinges on
      // the client throwing first).
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const clock = createClock();
        const hlc = localEvent(clock);
        const action: Action = {
          id: "act_bad",
          actor_id: actor,
          hlc,
          gsn: 0,
          updates: [
            {
              id: "u_1",
              subject_id: "todo_rt_1",
              subject_type: "todo",
              method: "put",
              data: {
                fields: {
                  // `typo` is not declared on the entity.
                  typo: {
                    value: "should be title",
                    update_id: "u_1",
                    hlc,
                  },
                },
              },
            },
          ],
        };
        await expect(client.write([action])).rejects.toBeInstanceOf(EntityValidationError);
        // No warn-and-log: write() rejects before _applyAction.
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      client.close();
    }
  });

  it("accepts a valid client-side action and the server stores it", async () => {
    if (!(await shouldRun())) return;
    const actor = "todo_valid_actor";
    // Seed the entity + relationship via a no-registry client so the
    // write path is unconstrained for the bootstrap (relationship is
    // not in our test registry).
    const seedClient = await connectAsTodoActor(actor);
    const todoId = `todo_rt_${RUN_ID}`;
    const relId = `rel_${RUN_ID}_${todoId}`;
    const seedClock = createClock();
    const seedHlc = localEvent(seedClock);
    const { action: seedAction } = createAction({
      actorId: actor,
      clock: seedClock,
      updates: [
        {
          subject_id: todoId,
          subject_type: "todo",
          method: "put",
          data: { fields: {} },
        },
        {
          subject_id: relId,
          subject_type: "relationship",
          method: "put",
          data: {
            fields: {
              source_id: { value: todoId, update_id: "seed", hlc: seedHlc },
              target_id: { value: TEST_GROUP_ID, update_id: "seed", hlc: seedHlc },
              type: { value: "todo", update_id: "seed", hlc: seedHlc },
              field: { value: "ownedBy", update_id: "seed", hlc: seedHlc },
              kind: { value: "member", update_id: "seed", hlc: seedHlc },
            },
          },
        },
      ],
    });
    const seed = await seedClient.write([seedAction]);
    expect(seed.rejected).toEqual([]);
    seedClient.close();

    // Now connect with a strict registry and write a schema-valid update.
    await addMemberWithTodoPerms(actor);
    const client = createClient({ serverUrl: SERVER_URL, actorId: actor });
    const { groups } = await client.handshake();
    expect(groups.find((g) => g.id === TEST_GROUP_ID)).toBeDefined();
    client.setState("live");

    try {
      const registry = new EntityRegistry();
      registry.register(
        defineEntity("todo", {
          title: e.string(),
          completed: e.boolean(),
        }),
      );
      (client as unknown as { registry: EntityRegistry }).registry = registry;

      const hlc = makeHlc(Date.now());
      const action: Action = {
        id: "act_good",
        actor_id: actor,
        hlc,
        gsn: 0,
        updates: [
          {
            id: "u_1",
            subject_id: todoId,
            subject_type: "todo",
            method: "put",
            data: {
              fields: {
                title: { value: "Integration", update_id: "u_1", hlc },
                completed: { value: false, update_id: "u_1", hlc },
              },
            },
          },
        ],
      };
      const result = await client.write([action]);
      expect(result.rejected).toEqual([]);
      // Server should have stored the entity; read back via getEntity.
      const stored = await client.getEntity(todoId);
      expect(stored).not.toBeNull();
      expect(stored!.type).toBe("todo");
    } finally {
      client.close();
    }
  });

  it("warn-and-logs on incoming catchUp that violates the local registry", async () => {
    if (!(await shouldRun())) return;
    const seeder = "todo_incoming_seeder";
    const receiver = "todo_incoming_receiver";

    // Seeder (no registry): seed the entity + ownedBy relationship,
    // then write a schema-violating update. Both writes go through
    // the wire because the seeder has no registry to check against.
    const seederClient = await connectAsTodoActor(seeder);
    const todoId = `todo_inc_${RUN_ID}`;
    const relId = `rel_${RUN_ID}_${todoId}`;
    const seedClock = createClock();
    const seedHlc = localEvent(seedClock);
    const { action: seedAction } = createAction({
      actorId: seeder,
      clock: seedClock,
      updates: [
        {
          subject_id: todoId,
          subject_type: "todo",
          method: "put",
          data: { fields: {} },
        },
        {
          subject_id: relId,
          subject_type: "relationship",
          method: "put",
          data: {
            fields: {
              source_id: { value: todoId, update_id: "seed", hlc: seedHlc },
              target_id: { value: TEST_GROUP_ID, update_id: "seed", hlc: seedHlc },
              type: { value: "todo", update_id: "seed", hlc: seedHlc },
              field: { value: "ownedBy", update_id: "seed", hlc: seedHlc },
              kind: { value: "member", update_id: "seed", hlc: seedHlc },
            },
          },
        },
      ],
    });
    const seedResult = await seederClient.write([seedAction]);
    expect(seedResult.rejected).toEqual([]);

    const badHlc = makeHlc(Date.now());
    const badAction: Action = {
      id: "act_incoming_bad",
      actor_id: seeder,
      hlc: badHlc,
      gsn: 0,
      updates: [
        {
          id: "u_1",
          subject_id: todoId,
          subject_type: "todo",
          method: "put",
          data: {
            fields: {
              title: { value: "Hi", update_id: "u_1", hlc: badHlc },
              bogus: { value: 42, update_id: "u_1", hlc: badHlc },
            },
          },
        },
      ],
    };
    const seederResult = await seederClient.write([badAction]);
    expect(seederResult.rejected).toEqual([]);
    seederClient.close();

    // Receiver (with strict registry): catchUp should warn-and-log on
    // the violating action but still materialize the entity.
    await addMemberWithTodoPerms(receiver);
    const receiverClient = createClient({
      serverUrl: SERVER_URL,
      actorId: receiver,
    });
    const { groups } = await receiverClient.handshake();
    expect(groups.find((g) => g.id === TEST_GROUP_ID)).toBeDefined();
    receiverClient.setState("live");

    try {
      const registry = new EntityRegistry();
      registry.register(
        defineEntity("todo", {
          title: e.string(),
          completed: e.boolean(),
        }),
      );
      (receiverClient as unknown as { registry: EntityRegistry }).registry = registry;

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await receiverClient.catchUp(TEST_GROUP_ID);
        expect(warnSpy).toHaveBeenCalled();
        const warned = warnSpy.mock.calls.some((call) =>
          String(call[0] ?? "").includes("incoming action violation"),
        );
        expect(warned).toBe(true);
        // The entity still materializes despite the warning — the
        // title field is valid, even if `bogus` is not.
        const local = await receiverClient.readLocalEntity(todoId);
        expect(local).not.toBeNull();
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      receiverClient.close();
    }
  });
});

// ---------------------------------------------------------------------------
// defineRelationship + buildRelationshipWrite round-trip
// ---------------------------------------------------------------------------

/**
 * The server's existing authorization treats the relationship's
 * `target_id` as a group id when the update's subject_type is
 * `relationship`. User-to-user relationships require atomic
 * cross-entity creation, which is outside this primitive's scope.
 *
 * The round-trip exercises the public link surface via the
 * `ownedBy` shape the rest of the integration suite already uses.
 * One-cardinality writes submit a single Relationship Update —
 * no entity Update. The server's `RelationshipCache` resolves the
 * group via the relationship's `target_id`.
 *
 * Round-trip asserts:
 * - `client.todo.link(id, "ownedBy", groupId)` returns zero rejections;
 * - the actor's perspective after `catchUp` shows the relationship
 *   materialized;
 * - the reverse row accessor surfaces the source via the materialized
 *   Relationship cache.
 *
 * `unlink()` is not exercised here: the server's
 * `get_group_id_for_update` reads `target_id` from the wire's
 * `data` envelope, but a delete Update ships `data: null` per
 * the `Relationship` system wire convention. The `unlink()` API
 * surface and the unit-level path work; only the over-the-wire
 * round-trip is held until the authorizer learns to look up the
 * existing relationship for a delete.
 */

/**
 * Read a many-cardinality (reverse) row accessor and return the raw
 * linked entities. Accessor keys aren't in the projected static type
 * (per-entity accessor typing is a documented follow-up), and the
 * thenable chain projects fields only, so the read reaches through
 * `toRaw()` to keep the entity ids.
 */
const readLinkedRaw = async (
  row: Promise<unknown>,
  as: string,
): Promise<readonly { id: string }[]> => {
  const resolved = await row;
  if (resolved === null || resolved === undefined) {
    throw new Error(`expected row before reading accessor "${as}"`);
  }
  const builder = (resolved as Record<string, { toRaw(): Promise<readonly { id: string }[]> }>)[as];
  return builder.toRaw();
};

describe("integration: client.<entity>.link / unlink", () => {
  it("creates a todo + group link via the public link() API", async () => {
    if (!(await shouldRun())) return;
    const actor = `rel_roundtrip_${RUN_ID}`;
    await addMemberWithTodoPerms(actor);
    const todo = defineEntity("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    // The `target` here is a stand-in for "the group the source
    // belongs to"; the server's existing authorization treats the
    // relationship's `target_id` as a group id.
    const groupTarget = defineEntity("group", { name: e.string() });
    const ownedBy = defineRelationship({
      source: todo,
      target: groupTarget,
      as: "ownedBy",
      type: "todo",
    });
    const schema = defineSchema({
      // `group` is in `entities` so the reverse row accessor is
      // reachable on the target side (`client.group.get(id)`).
      entities: { todo, group: groupTarget },
      relationships: { ownedBy },
      version: 1,
    });
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: actor,
      schema,
    });
    const { groups } = await client.handshake();
    const ourGroup = groups.find((g) => g.id === TEST_GROUP_ID);
    expect(ourGroup, `actor ${actor} did not join ${TEST_GROUP_ID}`).toBeDefined();
    expect(ourGroup!.permissions).toContain("todo.*");
    client.setState("live");

    try {
      const todoId = `todo_rel_${RUN_ID}`;

      // Seed the entity + relationship in one Action so the writer's
      // intra-action context resolves the source entity's group from
      // the relationship in the same Action (otherwise the entity
      // update isn't indexed in cf_group_actions and the catchUp
      // query doesn't see it).
      const seedClock = createClock();
      const seedHlc = localEvent(seedClock);
      const seedEntityUpdate = {
        id: "u_seed",
        subject_id: todoId,
        subject_type: "todo",
        method: "put" as const,
        data: {
          fields: {
            title: { value: "Seed", update_id: "u_seed", hlc: seedHlc },
          },
        },
      };
      const seedWireResult = client.buildRelationshipWrite({
        source: todo,
        target: groupTarget,
        as: "ownedBy",
        sourceId: todoId,
        targetId: TEST_GROUP_ID,
      });
      // Wrap the entity + relationship in one Action so the writer's
      // intra-action context resolves the source entity's group
      // from the relationship Update (otherwise the entity isn't
      // indexed in cf_group_actions and catchUp won't see it).
      const relUpdate = Array.isArray(seedWireResult.relationshipUpdate)
        ? seedWireResult.relationshipUpdate[0]!
        : seedWireResult.relationshipUpdate;
      const { action: seedAction } = createAction({
        actorId: actor,
        clock: seedClock,
        updates: [seedEntityUpdate, relUpdate],
      });
      const seedResult = await client.write([seedAction]);
      expect(seedResult.rejected).toEqual([]);
      // The catchUp endpoint is paginated (default 200 actions); on
      // a server with thousands of historical actions the just-
      // written seed sits past the first page. Loop until upToDate
      // so the local cache actually contains the seed.
      await catchUpUntilCurrent(client, TEST_GROUP_ID);

      const linkResult = await client.todo.link(todoId, "ownedBy", TEST_GROUP_ID);
      expect(linkResult.rejected).toEqual([]);

      // Materialize locally and assert the link Update landed.
      await catchUpUntilCurrent(client, TEST_GROUP_ID);
      const links = await client.storage.entities.query("relationship");
      const materializedLink = links.find(
        (e) =>
          e.data?.fields?.["source_id"]?.value === todoId &&
          e.data?.fields?.["field"]?.value === "ownedBy",
      );
      expect(materializedLink).toBeDefined();
      expect(materializedLink!.data?.fields?.["target_id"]?.value).toBe(TEST_GROUP_ID);
      expect(materializedLink!.data?.fields?.["type"]?.value).toBe("todo");

      // The reverse row accessor surfaces the todo via the
      // materialized Relationship cache.
      const sources = await readLinkedRaw(client.group.get(TEST_GROUP_ID), "ownedBy");
      expect(sources.map((s) => s.id)).toContain(todoId);

      // The unlink() over-the-wire round-trip is held: the server's
      // authorization reads `target_id` from the wire's `data`
      // envelope, but a delete Update ships `data: null` per the
      // `Relationship` system wire convention. See the PR body's
      // follow-up section. The unit-level unlink() path works.
    } finally {
      client.close();
    }
  });

  it("removes a relationship via the public unlink() API over the wire", async () => {
    if (!(await shouldRun())) return;
    const actor = `rel_unlink_${RUN_ID}`;
    await addMemberWithTodoPerms(actor);

    const todo = defineEntity("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    const groupTarget = defineEntity("group", { name: e.string() });
    const ownedBy = defineRelationship({
      source: todo,
      target: groupTarget,
      as: "ownedBy",
      type: "todo",
    });
    const schema = defineSchema({
      // `group` is in `entities` so the reverse row accessor is
      // reachable on the target side (`client.group.get(id)`).
      entities: { todo, group: groupTarget },
      relationships: { ownedBy },
      version: 1,
    });
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: actor,
      schema,
    });
    const { groups } = await client.handshake();
    const ourGroup = groups.find((g) => g.id === TEST_GROUP_ID);
    expect(ourGroup, `actor ${actor} did not join ${TEST_GROUP_ID}`).toBeDefined();
    expect(ourGroup!.permissions).toContain("relationship.*");
    client.setState("live");

    try {
      const todoId = `todo_unlink_${RUN_ID}`;

      // Seed the entity + relationship in one Action so the writer's
      // intra-action context resolves the source entity's group.
      const seedClock = createClock();
      const seedHlc = localEvent(seedClock);
      const seedEntityUpdate = {
        id: "u_seed",
        subject_id: todoId,
        subject_type: "todo",
        method: "put" as const,
        data: {
          fields: {
            title: { value: "Seed", update_id: "u_seed", hlc: seedHlc },
          },
        },
      };
      const seedWireResult = client.buildRelationshipWrite({
        source: todo,
        target: groupTarget,
        as: "ownedBy",
        sourceId: todoId,
        targetId: TEST_GROUP_ID,
      });
      const relUpdate = Array.isArray(seedWireResult.relationshipUpdate)
        ? seedWireResult.relationshipUpdate[0]!
        : seedWireResult.relationshipUpdate;
      const { action: seedAction } = createAction({
        actorId: actor,
        clock: seedClock,
        updates: [seedEntityUpdate, relUpdate],
      });
      const seedResult = await client.write([seedAction]);
      expect(seedResult.rejected).toEqual([]);
      await catchUpUntilCurrent(client, TEST_GROUP_ID);

      // Sanity-check the link landed before unlinking it.
      let links = await client.storage.entities.query("relationship");
      const materializedLink = links.find(
        (e) =>
          e.data?.fields?.["source_id"]?.value === todoId &&
          e.data?.fields?.["field"]?.value === "ownedBy",
      );
      expect(materializedLink).toBeDefined();
      const relationshipSubjectId = materializedLink!.id;

      const unlinkResult = await client.todo.unlink(todoId, "ownedBy");
      expect(unlinkResult.rejected).toEqual([]);

      // Materialize locally and assert the delete landed in the
      // server-side RelationshipCache (forward direction). The
      // server tombstones the row rather than erasing it, so the
      // materialized entity either disappears or carries a
      // non-null `deleted_hlc`.
      await catchUpUntilCurrent(client, TEST_GROUP_ID);
      links = await client.storage.entities.query("relationship");
      const stillMaterialized = links.find((e) => e.id === relationshipSubjectId);
      const isTombstoned =
        stillMaterialized?.deleted_hlc !== null && stillMaterialized?.deleted_hlc !== undefined;
      const isGone = stillMaterialized === undefined;
      expect(
        isGone || isTombstoned,
        `expected the relationship ${relationshipSubjectId} to be removed or tombstoned after unlink(); got ${JSON.stringify(stillMaterialized)}`,
      ).toBe(true);

      // The reverse row accessor should also no longer surface the source.
      const sources = await readLinkedRaw(client.group.get(TEST_GROUP_ID), "ownedBy");
      expect(sources.map((s) => s.id)).not.toContain(todoId);
    } finally {
      client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: defineSchema composer + handshake wiring
// ---------------------------------------------------------------------------

describe("integration: defineSchema", () => {
  it("round-trips a schema-bearing handshake through the live server", async () => {
    if (!(await shouldRun())) return;
    const actor = "schema_handshake_actor";
    await addMemberWithTodoPerms(actor);

    const todo = defineEntity("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    const user = defineEntity("user", {
      name: e.string(),
    });
    const group = defineEntity("group", { name: e.string() });
    const todo_ownedBy = defineRelationship({
      source: todo,
      target: group,
      as: "ownedBy",
    });
    const schema = defineSchema({
      entities: { todo, user },
      relationships: { todo_ownedBy },
      version: 7,
      minSupportedVersion: 5,
    });

    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: actor,
      schema,
    });
    try {
      // The schema is held by reference on the client for the
      // handshake path; the unit tests cover the actual wire body.
      expect(client.schema).toBe(schema);
      expect(client.schema?.version).toBe(7);
      expect(client.schema?.minSupportedVersion).toBe(5);

      expect(client.registry.has("todo")).toBe(true);
      expect(client.registry.has("user")).toBe(true);
      expect(client.registry.get("todo")).toBe(todo);
      expect(client.registry.get("user")).toBe(user);
      // Relationships registered via defineSchema flow through to
      // the per-client registry, so client.registry.getRelationship
      // works the same as on a hand-built registry.
      const registered = client.registry.getRelationship("todo", "ownedBy");
      expect(registered?.source.name).toBe("todo");
      expect(registered?.target.name).toBe("group");

      // The server tolerates schema_version / min_supported_version
      // fields it doesn't understand today.
      const { groups } = await client.handshake();
      expect(groups.find((g) => g.id === TEST_GROUP_ID)).toBeDefined();
      client.setState("live");
    } finally {
      client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: runtime validation on writes (#172)
// ---------------------------------------------------------------------------

/**
 * Tests in this block run without a live ebb server — the
 * validator must throw before any HTTP call, so the wire stub
 * never needs to round-trip a real response.
 */
describe("integration: client.<entity>.create() runtime validation (#172)", () => {
  /** Records every URL it sees so tests can assert the wire was reached (or wasn't). */
  const mkRecordingFetch = (seen: string[]): typeof fetch => {
    return (async (url: string, _init: RequestInit): Promise<Response> => {
      seen.push(url);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  };

  it("rejects create({ title: 42 }) before any /sync/actions fetch", async () => {
    const seen: string[] = [];
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const todo = defineEntity("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    const schema = defineSchema({ entities: { todo }, version: 1 });
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: "validation_actor",
      storage,
      schema,
      fetchImpl: mkRecordingFetch(seen),
    });
    try {
      await expect(
        client.todo.create({ title: 42, completed: false } as never),
      ).rejects.toBeInstanceOf(EntityValidationError);
      expect(seen.some((u) => u.endsWith("/sync/actions"))).toBe(false);
    } finally {
      client.close();
    }
  });

  it("rejects create({ title: 'Ship', bogus: 'x' }) for an undeclared field", async () => {
    const seen: string[] = [];
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const todo = defineEntity("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    const schema = defineSchema({ entities: { todo }, version: 1 });
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: "validation_actor",
      storage,
      schema,
      fetchImpl: mkRecordingFetch(seen),
    });
    try {
      await expect(
        client.todo.create({ title: "Ship", completed: false, bogus: "x" } as never),
      ).rejects.toBeInstanceOf(EntityValidationError);
      expect(seen.some((u) => u.endsWith("/sync/actions"))).toBe(false);
    } finally {
      client.close();
    }
  });

  it("rejects update(id, { title: 99 }) before any /sync/actions fetch", async () => {
    const seen: string[] = [];
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const todo = defineEntity("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    const schema = defineSchema({ entities: { todo }, version: 1 });
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: "validation_actor",
      storage,
      schema,
      fetchImpl: mkRecordingFetch(seen),
    });
    try {
      await expect(client.todo.update("todo_1", { title: 99 } as never)).rejects.toBeInstanceOf(
        EntityValidationError,
      );
      expect(seen.some((u) => u.endsWith("/sync/actions"))).toBe(false);
    } finally {
      client.close();
    }
  });

  it("accepts a conforming create() and submits the wire Update", async () => {
    if (!(await shouldRun())) return;
    const actor = "validation_roundtrip";
    await addMemberWithTodoPerms(actor);
    const todo = defineEntity("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    const schema = defineSchema({ entities: { todo }, version: 1 });
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: actor,
      schema,
    });
    try {
      const { groups } = await client.handshake();
      expect(groups.find((g) => g.id === TEST_GROUP_ID)).toBeDefined();
      client.setState("live");

      const response = await client.todo.create({
        title: "Hello",
        completed: false,
      });
      expect(response.rejected).toEqual([]);
      const createdId = await findCreatedTodoId(client);
      const stored = await client.getEntity(createdId);
      expect(stored).not.toBeNull();
      expect(stored!.type).toBe("todo");
    } finally {
      client.close();
    }
  });
});

describe("integration: client.<entity>.delete", () => {
  it("tombstones a todo over the wire via the public delete() API", async () => {
    if (!(await shouldRun())) return;
    const actor = `delete_roundtrip_${RUN_ID}`;
    await addMemberWithTodoPerms(actor);

    const todo = defineEntity("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    // Stand-in for "the group the todo belongs to"; the server's
    // authorizer reads the target_id of the source's relationship to
    // resolve the group on a delete (whose wire data is null).
    const groupTarget = defineEntity("group", { name: e.string() });
    const ownedBy = defineRelationship({
      source: todo,
      target: groupTarget,
      as: "ownedBy",
      type: "todo",
    });
    const schema = defineSchema({
      entities: { todo },
      relationships: { ownedBy },
      version: 1,
    });
    const client = createClient({ serverUrl: SERVER_URL, actorId: actor, schema });
    const { groups } = await client.handshake();
    expect(groups.find((g) => g.id === TEST_GROUP_ID)).toBeDefined();
    client.setState("live");

    try {
      const todoId = `todo_delete_${RUN_ID}`;

      // Seed the entity + relationship in one Action so the
      // writer's intra-action context resolves the source's group
      // and cf_group_actions indexes the row for catchUp.
      const seedClock = createClock();
      const seedHlc = localEvent(seedClock);
      const seedEntityUpdate = {
        id: "u_seed",
        subject_id: todoId,
        subject_type: "todo",
        method: "put" as const,
        data: {
          fields: {
            title: { value: "Seed", update_id: "u_seed", hlc: seedHlc },
          },
        },
      };
      const seedWireResult = client.buildRelationshipWrite({
        source: todo,
        target: groupTarget,
        as: "ownedBy",
        sourceId: todoId,
        targetId: TEST_GROUP_ID,
      });
      const relUpdate = Array.isArray(seedWireResult.relationshipUpdate)
        ? seedWireResult.relationshipUpdate[0]!
        : seedWireResult.relationshipUpdate;
      const { action: seedAction } = createAction({
        actorId: actor,
        clock: seedClock,
        updates: [seedEntityUpdate, relUpdate],
      });
      const seedResult = await client.write([seedAction]);
      expect(seedResult.rejected).toEqual([]);
      await catchUpUntilCurrent(client, TEST_GROUP_ID);

      const before = await client.storage.entities.query("todo");
      expect(before.map((e) => e.id)).toContain(todoId);

      const deleteResult = await client.todo.delete(todoId);
      expect(deleteResult.rejected).toEqual([]);

      // The server tombstones the row rather than erasing it, so the
      // materialized entity survives with a non-null `deleted_hlc`.
      await catchUpUntilCurrent(client, TEST_GROUP_ID);
      const tombstone = await client.storage.entities.get(todoId);
      expect(tombstone).not.toBeNull();
      expect(tombstone!.deleted_hlc).not.toBeNull();
    } finally {
      client.close();
    }
  });
});

/**
 * Locate the just-written todo by scanning storage after
 * catch-up. The id-mint lives inside `submitEntityWrite`; this
 * helper exposes it to the test without leaking the API.
 */
async function findCreatedTodoId(client: import("../..").SyncClient): Promise<string> {
  await catchUpUntilCurrent(client, TEST_GROUP_ID);
  const stored = await client.storage.entities.query("todo");
  if (stored.length === 0) {
    throw new Error("findCreatedTodoId: no todo entity found in storage");
  }
  const sorted = [...stored].sort((a, b) => (a.created_hlc < b.created_hlc ? 1 : -1));
  return sorted[0]!.id;
}

// ---------------------------------------------------------------------------
// Integration: client.atomic (multi-entity Action)
// ---------------------------------------------------------------------------

/**
 * `client.atomic(...)` creates several entities plus their
 * relationships in one wire Action. The server commits the Action
 * atomically and materializes every Update, so a multi-entity create
 * round-trips as one unit.
 *
 * The relationships here target the test group: the server resolves a
 * user entity's group from a Relationship Update, so the entities in
 * the bundle have to be linked to their group in the same Action.
 */
describe("integration: client.atomic", () => {
  const atomicTodo = defineEntity("todo", { title: e.string() });
  const atomicList = defineEntity("list", { name: e.string() });
  const atomicGroup = defineEntity("group", { name: e.string() });
  const atomicTodoOwnedBy = defineRelationship({
    source: atomicTodo,
    target: atomicGroup,
    as: "ownedBy",
  });
  const atomicListOwnedBy = defineRelationship({
    source: atomicList,
    target: atomicGroup,
    as: "ownedBy",
  });
  const atomicSchema = defineSchema({
    entities: { todo: atomicTodo, list: atomicList },
    relationships: {
      todo_ownedBy: atomicTodoOwnedBy,
      list_ownedBy: atomicListOwnedBy,
    },
    version: 1,
  });

  it("creates multiple entities + their group links in one Action", async () => {
    if (!(await shouldRun())) return;
    const actor = `atomic_${RUN_ID}`;
    await addMemberWithTodoAndListPerms(actor);
    const client = createClient({ serverUrl: SERVER_URL, actorId: actor, schema: atomicSchema });
    const { groups } = await client.handshake();
    expect(groups.find((g) => g.id === TEST_GROUP_ID)).toBeDefined();
    client.setState("live");

    try {
      const created = await client.atomic(({ todo, list }) => {
        const today = list.create({ name: "Today", ownedBy: TEST_GROUP_ID });
        return {
          todo: todo.create({ title: "Ship it", ownedBy: TEST_GROUP_ID }),
          list: today,
        };
      });

      expect(created.todo.id).toMatch(/^e_/);
      expect(created.list.id).toMatch(/^e_/);
      expect(created.todo.ownedBy).toBe(TEST_GROUP_ID);
      expect(created.list.ownedBy).toBe(TEST_GROUP_ID);

      await catchUpUntilCurrent(client, TEST_GROUP_ID);
      const todos = await client.storage.entities.query("todo");
      const lists = await client.storage.entities.query("list");
      expect(todos.map((e) => e.id)).toContain(created.todo.id);
      expect(lists.map((e) => e.id)).toContain(created.list.id);

      const rels = await client.storage.entities.query("relationship");
      const linksFor = (sourceId: string): boolean =>
        rels.some(
          (e) =>
            e.data?.fields?.["source_id"]?.value === sourceId &&
            e.data?.fields?.["target_id"]?.value === TEST_GROUP_ID,
        );
      expect(linksFor(created.todo.id)).toBe(true);
      expect(linksFor(created.list.id)).toBe(true);
    } finally {
      client.close();
    }
  });
  it("creates multiple entities + their group links from a shared ActionDef", async () => {
    if (!(await shouldRun())) return;
    const actor = `atomicdef_${RUN_ID}`;
    await addMemberWithTodoAndListPerms(actor);
    const client = createClient({ serverUrl: SERVER_URL, actorId: actor, schema: atomicSchema });
    const { groups } = await client.handshake();
    expect(groups.find((g) => g.id === TEST_GROUP_ID)).toBeDefined();
    client.setState("live");

    try {
      const action = defineAction({
        writes: [atomicTodo, atomicList, atomicTodoOwnedBy, atomicListOwnedBy],
        values: {
          todo: { title: "Ship it", ownedBy: TEST_GROUP_ID },
          list: { name: "Today", ownedBy: TEST_GROUP_ID },
        },
      });
      const created = await client.atomic(action);

      expect(created.todo.id).toMatch(/^e_/);
      expect(created.list.id).toMatch(/^e_/);
      expect(created.todo.ownedBy).toBe(TEST_GROUP_ID);
      expect(created.list.ownedBy).toBe(TEST_GROUP_ID);

      await catchUpUntilCurrent(client, TEST_GROUP_ID);
      const todos = await client.storage.entities.query("todo");
      const lists = await client.storage.entities.query("list");
      expect(todos.map((e) => e.id)).toContain(created.todo.id);
      expect(lists.map((e) => e.id)).toContain(created.list.id);

      const rels = await client.storage.entities.query("relationship");
      const linksFor = (sourceId: string): boolean =>
        rels.some(
          (e) =>
            e.data?.fields?.["source_id"]?.value === sourceId &&
            e.data?.fields?.["target_id"]?.value === TEST_GROUP_ID,
        );
      expect(linksFor(created.todo.id)).toBe(true);
      expect(linksFor(created.list.id)).toBe(true);
    } finally {
      client.close();
    }
  });
});

/** Add an actor with `todo.*`, `list.*`, and `relationship.*` on the test group. */
async function addMemberWithTodoAndListPerms(actorId: string): Promise<void> {
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
          value: ["todo.*", "list.*", "relationship.*"],
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
    headers: { "Content-Type": "application/msgpack", "x-ebb-actor-id": TEST_SEEDER },
    body: body as BodyInit,
  });
  if (!res.ok) {
    throw new Error(`failed to add member ${actorId}: ${res.status} ${await res.text()}`);
  }
}
