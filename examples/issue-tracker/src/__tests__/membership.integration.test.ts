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
 * - the invite files the actor's `groupMember` row and leaves the profile
 *   pending, and the invitee's own client then shares it (#623);
 * - a member cannot file another actor's profile into the workspace;
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
  MEMBER_PERMISSIONS,
  SAMPLE_ISSUE_ID,
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
  shareProfileToWorkspace,
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
      outsider.actions.inviteMember({
        actorId: OUTSIDER_ID,
        groupId: SHARED_GROUP_ID,
        permissions: MEMBER_PERMISSIONS,
      }),
    ).rejects.toThrow(/not allowed|missing/i);

    // The refused write left no membership behind.
    const groups = await syncAllGroups(outsider);
    expect(groups).not.toContain(SHARED_GROUP_ID);
  });

  it("the invite files the member row and leaves the profile pending", async () => {
    if (!(await serverIsReachable())) return;

    const invited = await inviteToWorkspace({
      inviter: seeder,
      actorId: MEMBER_ID,
      groupId: SHARED_GROUP_ID,
      permissions: MEMBER_PERMISSIONS,
    });
    expect(invited).toBe(true);

    // Re-inviting is a no-op: the membership row already exists.
    const again = await inviteToWorkspace({
      inviter: seeder,
      actorId: MEMBER_ID,
      groupId: SHARED_GROUP_ID,
      permissions: MEMBER_PERMISSIONS,
    });
    expect(again).toBe(false);

    const memberRow = (await seeder.membership.query()).find(
      (row) => row.actor_id === MEMBER_ID && row.group_id === SHARED_GROUP_ID,
    );
    expect(memberRow).toBeDefined();
    expect(memberRow!.permissions).toEqual([...MEMBER_PERMISSIONS]);

    const groups = await syncAllGroups(member);
    expect(groups).toContain(SHARED_GROUP_ID);
  });

  it("the invitee's own client shares its profile, and a repeat share is a no-op", async () => {
    if (!(await serverIsReachable())) return;

    // `profile-pending` before the share: the member exists, the profile
    // is not filed in the workspace yet.
    const pending = findRow(await member.profile.query().with({ groups: true }), MEMBER_PROFILE_ID);
    expect(pending?.groups.map((group) => group.id) ?? []).not.toContain(SHARED_GROUP_ID);

    expect(
      await shareProfileToWorkspace({
        client: member,
        actorId: MEMBER_ID,
        groupId: SHARED_GROUP_ID,
      }),
    ).toBe(true);

    const shared = findRow(await member.profile.query().with({ groups: true }), MEMBER_PROFILE_ID);
    expect(shared).toBeDefined();
    expect(shared!.groups.map((group) => group.id)).toContain(SHARED_GROUP_ID);

    // One row per (entity, group): sharing again writes nothing new.
    await shareProfileToWorkspace({ client: member, actorId: MEMBER_ID, groupId: SHARED_GROUP_ID });
    const sharedAgain = findRow(
      await member.profile.query().with({ groups: true }),
      MEMBER_PROFILE_ID,
    );
    expect(sharedAgain!.groups.filter((group) => group.id === SHARED_GROUP_ID)).toHaveLength(1);
  });

  it("a member cannot file another actor's profile into the workspace", async () => {
    if (!(await serverIsReachable())) return;

    // The #623 graft, from inside the group: `profile.create` in the
    // workspace is not enough to file a profile that lives in someone
    // else's personal group. The local pass cannot see the outsider's
    // group set, so the server is the one that refuses.
    const graft = await member.profile.addToGroup(OUTSIDER_PROFILE_ID, SHARED_GROUP_ID);
    expect(graft.rejected.map((r) => r.reason)).toContain("not_authorized");

    const visible = (await member.profile.query()).map((profile) => profile.id);
    expect(visible).not.toContain(OUTSIDER_PROFILE_ID);
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
      permissions: MEMBER_PERMISSIONS,
    });
    expect(rejoin).toBe(true);

    const groups = await syncAllGroups(member);
    expect(groups).toContain(SHARED_GROUP_ID);
    expect(findRow(await member.issue.query(), SAMPLE_ISSUE_ID)).toBeDefined();

    // Re-joining shares the profile again, which the leave removed.
    const reshare = await member.profile.addToGroup(MEMBER_PROFILE_ID, SHARED_GROUP_ID);
    expect(reshare.rejected).toEqual([]);
    const profile = findRow(await member.profile.query().with({ groups: true }), MEMBER_PROFILE_ID);
    expect(profile!.groups.map((group) => group.id)).toContain(SHARED_GROUP_ID);
  });

  it("a fellow member backfills and reads the joined actor's profile content", async () => {
    if (!(await serverIsReachable())) return;

    // A fresh client for the fellow member. The share is authored by the
    // invitee now, not by the seeder, so observing it is a catch-up plus a
    // backfill: the membership row arrives through the group's Action
    // stream and the content, which lives in the member's personal group,
    // through the backfill.
    const fellow = mkClient(SEEDER_ACTOR_ID);
    try {
      await syncAllGroups(fellow);
      await fellow.backfill();

      const seen = findRow(await fellow.profile.query(), MEMBER_PROFILE_ID);
      expect(seen).toBeDefined();
      expect(seen!.actor_id).toBe(MEMBER_ID);
      expect(seen!.display_name).toBe(MEMBER_ID);
    } finally {
      fellow.close();
    }

    // Visibility follows the membership: a non-member still reads nothing.
    await syncAllGroups(outsider);
    await outsider.backfill();
    expect(findRow(await outsider.profile.query(), MEMBER_PROFILE_ID)).toBeUndefined();
  });
});
