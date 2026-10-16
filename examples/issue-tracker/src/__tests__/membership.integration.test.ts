/**
 * Integration tests for workspace membership and per-issue access
 * against a live ebb_server.
 *
 * Groups are closed by default (#126): the shared workspace's service
 * actor (`demo-seeder`) invites members, and the actor's client
 * re-handshakes to pick up the new group. Every `it` short-circuits
 * when the server isn't reachable, so `pnpm test` stays green without
 * one; `pnpm test:integration` targets these files when one is running.
 *
 * Covers:
 * - a non-member never receives the shared group, its workspace, or its
 *   issues;
 * - `addToWorkspace` files the actor's `groupMember` row and the
 *   actor's profile into the shared group in one Action, and the member
 *   then reads the shared issue;
 * - `client.can` on the shared issue flips with membership, matching the
 *   server's enforcement;
 * - the `assignee` relationship writes and reads back;
 * - leaving drops the membership, so a fresh client for that actor gets
 *   no shared group and no shared issues.
 *
 * Cross-member profile *content* visibility is blocked on #475 and is
 * asserted as a known gap at the bottom of this file.
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
  buildActorSeed,
  buildSharedSeed,
} from "../seed";
import {
  inviteToWorkspace,
  leaveWorkspace,
  profileIdForActor,
  workspaceActions,
} from "../workspace";

const SERVER_URL = process.env.EBB_TEST_URL ?? "http://localhost:4000";

const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const MEMBER_ID = `mem_it_${RUN_ID}`;
const OUTSIDER_ID = `out_it_${RUN_ID}`;
const MEMBER_PROFILE_ID = profileIdForActor(MEMBER_ID);

type Client = NamespacedClient<Schema, typeof workspaceActions>;

let serverReachable: boolean | null = null;

async function ping(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/sync/handshake`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ebb-actor-id": SEEDER_ACTOR_ID },
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

const shouldRun = async (): Promise<boolean> => await ensureServerReachable();

/** Drive `catchUp` until the server reports `upToDate: true`. */
async function catchUpAll(client: Client, groups: readonly { id: string }[]): Promise<void> {
  for (const group of groups) {
    for (let i = 0; i < 50; i++) {
      const { upToDate } = await client.catchUp(group.id);
      if (upToDate) break;
      if (i === 49) throw new Error(`catchUpAll: exhausted retries for group ${group.id}`);
    }
  }
}

/** Handshake and materialize every group the actor currently belongs to. */
async function syncGroups(client: Client): Promise<readonly string[]> {
  const { groups } = await client.handshake();
  await catchUpAll(client, groups);
  return groups.map((group) => group.id);
}

const mkClient = (actorId: string): Client =>
  createClient({ serverUrl: SERVER_URL, actorId, schema, actions: workspaceActions });

let member: Client;
let outsider: Client;
let seeder: Client;

beforeAll(async () => {
  if (!(await ensureServerReachable())) {
    console.warn(`[skip] ebb server not reachable at ${SERVER_URL}`);
    return;
  }

  member = mkClient(MEMBER_ID);
  outsider = mkClient(OUTSIDER_ID);
  seeder = mkClient(SEEDER_ACTOR_ID);

  await member.seed(buildActorSeed(MEMBER_ID));
  await outsider.seed(buildActorSeed(OUTSIDER_ID));
  await seeder.seed(buildSharedSeed());

  await syncGroups(member);
  await syncGroups(outsider);
  await syncGroups(seeder);
});

afterAll(() => {
  member?.close();
  outsider?.close();
  seeder?.close();
});

describe("integration: workspace membership", () => {
  it("a non-member never receives the shared group, workspace, or issues", async () => {
    if (!(await shouldRun())) return;
    const groups = await syncGroups(outsider);
    expect(groups).not.toContain(SHARED_GROUP_ID);
    expect(await outsider.workspace.get(SHARED_WORKSPACE_ID)).toBeNull();
    expect(await outsider.issue.get(SAMPLE_ISSUE_ID)).toBeNull();
    expect(await outsider.issue.query()).toEqual([]);
  });

  it("inviting a member files the groupMember row and the profile's membership in one Action", async () => {
    if (!(await shouldRun())) return;

    const invited = await inviteToWorkspace({
      inviter: seeder,
      actorId: MEMBER_ID,
      groupId: SHARED_GROUP_ID,
      permissions: SEED_PERMISSIONS,
    });
    expect(invited).toBe(true);

    // Re-inviting is a no-op: the membership row already exists locally.
    const again = await inviteToWorkspace({
      inviter: seeder,
      actorId: MEMBER_ID,
      groupId: SHARED_GROUP_ID,
      permissions: SEED_PERMISSIONS,
    });
    expect(again).toBe(false);

    const memberRow = (await seeder.membership.query()).find(
      (row) => row.actor_id === MEMBER_ID && row.group_id === SHARED_GROUP_ID,
    );
    expect(memberRow).toBeDefined();
    expect(memberRow!.permissions).toEqual([...SEED_PERMISSIONS]);

    // The profile membership is observable through the built-in accessor.
    const groups = await syncGroups(member);
    expect(groups).toContain(SHARED_GROUP_ID);

    const profile = await member.profile.get(MEMBER_PROFILE_ID);
    expect(profile).not.toBeNull();
    expect((await profile!.groups.toRaw()).map((group) => group.id)).toContain(SHARED_GROUP_ID);
  });

  it("the member reads the shared issue; client.can matches the server", async () => {
    if (!(await shouldRun())) return;
    await syncGroups(member);

    const issue = await member.issue.get(SAMPLE_ISSUE_ID);
    expect(issue).not.toBeNull();
    expect(issue!.title).toBe("Welcome to ebb");

    expect(await member.can(SAMPLE_ISSUE_ID, "update")).toMatchObject({ kind: "allowed" });
  });

  it("writes and reads the issue→profile assignee relationship", async () => {
    if (!(await shouldRun())) return;
    await syncGroups(member);

    // A fresh issue per run: `issue_sample` is shared, and a repeated run
    // would otherwise leave assignee edges from earlier runs in the group.
    const created = await member.issue.create(
      { title: `assignee probe ${RUN_ID}`, status: "todo", priority: "low" },
      { groups: [SHARED_GROUP_ID] },
    );

    await member.issue.link(created.id, "assignee", MEMBER_PROFILE_ID);

    const issue = await member.issue.get(created.id);
    expect(issue).not.toBeNull();
    const assignee = await issue!.assignee;
    expect(assignee?.id).toBe(MEMBER_PROFILE_ID);

    await member.issue.unlink(created.id, "assignee");
    const cleared = await member.issue.get(created.id);
    expect(await cleared!.assignee).toBeNull();
  });

  it("leaving drops the membership, and a fresh client for the actor gets no shared group", async () => {
    if (!(await shouldRun())) return;

    const left = await leaveWorkspace({
      client: member,
      actorId: MEMBER_ID,
      groupId: SHARED_GROUP_ID,
    });
    expect(left).toBe(true);

    const fresh = mkClient(MEMBER_ID);
    try {
      const groups = await syncGroups(fresh);
      expect(groups).not.toContain(SHARED_GROUP_ID);
      expect(await fresh.issue.get(SAMPLE_ISSUE_ID)).toBeNull();
    } finally {
      fresh.close();
    }
  });

  // Known gap: the shared group receives the `entityGroup` row naming the
  // member's profile, but not the profile's field writes, which happened
  // in the member's personal group. Backfilling content for membership
  // rows naming un-materialized entities is #475.
  it.skip("a fellow member reads the invited actor's profile content (#475)", async () => {
    if (!(await shouldRun())) return;
    const seen = await seeder.profile.get(MEMBER_PROFILE_ID);
    expect(seen?.display_name).toBe(MEMBER_ID);
  });
});
