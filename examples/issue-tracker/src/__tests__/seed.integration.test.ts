/**
 * Integration test for the issue-tracker seed against a live
 * ebb_server: `client.seed()` builds one Action from plain `SeedData`
 * and submits it through the public write path, so the seeded rows
 * round-trip through HTTP and back out through the typed namespaces.
 *
 * Mirrors the ping/skip pattern in
 * `packages/client/src/__tests__/integration/ebb-server.test.ts`:
 * every `it` short-circuits when the server isn't reachable, so the
 * default `pnpm test` stays green without a server. `pnpm
 * test:integration` targets this file when one is running.
 *
 * Covers:
 * - the actor's personal workspace / profile / group / own membership
 *   read back through `client.<entity>.query()` after handshake + catchUp;
 * - the workspace's membership resolves through the `groups` join to
 *   `grp_<actor>` and nothing else;
 * - the shared fixtures land under `demo-seeder` and read back through
 *   a seeder-side client;
 * - the actor's handshake does NOT include the shared group (membership
 *   bookkeeping is #441).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type NamespacedClient } from "@ebbjs/client";
import { schema, type Schema } from "../schema";
import {
  SAMPLE_ISSUE_ID,
  SEED_PERMISSIONS,
  SEEDER_ACTOR_ID,
  SHARED_GROUP_ID,
  SHARED_WORKSPACE_ID,
  SHARED_WORKSPACE_SLUG,
  buildActorSeed,
  buildSharedSeed,
  deriveActorSeedIds,
} from "../seed";
import { SERVER_URL, catchUpUntilCurrent, findRow, serverIsReachable } from "./integration-support";

/** Unique per run so re-running against the same server does not collide. */
const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const ACTOR_ID = `seed_it_${RUN_ID}`;
const IDS = deriveActorSeedIds(ACTOR_ID);

type Client = NamespacedClient<Schema>;

let actor: Client | null = null;
let seeder: Client | null = null;
let actorGroups: readonly { id: string }[] = [];

beforeAll(async () => {
  if (!(await serverIsReachable())) {
    console.warn(`[skip] ebb server not reachable at ${SERVER_URL}`);
    return;
  }

  actor = createClient({ serverUrl: SERVER_URL, actorId: ACTOR_ID, schema });
  await actor.seed(buildActorSeed(ACTOR_ID));

  seeder = createClient({ serverUrl: SERVER_URL, actorId: SEEDER_ACTOR_ID, schema });
  await seeder.seed(buildSharedSeed());

  const { groups } = await actor.handshake();
  actorGroups = groups;
  for (const group of groups) {
    await catchUpUntilCurrent(actor, group.id);
  }

  const { groups: seederGroups } = await seeder.handshake();
  for (const group of seederGroups) {
    await catchUpUntilCurrent(seeder, group.id);
  }
});

afterAll(() => {
  actor?.close();
  seeder?.close();
});

describe("integration: issue-tracker seed", () => {
  it("handshake returns only the actor's personal group, never the shared one", async () => {
    if (!(await serverIsReachable())) return;
    expect(actorGroups.map((group) => group.id)).toEqual([IDS.groupId]);
    expect(actorGroups.map((group) => group.id)).not.toContain(SHARED_GROUP_ID);
  });

  it("the actor's workspace reads back through the typed namespace", async () => {
    if (!(await serverIsReachable())) return;
    const row = findRow(await actor!.workspace.query(), IDS.workspaceId);
    expect(row).toBeDefined();
    expect(row!.name).toBe(`${ACTOR_ID}'s Workspace`);
    expect(row!.slug).toBe(ACTOR_ID);
    expect(row!.description).toBe(`Personal workspace for ${ACTOR_ID}`);
  });

  it("the actor's profile reads back through the typed namespace", async () => {
    if (!(await serverIsReachable())) return;
    const row = findRow(await actor!.profile.query(), IDS.profileId);
    expect(row).toBeDefined();
    expect(row!.actor_id).toBe(ACTOR_ID);
    expect(row!.display_name).toBe(ACTOR_ID);
    expect(row!.avatar_url).toBe("");
  });

  it("the actor's group reads back with the seeded name", async () => {
    if (!(await serverIsReachable())) return;
    const row = findRow(await actor!.group.query(), IDS.groupId);
    expect(row).toBeDefined();
    expect(row!.name).toBe(`${ACTOR_ID}'s Workspace`);
  });

  it("the actor's own membership reads back with the seed permissions", async () => {
    if (!(await serverIsReachable())) return;
    const row = findRow(await actor!.membership.query(), IDS.memberId);
    expect(row).toBeDefined();
    expect(row!.actor_id).toBe(ACTOR_ID);
    expect(row!.group_id).toBe(IDS.groupId);
    expect(row!.permissions).toEqual([...SEED_PERMISSIONS]);
  });

  it("files the workspace only into the actor's group, via the groups join", async () => {
    if (!(await serverIsReachable())) return;
    const row = findRow(await actor!.workspace.query().with({ groups: true }), IDS.workspaceId);
    expect(row).toBeDefined();
    expect(row!.groups.map((group) => group.id)).toEqual([IDS.groupId]);
  });

  it("the shared sample issue reads back through the seeder's typed namespace", async () => {
    if (!(await serverIsReachable())) return;
    const row = findRow(await seeder!.issue.query().with({ assignee: true }), SAMPLE_ISSUE_ID);
    expect(row).toBeDefined();
    expect(row!.title).toBe("Welcome to ebb");
    expect(row!.status).toBe("todo");
    expect(row!.priority).toBe("medium");
    expect(row!.assignee).toBeNull();
  });

  it("the shared workspace reads back through the seeder's typed namespace", async () => {
    if (!(await serverIsReachable())) return;
    const row = findRow(await seeder!.workspace.query(), SHARED_WORKSPACE_ID);
    expect(row).toBeDefined();
    expect(row!.name).toBe("Shared Workspace");
    expect(row!.slug).toBe(SHARED_WORKSPACE_SLUG);
    expect(row!.description).toBe("Issues shared with every member.");
  });
});
