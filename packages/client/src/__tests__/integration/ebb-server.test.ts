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
 * - Conflict surfacing: `client.conflicts` via the outbox slot comparison
 *   (`outbox-integration.test.ts`).
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
  carriesComponent,
  componentName,
  createAction,
  createClock,
  decodeSync,
  EBB_COMPONENTS,
  EBB_MODEL_NAME,
  encodeSync,
  localEvent,
  makeHlc,
  systemValue,
  systemValueString,
  type Action,
  type EbbComponentKind,
  type Entity,
  type Update,
  type UpdateInput,
} from "@ebbjs/core";
import { createClient, defineAction, type SyncClient } from "../..";
import { CURRENT_TEXT_VERSION } from "@ebbjs/schema";
import { defineModel, e } from "@ebbjs/schema";
import { defineRelationship } from "@ebbjs/schema";
import { ModelRegistry, EntityValidationError } from "@ebbjs/schema";
import { defineSchema } from "@ebbjs/schema";
import { ebbSystemEntity } from "@ebbjs/schema";
import { testActions } from "../../sync/__tests__/test-actions";

const SERVER_URL = process.env.EBB_TEST_URL ?? "http://localhost:4000";

/** The model an Update commits under; `undefined` for a delete. */
const modelOf = (update: Update): string | undefined =>
  update.method === "delete" ? undefined : update.component.slice(0, update.component.indexOf("/"));

/** One wire Update per field: a user model's components write one at a time. */
const componentUpdates = (
  subjectId: string,
  model: string,
  fields: Record<string, unknown>,
  hlc: string,
  updateId = "seed",
): UpdateInput[] =>
  Object.entries(fields).map(([field, value]) => ({
    id: `${updateId}_${field}`,
    subject_id: subjectId,
    component: componentName(model, field),
    method: "replace" as const,
    data: { value, update_id: `${updateId}_${field}`, hlc },
  }));

/**
 * One atomic platform Update — `ebb/group`, `ebb/grant`, `ebb/membership`,
 * or `ebb/link`. The whole value rides in that component's single leaf, so a
 * fixture cannot build a torn platform row.
 */
const platformUpdate = (
  kind: EbbComponentKind,
  subjectId: string,
  value: Readonly<Record<string, unknown>>,
  hlc: string,
  updateId = "seed",
): UpdateInput => ({
  id: `${updateId}_${kind}`,
  subject_id: subjectId,
  component: EBB_COMPONENTS[kind],
  method: "replace" as const,
  data: { value, update_id: `${updateId}_${kind}`, hlc },
});

/**
 * Submit one Action as `actorId`, surfacing the server's per-Action
 * rejections: an empty `rejected[]` is the only acceptance, so a fixture
 * that drifts from the wire fails here with the server's own reason.
 */
async function postAction(actorId: string, action: Action, what: string): Promise<void> {
  const res = await fetch(`${SERVER_URL}/sync/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/msgpack", "x-ebb-actor-id": actorId },
    body: encodeSync({ actions: [action] }) as BodyInit,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: ${res.status} ${text}`);
  if (text === "") return;
  const body = JSON.parse(text) as { rejected?: readonly unknown[] };
  if (body.rejected !== undefined && body.rejected.length > 0) {
    throw new Error(`${what} was rejected: ${JSON.stringify(body.rejected)}`);
  }
}

/** Every live row carrying `kind` in the local replica. */
const platformRows = async (client: SyncClient, kind: EbbComponentKind): Promise<Entity[]> =>
  (await client.storage.entities.query(EBB_MODEL_NAME)).filter((row) =>
    carriesComponent(row, kind),
  );

/** The `ebb/link` row leaving `sourceId` under `field`, if materialized. */
const linkFrom = (rows: readonly Entity[], sourceId: string, field: string): Entity | undefined =>
  rows.find(
    (row) =>
      systemValueString(row, "link", "source_id") === sourceId &&
      systemValueString(row, "link", "field") === field,
  );

/** The permissions a regular test member holds in the test group. */
const MEMBER_PERMISSIONS = [
  "text_document.*",
  "ebb/group.read",
  "ebb/grant.*",
  "ebb/membership.*",
  "ebb/link.*",
] as const;

const TEST_SEEDER = "test_seeder";

/** Add an actor to the test group as one atomic `ebb/grant`, as the seeder. */
async function addMemberWithPerms(actorId: string, permissions: readonly string[]): Promise<void> {
  const clock = createClock();
  const { action } = createAction({
    actorId: TEST_SEEDER,
    clock,
    updates: [
      platformUpdate(
        "grant",
        grantRowId(actorId),
        { actor_id: actorId, group_id: TEST_GROUP_ID, permissions: [...permissions] },
        localEvent(clock),
        "add",
      ),
    ],
  });
  await postAction(TEST_SEEDER, action, `adding member ${actorId}`);
}

/** Unique per run so the test is reentrant against the same server. */
const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const TEST_GROUP_ID = `grp_it_${RUN_ID}`;
/**
 * An actor's `ebb/grant` row id, unique per run. The server's bootstrap
 * exemption only covers a grant row the existence index has not seen, so a
 * constant id would make every later run's bootstrap a plain unauthenticated
 * put into a group the actor does not belong to yet.
 */
const grantRowId = (actorId: string): string => `gm_${RUN_ID}_${actorId}`;
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

  // Bootstrap the test group in ONE action so the server's bootstrap
  // exemption applies: the `ebb/group` put, the acting actor's own
  // `ebb/grant` in that new group, and the `ebb/membership` of an entity the
  // same action creates.
  const bootstrapDocId = testDocId("bootstrap");
  const bootstrapMembershipId = `eg_${RUN_ID}_bootstrap`;
  const clock = createClock();
  const hlc = localEvent(clock);
  const updates: UpdateInput[] = [
    platformUpdate("group", TEST_GROUP_ID, { name: `Integration Test ${RUN_ID}` }, hlc),
    platformUpdate(
      "grant",
      grantRowId(TEST_SEEDER),
      {
        actor_id: TEST_SEEDER,
        group_id: TEST_GROUP_ID,
        permissions: [
          "text_document.*",
          "ebb/group.*",
          "ebb/grant.*",
          "ebb/membership.*",
          "ebb/link.*",
        ],
      },
      hlc,
    ),
    {
      subject_id: bootstrapDocId,
      component: "text_document/version",
      method: "replace",
      data: { value: CURRENT_TEXT_VERSION, update_id: "seed", hlc },
    },
    platformUpdate(
      "membership",
      bootstrapMembershipId,
      { entity_id: bootstrapDocId, group_id: TEST_GROUP_ID },
      hlc,
    ),
  ];
  const { action } = createAction({ actorId: TEST_SEEDER, updates, clock });
  await postAction(TEST_SEEDER, action, "seeding the test group");
}, 30_000);

afterAll(async () => {
  // No teardown — the test group is uniquely named and the server
  // doesn't care about leftover groups. Clear the data dir manually
  // if it grows too much.
});

/**
 * Add an actor as a member of the test group. Sent on behalf of the
 * seeder (which holds `ebb/grant.*` in the group).
 */
async function addMemberAsSeeder(actorId: string): Promise<void> {
  await addMemberWithPerms(actorId, MEMBER_PERMISSIONS);
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
 * Create an empty text_document in the test group plus its `ebb/membership`
 * row. Tests call this to get a fresh, isolated doc.
 */
async function createTestDoc(docId: string): Promise<void> {
  const clock = createClock();
  const hlc = localEvent(clock);
  const updates: UpdateInput[] = [
    {
      subject_id: docId,
      component: "text_document/version",
      method: "replace",
      data: { value: CURRENT_TEXT_VERSION, update_id: "seed", hlc },
    },
    platformUpdate(
      "membership",
      `eg_${RUN_ID}_${docId}`,
      { entity_id: docId, group_id: TEST_GROUP_ID },
      hlc,
    ),
  ];
  const { action } = createAction({ actorId: TEST_SEEDER, updates, clock });
  await postAction(TEST_SEEDER, action, `creating doc ${docId}`);
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

describe("integration: same-run concurrency (#762 fixtures)", () => {
  const openPair = async (docId: string) => {
    await createTestDoc(docId);
    const a = await connectAs(`a_${docId}`);
    const b = await connectAs(`b_${docId}`);
    const docA = a.textDocument(docId);
    const docB = b.textDocument(docId);
    docA.localInsert("I think I can");
    expect((await a.write(docA.pendingActions())).rejected).toHaveLength(0);
    docA.ackPending(docA.pendingActions().map((act) => act.id));
    const baseActions = (await fetchActions()).filter((action) =>
      action.updates.some((u) => u.subject_id === docId),
    );
    docB.applyActions(baseActions);
    const runId = docA.docState.index.spans[0]!.runId;
    return { a, b, docA, docB, runId, docId };
  };

  const exchange = async (pair: Awaited<ReturnType<typeof openPair>>): Promise<void> => {
    const { a, b, docA, docB, docId } = pair;
    expect((await a.write(docA.pendingActions())).rejected).toHaveLength(0);
    docA.ackPending(docA.pendingActions().map((act) => act.id));
    expect((await b.write(docB.pendingActions())).rejected).toHaveLength(0);
    docB.ackPending(docB.pendingActions().map((act) => act.id));
    const actions = (await fetchActions()).filter((action) =>
      action.updates.some((u) => u.subject_id === docId),
    );
    docA.applyActions(actions);
    docB.applyActions(actions);
  };

  it("insert vs insert converges on the exact text through a real Action exchange", async () => {
    if (!(await shouldRun())) return;
    const pair = await openPair(testDocId("concurrent_insert"));
    try {
      pair.docA.localInsert("X", { afterRun: pair.runId, splitParentAt: 7 });
      pair.docB.localInsert("Y", { afterRun: pair.runId, splitParentAt: 9 });
      await exchange(pair);
      expect(pair.docA.text).toBe("I thinkX IY can");
      expect(pair.docB.text).toBe("I thinkX IY can");
    } finally {
      pair.a.close();
      pair.b.close();
    }
  });

  it("delete vs insert converges and keeps the deleted range deleted", async () => {
    if (!(await shouldRun())) return;
    const pair = await openPair(testDocId("concurrent_delete"));
    try {
      pair.docA.localDelete({ runId: pair.runId, offset: 2, count: 5 });
      pair.docB.localInsert("X", { afterRun: pair.runId, splitParentAt: 7 });
      await exchange(pair);
      expect(pair.docA.text).toBe("I X I can");
      expect(pair.docB.text).toBe("I X I can");
    } finally {
      pair.a.close();
      pair.b.close();
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
      const bRunId = docB.docState.index.spans[0]!.runId;
      const bRun = docB.docState.runs.get(bRunId)!;
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
      expect(
        [...docB.docState.runs.values()].filter((run) => run.anchor.runId === "ROOT"),
      ).toHaveLength(1);
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
      const bRunId = docB.docState.index.spans[0]!.runId;
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
// Issue #143: defineModel + ModelRegistry round-trip
// ---------------------------------------------------------------------------

/**
 * Add an actor as a member of the test group with `todo.*` permissions on
 * top of the standard member grant — enough for writes to user-defined
 * entity types.
 */
async function addMemberWithTodoPerms(actorId: string): Promise<void> {
  await addMemberWithPerms(actorId, [...MEMBER_PERMISSIONS, "todo.*"]);
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

describe("integration: defineModel + ModelRegistry (#143)", () => {
  it("rejects a client-side unknown-field action before any fetch", async () => {
    if (!(await shouldRun())) return;
    const actor = "todo_validation_actor";
    const client = await connectAsTodoActor(actor);
    try {
      const todo = defineModel("todo", {
        title: e.string(),
        completed: e.boolean(),
      });
      const registry = new ModelRegistry();
      registry.register(todo);
      // Swap in our populated registry without rebuilding the client.
      (client as unknown as { registry: ModelRegistry }).registry = registry;

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
              // `typo` is not declared on the entity.
              component: "todo/typo",
              method: "replace",
              data: { value: "should be title", update_id: "u_1", hlc },
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
    const membershipId = `eg_${RUN_ID}_${todoId}`;
    const seedClock = createClock();
    const seedHlc = localEvent(seedClock);
    const { action: seedAction } = createAction({
      actorId: actor,
      clock: seedClock,
      updates: [
        ...componentUpdates(todoId, "todo", { title: "seed" }, seedHlc),
        platformUpdate(
          "membership",
          membershipId,
          { entity_id: todoId, group_id: TEST_GROUP_ID },
          seedHlc,
        ),
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
      const registry = new ModelRegistry();
      registry.register(
        defineModel("todo", {
          title: e.string(),
          completed: e.boolean(),
        }),
      );
      (client as unknown as { registry: ModelRegistry }).registry = registry;

      const hlc = makeHlc(Date.now());
      const action: Action = {
        id: "act_good",
        actor_id: actor,
        hlc,
        gsn: 0,
        updates: [
          {
            id: "u_1_0",
            subject_id: todoId,
            component: "todo/title",
            method: "replace",
            data: { value: "Integration", update_id: "u_1", hlc },
          },
          {
            id: "u_1_1",
            subject_id: todoId,
            component: "todo/completed",
            method: "replace",
            data: { value: false, update_id: "u_1", hlc },
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

    // Seeder (no registry): seed the entity + its `ebb/membership` row,
    // then write a schema-violating update. Both writes go through
    // the wire because the seeder has no registry to check against.
    const seederClient = await connectAsTodoActor(seeder);
    const todoId = `todo_inc_${RUN_ID}`;
    const membershipId = `eg_${RUN_ID}_${todoId}`;
    const seedClock = createClock();
    const seedHlc = localEvent(seedClock);
    const { action: seedAction } = createAction({
      actorId: seeder,
      clock: seedClock,
      updates: [
        ...componentUpdates(todoId, "todo", { title: "seed" }, seedHlc),
        platformUpdate(
          "membership",
          membershipId,
          { entity_id: todoId, group_id: TEST_GROUP_ID },
          seedHlc,
        ),
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
          id: "u_1_0",
          subject_id: todoId,
          component: "todo/title",
          method: "replace",
          data: { value: "Hi", update_id: "u_1", hlc: badHlc },
        },
        {
          id: "u_1_1",
          subject_id: todoId,
          component: "todo/bogus",
          method: "replace",
          data: { value: 42, update_id: "u_1", hlc: badHlc },
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
      const registry = new ModelRegistry();
      registry.register(
        defineModel("todo", {
          title: e.string(),
          completed: e.boolean(),
        }),
      );
      (receiverClient as unknown as { registry: ModelRegistry }).registry = registry;

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
// link / unlink primitives + canonical membership reads
// ---------------------------------------------------------------------------

/**
 * The draft `link` / `unlink` verbs exercise the one-cardinality
 * relationship write primitive on a domain edge. Membership is set up
 * with the canonical `create(input, { groups })` and read back through
 * `doc.groups`; the domain edge itself targets a synthetic wire id
 * (the server treats `target_id` as a reference, not a required row).
 */

/** Catch up, then find the todo with the given title via the local cache. */
async function findTodoByTitle(client: SyncClient, title: string): Promise<string> {
  await catchUpUntilCurrent(client, TEST_GROUP_ID);
  const rows = await client.storage.entities.query("todo");
  const match = rows.find((r) => r.data?.fields?.["title"]?.value === title);
  if (match === undefined) {
    throw new Error(`findTodoByTitle: no todo titled "${title}" in storage`);
  }
  return match.id;
}

/** One domain relationship from `todo` to `list`, plus the canonical schema. */
const buildLinkTestSchema = () => {
  const todo = defineModel("todo", {
    title: e.string(),
    completed: e.boolean(),
  });
  const list = defineModel("list", { name: e.string() });
  return defineSchema({
    models: { todo, list },
    relationships: {
      todo_list: defineRelationship({ source: todo, target: list, as: "list", type: "todo" }),
    },
    version: 1,
  });
};

describe("integration: draft create membership", () => {
  it("writes one ebb/membership row per group in the same Action", async () => {
    if (!(await shouldRun())) return;
    const actor = `membership_${RUN_ID}`;
    await addMemberWithTodoPerms(actor);
    const todo = defineModel("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    const schema = defineSchema({ models: { todo }, version: 1 });
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: actor,
      schema,
      actions: testActions(schema),
    });
    const { groups } = await client.handshake();
    expect(groups.find((g) => g.id === TEST_GROUP_ID)).toBeDefined();
    client.setState("live");

    try {
      const title = `Membership ${RUN_ID}`;
      await expect(
        client.actions.create({
          entity: "todo",
          input: { title, completed: false },
          groups: [TEST_GROUP_ID],
        }),
      ).resolves.toBeDefined();
      const todoId = await findTodoByTitle(client, title);

      await catchUpUntilCurrent(client, TEST_GROUP_ID);
      const rows = await platformRows(client, "membership");
      const membershipRows = rows.filter(
        (row) => systemValue(row, "membership")?.["entity_id"] === todoId,
      );
      expect(
        membershipRows.map((row) => systemValue(row, "membership")?.["group_id"]).sort(),
      ).toEqual([TEST_GROUP_ID]);

      // doc.groups resolves the materialized group.
      const row = await client.todo.get(todoId);
      if (row === null) throw new Error("expected row");
      const resolved = await row.groups.toRaw();
      expect(resolved.map((g) => g.id)).toContain(TEST_GROUP_ID);
    } finally {
      client.close();
    }
  });
});

describe("integration: draft link / unlink", () => {
  it("links a domain edge and resolves membership via doc.groups", async () => {
    if (!(await shouldRun())) return;
    const actor = `rel_roundtrip_${RUN_ID}`;
    await addMemberWithTodoPerms(actor);
    const relSchema = buildLinkTestSchema();
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: actor,
      schema: relSchema,
      actions: testActions(relSchema),
    });
    const { groups } = await client.handshake();
    const ourGroup = groups.find((g) => g.id === TEST_GROUP_ID);
    expect(ourGroup, `actor ${actor} did not join ${TEST_GROUP_ID}`).toBeDefined();
    client.setState("live");

    try {
      const title = `Link ${RUN_ID}`;
      await expect(
        client.actions.create({
          entity: "todo",
          input: { title, completed: false },
          groups: [TEST_GROUP_ID],
        }),
      ).resolves.toBeDefined();
      const todoId = await findTodoByTitle(client, title);

      // The canonical create() membership row resolves through doc.groups.
      const row = await client.todo.get(todoId);
      if (row === null) throw new Error("expected row");
      const membership = await row.groups.toRaw();
      expect(membership.map((g) => g.id)).toContain(TEST_GROUP_ID);

      // `link` records a Relationship put and returns nothing; the edge is
      // proven by the materialized row below, not by the resolved value.
      await expect(
        client.actions.link({
          entity: "todo",
          id: todoId,
          as: "list",
          target: "list_target_1",
        }),
      ).resolves.toBeUndefined();

      await catchUpUntilCurrent(client, TEST_GROUP_ID);
      const links = await platformRows(client, "link");
      const materializedLink = linkFrom(links, todoId, "list");
      expect(materializedLink).toBeDefined();
      expect(systemValueString(materializedLink, "link", "target_id")).toBe("list_target_1");
      expect(systemValueString(materializedLink, "link", "type")).toBe("todo");
    } finally {
      client.close();
    }
  });

  it("removes a domain edge via the public unlink() API over the wire", async () => {
    if (!(await shouldRun())) return;
    const actor = `rel_unlink_${RUN_ID}`;
    await addMemberWithTodoPerms(actor);
    const relSchema = buildLinkTestSchema();
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: actor,
      schema: relSchema,
      actions: testActions(relSchema),
    });
    const { groups } = await client.handshake();
    expect(groups.find((g) => g.id === TEST_GROUP_ID)).toBeDefined();
    client.setState("live");

    try {
      const title = `Unlink ${RUN_ID}`;
      await client.actions.create({
        entity: "todo",
        input: { title, completed: false },
        groups: [TEST_GROUP_ID],
      });
      const todoId = await findTodoByTitle(client, title);
      await client.actions.link({
        entity: "todo",
        id: todoId,
        as: "list",
        target: "list_target_2",
      });
      await catchUpUntilCurrent(client, TEST_GROUP_ID);

      let links = await platformRows(client, "link");
      const materializedLink = linkFrom(links, todoId, "list");
      expect(materializedLink).toBeDefined();
      const linkRowId = materializedLink!.id;

      await expect(
        client.actions.unlink({ entity: "todo", id: todoId, as: "list" }),
      ).resolves.toBeUndefined();

      await catchUpUntilCurrent(client, TEST_GROUP_ID);
      links = await platformRows(client, "link");
      const stillMaterialized = links.find((row) => row.id === linkRowId);
      const isTombstoned =
        stillMaterialized?.deleted_hlc !== null && stillMaterialized?.deleted_hlc !== undefined;
      const isGone = stillMaterialized === undefined;
      expect(
        isGone || isTombstoned,
        `expected the ebb/link row ${linkRowId} to be removed or tombstoned after unlink(); got ${JSON.stringify(stillMaterialized)}`,
      ).toBe(true);
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

    const todo = defineModel("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    const user = defineModel("user", {
      name: e.string(),
    });
    const todo_ownedBy = defineRelationship({
      source: todo,
      target: ebbSystemEntity,
      as: "ownedBy",
    });
    const schema = defineSchema({
      models: { todo, user },
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
      expect(registered?.target.name).toBe(EBB_MODEL_NAME);

      // Membership is a dedicated `ebb/membership` row, not an injected
      // relationship on the registry; the platform model is still registered
      // so its Updates validate and materialize.
      expect(client.registry.getRelationship("todo", "groups")).toBeUndefined();
      expect(client.registry.has(EBB_MODEL_NAME)).toBe(true);
      // `group` / `membership` are system namespaces; `entityGroup` stays
      // internal and names no model.
      expect((client as unknown as Record<string, unknown>)["group"]).toBeDefined();
      expect((client as unknown as Record<string, unknown>)["membership"]).toBeDefined();
      expect((client as unknown as Record<string, unknown>)["entityGroup"]).toBeUndefined();

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
describe("integration: draft create() runtime validation (#172)", () => {
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
    const todo = defineModel("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    const schema = defineSchema({ models: { todo }, version: 1 });
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: "validation_actor",
      storage,
      schema,
      actions: testActions(schema),
      fetchImpl: mkRecordingFetch(seen),
    });
    try {
      await expect(
        client.actions.create({
          entity: "todo",
          input: { title: 42, completed: false },
          groups: ["g_1"],
        }),
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
    const todo = defineModel("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    const schema = defineSchema({ models: { todo }, version: 1 });
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: "validation_actor",
      storage,
      schema,
      actions: testActions(schema),
      fetchImpl: mkRecordingFetch(seen),
    });
    try {
      await expect(
        client.actions.create({
          entity: "todo",
          input: { title: "Ship", completed: false, bogus: "x" },
          groups: ["g_1"],
        }),
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
    const todo = defineModel("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    const schema = defineSchema({ models: { todo }, version: 1 });
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: "validation_actor",
      storage,
      schema,
      actions: testActions(schema),
      fetchImpl: mkRecordingFetch(seen),
    });
    try {
      await expect(
        client.actions.update({ entity: "todo", id: "todo_1", patch: { title: 99 } }),
      ).rejects.toBeInstanceOf(EntityValidationError);
      expect(seen.some((u) => u.endsWith("/sync/actions"))).toBe(false);
    } finally {
      client.close();
    }
  });

  it("accepts a conforming create() and submits the wire Update", async () => {
    if (!(await shouldRun())) return;
    const actor = "validation_roundtrip";
    await addMemberWithTodoPerms(actor);
    const todo = defineModel("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    const schema = defineSchema({ models: { todo }, version: 1 });
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: actor,
      schema,
      actions: testActions(schema),
    });
    try {
      const { groups } = await client.handshake();
      expect(groups.find((g) => g.id === TEST_GROUP_ID)).toBeDefined();
      client.setState("live");

      await expect(
        client.actions.create({
          entity: "todo",
          input: { title: "Hello", completed: false },
          groups: [TEST_GROUP_ID],
        }),
      ).resolves.toBeDefined();
      const createdId = await findCreatedTodoId(client);
      const stored = await client.getEntity(createdId);
      expect(stored).not.toBeNull();
      expect(stored!.type).toBe("todo");
    } finally {
      client.close();
    }
  });
});

describe("integration: draft delete", () => {
  it("tombstones a todo over the wire via the public delete() API", async () => {
    if (!(await shouldRun())) return;
    const actor = `delete_roundtrip_${RUN_ID}`;
    await addMemberWithTodoPerms(actor);

    const todo = defineModel("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    const schema = defineSchema({ models: { todo }, version: 1 });
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: actor,
      schema,
      actions: testActions(schema),
    });
    const { groups } = await client.handshake();
    expect(groups.find((g) => g.id === TEST_GROUP_ID)).toBeDefined();
    client.setState("live");

    try {
      const title = `Delete ${RUN_ID}`;
      await expect(
        client.actions.create({
          entity: "todo",
          input: { title, completed: false },
          groups: [TEST_GROUP_ID],
        }),
      ).resolves.toBeDefined();
      const todoId = await findTodoByTitle(client, title);

      const before = await client.storage.entities.query("todo");
      expect(before.map((e) => e.id)).toContain(todoId);

      await expect(client.actions.delete({ entity: "todo", id: todoId })).resolves.toBeUndefined();

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
  const sorted = [...stored].sort((a, b) =>
    (a.created_hlc ?? "") < (b.created_hlc ?? "") ? 1 : -1,
  );
  return sorted[0]!.id;
}

// ---------------------------------------------------------------------------
// Integration: one Action over several entities
// ---------------------------------------------------------------------------

/**
 * A mounted action's callback creates several entities plus their group
 * memberships in one wire Action. The server commits the Action
 * atomically and materializes every Update, so a multi-entity create
 * round-trips as one unit.
 *
 * Each draft's `{ groups }` option emits an `ebb/membership` row into the
 * same Action, so the entities are indexed into their group atomically.
 */
describe("integration: multi-entity Action", () => {
  const atomicTodo = defineModel("todo", { title: e.string() });
  const atomicList = defineModel("list", { name: e.string() });
  const atomicSchema = defineSchema({
    models: { todo: atomicTodo, list: atomicList },
    version: 1,
  });

  it("creates multiple entities + their group memberships in one Action", async () => {
    if (!(await shouldRun())) return;
    const actor = `atomic_${RUN_ID}`;
    await addMemberWithTodoAndListPerms(actor);
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: actor,
      schema: atomicSchema,
      actions: testActions(atomicSchema),
    });
    const { groups } = await client.handshake();
    expect(groups.find((g) => g.id === TEST_GROUP_ID)).toBeDefined();
    client.setState("live");

    try {
      const created = await client.actions.run(({ todo, list }) => {
        const today = list.create({ name: "Today" }, { groups: [TEST_GROUP_ID] });
        return {
          todo: todo.create({ title: "Ship it" }, { groups: [TEST_GROUP_ID] }),
          list: today,
        };
      });

      expect(created.todo.id).toMatch(/^e_/);
      expect(created.list.id).toMatch(/^e_/);

      await catchUpUntilCurrent(client, TEST_GROUP_ID);
      const todos = await client.storage.entities.query("todo");
      const lists = await client.storage.entities.query("list");
      expect(todos.map((e) => e.id)).toContain(created.todo.id);
      expect(lists.map((e) => e.id)).toContain(created.list.id);

      // Both entities were indexed into the test group through the
      // `ebb/membership` components their single atomic Action emitted.
      const memberships = await platformRows(client, "membership");
      const membershipFor = (entityId: string): boolean =>
        memberships.some(
          (row) =>
            systemValue(row, "membership")?.["entity_id"] === entityId &&
            systemValue(row, "membership")?.["group_id"] === TEST_GROUP_ID,
        );
      expect(membershipFor(created.todo.id)).toBe(true);
      expect(membershipFor(created.list.id)).toBe(true);
    } finally {
      client.close();
    }
  });
});

/** Add an actor with `todo.*`, `list.*`, and `ebb/link.*` on the test group. */
async function addMemberWithTodoAndListPerms(actorId: string): Promise<void> {
  await addMemberWithPerms(actorId, ["todo.*", "list.*", "ebb/link.*"]);
}

// ---------------------------------------------------------------------------
// Integration: client.actions (schema-bound defineAction)
// ---------------------------------------------------------------------------

/**
 * A `defineAction` mounted as `client.actions.<name>` runs the same
 * resolver as the callback form: fresh drafts per call, one collector,
 * one wire Action, one `POST /sync/actions`. Each draft's `{ groups }`
 * option emits its `ebb/membership` row into that same Action.
 */
describe("integration: client.actions (defineAction)", () => {
  const actionTodo = defineModel("todo", { title: e.string() });
  const actionList = defineModel("list", { name: e.string() });
  const actionSchema = defineSchema({
    models: { todo: actionTodo, list: actionList },
    version: 1,
  });
  const createList = defineAction(actionSchema, ({ todo, list }, params: { title: string }) => {
    const today = list.create({ name: params.title }, { groups: [TEST_GROUP_ID] });
    return { todo: todo.create({ title: "Ship it" }, { groups: [TEST_GROUP_ID] }), list: today };
  });

  it("composes one Action and round-trips both entities", async () => {
    if (!(await shouldRun())) return;
    const actor = `actions_${RUN_ID}`;
    await addMemberWithTodoAndListPerms(actor);

    const written: Action[] = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/sync/actions") && init?.body instanceof Uint8Array) {
        written.push(...decodeSync<{ actions: Action[] }>(init.body).actions);
      }
      return fetch(input, init);
    };

    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: actor,
      schema: actionSchema,
      actions: { createList },
      fetchImpl: recordingFetch,
    });
    const { groups } = await client.handshake();
    expect(groups.find((g) => g.id === TEST_GROUP_ID)).toBeDefined();
    client.setState("live");

    try {
      const created = await client.actions.createList({ title: "Today" });
      expect(created.todo.id).toMatch(/^e_/);
      expect(created.list.id).toMatch(/^e_/);

      // One call ⇒ one Action; both entities and both membership
      // components ride in that Action.
      expect(written).toHaveLength(1);
      const updates = written[0]!.updates;
      expect(updates.some((u) => modelOf(u) === "todo")).toBe(true);
      expect(updates.some((u) => modelOf(u) === "list")).toBe(true);
      expect(
        new Set(
          updates
            .filter((u) => u.method !== "delete" && u.component === EBB_COMPONENTS.membership)
            .map((u) => u.subject_id),
        ).size,
      ).toBe(2);

      await catchUpUntilCurrent(client, TEST_GROUP_ID);
      const todos = await client.storage.entities.query("todo");
      const lists = await client.storage.entities.query("list");
      expect(todos.map((e) => e.id)).toContain(created.todo.id);
      expect(lists.map((e) => e.id)).toContain(created.list.id);
    } finally {
      client.close();
    }
  });
});
