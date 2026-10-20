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
 *   issues, and a self-join is refused;
 * - `addToWorkspace` files the actor's `groupMember` row and the
 *   actor's profile into the shared group in one Action, and the member
 *   then reads the shared issue;
 * - `client.can` on the shared issue is allowed for a member and the
 *   non-member's profile is not visible to assign;
 * - the `assignee` relationship writes and reads back through the
 *   `assignee` join;
 * - leaving drops the membership, and re-joining works without a reload;
 * - a fellow member backfills and reads the joined actor's profile content.
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
import { syncAllGroups } from "../sync-groups";
import { SERVER_URL, findRow, serverIsReachable } from "./integration-support";

const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const MEMBER_ID = `mem_it_${RUN_ID}`;
const OUTSIDER_ID = `out_it_${RUN_ID}`;
const MEMBER_PROFILE_ID = profileIdForActor(MEMBER_ID);
const OUTSIDER_PROFILE_ID = profileIdForActor(OUTSIDER_ID);

type Client = NamespacedClient<Schema, typeof workspaceActions>;

const mkClient = (actorId: string): Client =>
  createClient({ serverUrl: SERVER_URL, actorId, schema, actions: workspaceActions });

let member: Client;
let outsider: Client;
let seeder: Client;

beforeAll(async () => {
  if (!(await serverIsReachable())) {
    console.warn(`[skip] ebb server not reachable at ${SERVER_URL}`);
    return;
  }

  member = mkClient(MEMBER_ID);
  outsider = mkClient(OUTSIDER_ID);
  seeder = mkClient(SEEDER_ACTOR_ID);

  await member.seed(buildActorSeed(MEMBER_ID));
  await outsider.seed(buildActorSeed(OUTSIDER_ID));
  await seeder.seed(buildSharedSeed());

  await syncAllGroups(member);
  await syncAllGroups(outsider);
  await syncAllGroups(seeder);
});

afterAll(() => {
  member?.close();
  outsider?.close();
  seeder?.close();
});

describe("integration: workspace membership", () => {
  it("a non-member never receives the shared group, workspace, or issues", async () => {
    if (!(await serverIsReachable())) return;
    const groups = await syncAllGroups(outsider);
    expect(groups).not.toContain(SHARED_GROUP_ID);
    expect(findRow(await outsider.workspace.query(), SHARED_WORKSPACE_ID)).toBeUndefined();
    const visibleIssues = await outsider.issue.query();
    expect(visibleIssues).toEqual([]);
    expect(findRow(visibleIssues, SAMPLE_ISSUE_ID)).toBeUndefined();
  });

  it("a non-member cannot invite itself into the shared group", async () => {
    if (!(await serverIsReachable())) return;
    await syncAllGroups(outsider);

    await expect(
      outsider.actions.addToWorkspace({
        actorId: OUTSIDER_ID,
        profileId: OUTSIDER_PROFILE_ID,
        groupId: SHARED_GROUP_ID,
        permissions: SEED_PERMISSIONS,
      }),
    ).rejects.toThrow(/not allowed|missing/i);

    // The refused write left no membership behind.
    const groups = await syncAllGroups(outsider);
    expect(groups).not.toContain(SHARED_GROUP_ID);
  });

  it("inviting a member files the groupMember row and the profile's membership in one Action", async () => {
    if (!(await serverIsReachable())) return;

    const invited = await inviteToWorkspace({
      inviter: seeder,
      actorId: MEMBER_ID,
      groupId: SHARED_GROUP_ID,
      permissions: SEED_PERMISSIONS,
    });
    expect(invited).toBe(true);

    // Re-inviting is a no-op: the membership row already exists.
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

    // The profile membership is observable through the `groups` join.
    const groups = await syncAllGroups(member);
    expect(groups).toContain(SHARED_GROUP_ID);

    const profile = findRow(await member.profile.query().with({ groups: true }), MEMBER_PROFILE_ID);
    expect(profile).toBeDefined();
    expect(profile!.groups.map((group) => group.id)).toContain(SHARED_GROUP_ID);
  });

  it("the member reads the shared issue; a non-member's profile is not visible to assign", async () => {
    if (!(await serverIsReachable())) return;
    await syncAllGroups(member);

    const issue = findRow(await member.issue.query(), SAMPLE_ISSUE_ID);
    expect(issue).toBeDefined();
    expect(issue!.title).toBe("Welcome to ebb");

    expect(await member.can(SAMPLE_ISSUE_ID, "update")).toMatchObject({ kind: "allowed" });

    // The assignee picker offers only visible profiles; the outsider has
    // none in the member's view.
    const visible = (await member.profile.query()).map((profile) => profile.id);
    expect(visible).toContain(MEMBER_PROFILE_ID);
    expect(visible).not.toContain(OUTSIDER_PROFILE_ID);
  });

  it("writes and reads the issue→profile assignee relationship", async () => {
    if (!(await serverIsReachable())) return;
    await syncAllGroups(member);

    // A fresh issue per run: `issue_sample` is shared, and a repeated run
    // would otherwise leave assignee edges from earlier runs in the group.
    const created = await member.issue.create(
      { title: `assignee probe ${RUN_ID}`, status: "todo", priority: "low" },
      { groups: [SHARED_GROUP_ID] },
    );

    await member.issue.link(created.id, "assignee", MEMBER_PROFILE_ID);

    const issue = findRow(await member.issue.query().with({ assignee: true }), created.id);
    expect(issue).toBeDefined();
    expect(issue!.assignee?.id).toBe(MEMBER_PROFILE_ID);

    await member.issue.unlink(created.id, "assignee");
    const cleared = findRow(await member.issue.query().with({ assignee: true }), created.id);
    expect(cleared!.assignee).toBeNull();
  });

  it("leaving drops the membership, and a fresh client for the actor gets no shared group", async () => {
    if (!(await serverIsReachable())) return;

    const left = await leaveWorkspace({
      client: member,
      actorId: MEMBER_ID,
      groupId: SHARED_GROUP_ID,
    });
    expect(left).toBe(true);

    const fresh = mkClient(MEMBER_ID);
    try {
      const groups = await syncAllGroups(fresh);
      expect(groups).not.toContain(SHARED_GROUP_ID);
      expect(findRow(await fresh.issue.query(), SAMPLE_ISSUE_ID)).toBeUndefined();
    } finally {
      fresh.close();
    }
  });

  it("re-joining after leaving works within the same session", async () => {
    if (!(await serverIsReachable())) return;

    // The inviter is not subscribed; `inviteToWorkspace` catches up the
    // group so the leave is observed before the idempotency check.
    const rejoin = await inviteToWorkspace({
      inviter: seeder,
      actorId: MEMBER_ID,
      groupId: SHARED_GROUP_ID,
      permissions: SEED_PERMISSIONS,
    });
    expect(rejoin).toBe(true);

    const groups = await syncAllGroups(member);
    expect(groups).toContain(SHARED_GROUP_ID);
    expect(findRow(await member.issue.query(), SAMPLE_ISSUE_ID)).toBeDefined();
  });

  it("a fellow member backfills and reads the joined actor's profile content", async () => {
    if (!(await serverIsReachable())) return;

    // The inviter catches up the profile's membership row; backfill then
    // reads the content, which was written in the member's personal group.
    await seeder.backfill();
    const seen = findRow(await seeder.profile.query(), MEMBER_PROFILE_ID);
    expect(seen).toBeDefined();
    expect(seen!.actor_id).toBe(MEMBER_ID);
    expect(seen!.display_name).toBe(MEMBER_ID);

    // Visibility follows the membership: a non-member still reads nothing.
    expect(findRow(await outsider.profile.query(), MEMBER_PROFILE_ID)).toBeUndefined();
  });
});
