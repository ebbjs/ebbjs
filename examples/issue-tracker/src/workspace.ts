/**
 * Workspace membership for the issue-tracker demo.
 *
 * A workspace is a Group; an actor joins it through a `groupMember` row,
 * and the actor's group-scoped `profile` is made visible to the workspace
 * by an `entityGroup` row. The two writes belong to different actors and
 * cannot share an Action:
 *
 * 1. **Invite** — a member of the workspace puts the invitee's
 *    `groupMember` row (`groupMember.create` in that group). Groups are
 *    closed by default (#126), so the demo invites through the shared
 *    workspace's service actor (`demo-seeder`).
 * 2. **Share** — the invitee's *own* client files their profile into the
 *    group. Filing an entity the server already places in a group is a
 *    write to that entity, so it needs `<type>.update` where the profile
 *    lives (the actor's personal group) as well as `<type>.create` in the
 *    target (#623). Only the profile's owner holds the first.
 *
 * One Action carries one actor's authority, so the invite and the share
 * are two Actions by two clients. Between them the member exists and the
 * profile does not: that is the `profile-pending` window, and it closes
 * when the invitee's own client runs `shareProfileToWorkspace` — joining
 * is the only path in this demo that shares a profile, so an actor invited
 * while away stays pending until they join.
 *
 * Leaving is self-service: the invite grants the new member the
 * permissions to drop its own rows again, and the profile membership is
 * removed by the member's own client — the same owner-side authority the
 * share needs.
 *
 * The client can't delete a `groupMember` through the atomic planner (the
 * drafts expose `create` / `addToGroup` / `removeFromGroup`, no delete),
 * so `leaveWorkspace` is two Actions. The profile membership is removed
 * first: it is authorized by the actor's `profile.*` permission in its
 * personal group, which survives the `groupMember` deletion.
 */

import { defineAction, type NamespacedClient } from "@ebbjs/client";
import { schema, type Schema } from "./schema";
import { deriveActorSeedIds } from "./seed";

/**
 * The `inviteMember` Action: put the joining actor's `groupMember` row for
 * the workspace group. No entity scoop rides along — the profile is shared
 * by the invitee's own client (see `shareProfileToWorkspace`), because the
 * inviter has no permission in the group the profile lives in (#623).
 *
 * Run by a member of the target group (the demo's `demo-seeder`); a
 * non-member's attempt is refused by the local permission pass and, if it
 * reached the wire, by the server.
 */
export const inviteMember = defineAction(
  schema,
  (
    { membership },
    params: {
      readonly actorId: string;
      readonly groupId: string;
      readonly permissions: readonly string[];
    },
  ): void => {
    membership.create({
      group_id: params.groupId,
      actor_id: params.actorId,
      permissions: [...params.permissions],
    });
  },
);

export const workspaceActions = { inviteMember } as const;

export type WorkspaceActions = typeof workspaceActions;

/** The typed client every workspace-membership helper is bound to. */
export type WorkspaceClient = NamespacedClient<Schema, WorkspaceActions>;

/** The profile entity id the seed derives for an actor. */
export function profileIdForActor(actorId: string): string {
  return deriveActorSeedIds(actorId).profileId;
}

export interface InviteToWorkspaceInput {
  /** A client for a group member allowed to invite — the demo's service actor. */
  readonly inviter: WorkspaceClient;
  readonly actorId: string;
  readonly groupId: string;
  readonly permissions: readonly string[];
}

/**
 * Invite `actorId` into `groupId` unless a live `groupMember` row already
 * names them. Returns whether an invite was submitted.
 *
 * The inviter catches up `groupId` first: it is not subscribed to the
 * group's live stream, so a membership removed since its last read stays
 * in its local cache until a catch-up observes the delete. Without this a
 * leave-then-rejoin within one session looks like a duplicate invite.
 */
export async function inviteToWorkspace(input: InviteToWorkspaceInput): Promise<boolean> {
  const { inviter, actorId, groupId, permissions } = input;
  await inviter.catchUp(groupId);
  const members = await inviter.membership.query();
  if (members.some((member) => member.actor_id === actorId && member.group_id === groupId)) {
    return false;
  }
  await inviter.actions.inviteMember({ actorId, groupId, permissions });
  return true;
}

export interface ShareProfileToWorkspaceInput {
  /** The invitee's own client: only the profile's owner may share it. */
  readonly client: MembershipWriter;
  readonly actorId: string;
  readonly groupId: string;
}

/**
 * File `actorId`'s profile into `groupId` with the profile's own client.
 * Idempotent: a profile already filed in the group is left alone, which is
 * what makes a retry or a second device safe — one row per
 * `(entity, group)`.
 *
 * Returns whether a share was submitted.
 */
export async function shareProfileToWorkspace(
  input: ShareProfileToWorkspaceInput,
): Promise<boolean> {
  const { client, actorId, groupId } = input;
  const profileId = profileIdForActor(actorId);
  const rows = await client.membership.query();
  if (rows.some((row) => row.actor_id === actorId && row.group_id === groupId) === false) {
    return false;
  }
  await client.profile.addToGroup(profileId, groupId);
  return true;
}

export interface LeaveWorkspaceInput {
  /** The leaving actor's own client; only the two system namespaces it writes. */
  readonly client: MembershipWriter;
  readonly actorId: string;
  readonly groupId: string;
}

/** The namespaces a leave writes through: the actor's `profile` and `groupMember` rows. */
export type MembershipWriter = Pick<NamespacedClient<Schema>, "profile" | "membership">;

/**
 * Drop the actor's `groupMember` row and their profile's membership in
 * `groupId`. Returns whether a membership was found and removed.
 */
export async function leaveWorkspace(input: LeaveWorkspaceInput): Promise<boolean> {
  const { client, actorId, groupId } = input;
  const members = await client.membership.query();
  const member = members.find(
    (candidate) => candidate.actor_id === actorId && candidate.group_id === groupId,
  );
  if (member === undefined) return false;
  await client.profile.removeFromGroup(profileIdForActor(actorId), groupId);
  await client.membership.delete(member.id);
  return true;
}
