/**
 * Integration test for the issue-tracker's issue write loop against a
 * live ebb_server. Every `it` short-circuits when the server isn't
 * reachable, matching `seed.integration.test.ts`; `pnpm test` stays
 * green without a server and `pnpm test:integration` exercises it.
 *
 * Covers:
 * - create with an `assignee` relationship in one atomic Action and read
 *   it back through the `issue.assignee` accessor;
 * - update, relationship filter, unlink, and soft delete;
 * - two actors in one shared group converge on the same issue state.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type NamespacedClient } from "@ebbjs/client";
import type { SeedData } from "@ebbjs/core/seed";
import { schema, type Schema } from "../schema";
import { SEED_PERMISSIONS, SEEDER_ACTOR_ID, buildActorSeed, deriveActorSeedIds } from "../seed";
import { SERVER_URL, catchUpUntilCurrent, serverIsReachable } from "./integration-support";

const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const ALICE = `crud_alice_${RUN_ID}`;
const BOB = `crud_bob_${RUN_ID}`;
const SHARED_GROUP_ID = `grp_crud_${RUN_ID}`;
const ALICE_IDS = deriveActorSeedIds(ALICE);

type Client = NamespacedClient<Schema>;

/**
 * A shared group the two test actors both belong to. The seeder
 * bootstraps the group first, then adds the two members in a second
 * Action — a group's first membership rides the server's bootstrap
 * exemption, later ones need the seeder's `groupMember.*` permission.
 */
async function seedSharedGroup(seeder: Client): Promise<void> {
  const bootstrap: SeedData = {
    groups: [{ id: SHARED_GROUP_ID, name: `CRUD ${RUN_ID}` }],
    groupMembers: [
      {
        id: `gms_crud_seeder_${RUN_ID}`,
        actorId: SEEDER_ACTOR_ID,
        groupId: SHARED_GROUP_ID,
        permissions: [...SEED_PERMISSIONS],
      },
    ],
    entities: [],
  };
  await seeder.seed(bootstrap);

  const members: SeedData = {
    groups: [],
    groupMembers: [
      {
        id: `gms_crud_alice_${RUN_ID}`,
        actorId: ALICE,
        groupId: SHARED_GROUP_ID,
        permissions: [...SEED_PERMISSIONS],
      },
      {
        id: `gms_crud_bob_${RUN_ID}`,
        actorId: BOB,
        groupId: SHARED_GROUP_ID,
        permissions: [...SEED_PERMISSIONS],
      },
    ],
    entities: [],
  };
  await seeder.seed(members);
}

let alice: Client | null = null;
let bob: Client | null = null;
let seeder: Client | null = null;

beforeAll(async () => {
  if (!(await serverIsReachable())) {
    console.warn(`[skip] ebb server not reachable at ${SERVER_URL}`);
    return;
  }

  alice = createClient({ serverUrl: SERVER_URL, actorId: ALICE, schema });
  await alice.seed(buildActorSeed(ALICE));

  bob = createClient({ serverUrl: SERVER_URL, actorId: BOB, schema });
  await bob.seed(buildActorSeed(BOB));

  seeder = createClient({ serverUrl: SERVER_URL, actorId: SEEDER_ACTOR_ID, schema });
  await seedSharedGroup(seeder);

  for (const client of [alice, bob]) {
    const { groups } = await client.handshake();
    for (const group of groups) {
      await catchUpUntilCurrent(client, group.id);
    }
  }
});

afterAll(() => {
  alice?.close();
  bob?.close();
  seeder?.close();
});

describe("integration: issue CRUD", () => {
  it("creates with an assignee link and reads it back through the accessor", async () => {
    if (!(await serverIsReachable())) return;

    const created = await alice!.atomic((drafts) =>
      drafts.issue.create(
        { title: "First issue", status: "todo", priority: "medium", assignee: ALICE_IDS.profileId },
        { groups: [ALICE_IDS.groupId] },
      ),
    );
    await catchUpUntilCurrent(alice!, ALICE_IDS.groupId);

    const row = await alice!.issue.get(created.id);
    expect(row).not.toBeNull();
    expect(row!.title).toBe("First issue");
    const assignee = await row!.assignee;
    expect(assignee?.id).toBe(ALICE_IDS.profileId);
  });

  it("updates fields, filters by the relationship, unlinks, and deletes", async () => {
    if (!(await serverIsReachable())) return;

    const created = await alice!.atomic((drafts) =>
      drafts.issue.create(
        { title: "Second issue", status: "todo", priority: "low", assignee: ALICE_IDS.profileId },
        { groups: [ALICE_IDS.groupId] },
      ),
    );
    await catchUpUntilCurrent(alice!, ALICE_IDS.groupId);

    await alice!.issue.update(created.id, { status: "in_progress", priority: "high" });
    await catchUpUntilCurrent(alice!, ALICE_IDS.groupId);
    const updated = await alice!.issue.get(created.id);
    expect(updated?.status).toBe("in_progress");
    expect(updated?.priority).toBe("high");

    const filtered = await alice!.issue.query().where("assignee", ALICE_IDS.profileId);
    expect(filtered.map((issue) => issue.id)).toContain(created.id);

    await alice!.issue.unlink(created.id, "assignee");
    await catchUpUntilCurrent(alice!, ALICE_IDS.groupId);
    const cleared = await alice!.issue.get(created.id);
    expect(await cleared!.assignee).toBeNull();

    await alice!.issue.delete(created.id);
    await catchUpUntilCurrent(alice!, ALICE_IDS.groupId);
    const list = await alice!.issue.query();
    expect(list.map((issue) => issue.id)).not.toContain(created.id);
  });

  it("converges two actors on one issue state", async () => {
    if (!(await serverIsReachable())) return;

    const created = await alice!.atomic((drafts) =>
      drafts.issue.create(
        { title: "Shared issue", status: "todo", priority: "medium" },
        { groups: [SHARED_GROUP_ID] },
      ),
    );
    await catchUpUntilCurrent(bob!, SHARED_GROUP_ID);
    const bobView = await bob!.issue.get(created.id);
    expect(bobView?.title).toBe("Shared issue");

    // Different fields from each actor so the merge keeps both.
    await bob!.issue.update(created.id, { status: "done" });
    await alice!.issue.update(created.id, { priority: "urgent" });

    await catchUpUntilCurrent(alice!, SHARED_GROUP_ID);
    await catchUpUntilCurrent(bob!, SHARED_GROUP_ID);
    const aliceFinal = await alice!.issue.get(created.id);
    const bobFinal = await bob!.issue.get(created.id);
    for (const row of [aliceFinal, bobFinal]) {
      expect(row?.status).toBe("done");
      expect(row?.priority).toBe("urgent");
    }
  });
});
