/**
 * Workspace membership for the issue-tracker demo.
 *
 * A workspace is a Group; an actor joins through a `groupMember` row, and their
 * group-scoped `profile` is made visible by an `entityGroup` row. Those two
 * writes belong to different actors, so they cannot share an Action:
 *
 * 1. **Invite** — a workspace member puts the invitee's `groupMember` row
 *    (`inviteMember`, run by the `demo-seeder` service actor since groups are
 *    closed by default, #126).
 * 2. **Share** — the invitee's own client files their profile
 *    (`shareProfile`). Filing an entity the server already places in a group is
 *    a write to it, so it needs `<type>.update` where the profile lives (the
 *    actor's personal group) as well as `<type>.create` in the target (#623) —
 *    and only the owner holds the first.
 *
 * Between the two Actions the member exists and the profile does not: the
 * `profile-pending` window. Leaving is self-service with the same owner-side
 * authority, and one `leaveWorkspace` Action, drafted profile first — that write
 * is authorized in the personal group, which survives the `groupMember` delete.
 *
 * The helpers here sequence reads and Actions; the Actions themselves live in
 * `./actions`.
 */

import type { IssueTrackerClient } from "./bootstrap";
import { deriveActorSeedIds } from "./seed";

/** The profile entity id the seed derives for an actor. */
export function profileIdForActor(actorId: string): string {
  return deriveActorSeedIds(actorId).profileId;
}

export interface InviteToWorkspaceInput {
  /** A client for a group member allowed to invite — the demo's service actor. */
  readonly inviter: IssueTrackerClient;
  readonly actorId: string;
  readonly groupId: string;
  readonly permissions: readonly string[];
}

/**
 * Invite `actorId` into `groupId` unless a live `groupMember` row already names
 * them. Catching up first matters: a membership removed since the inviter's last
 * read otherwise looks like a live one, and a leave-then-rejoin becomes a
 * duplicate invite.
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
  readonly client: IssueTrackerClient;
  readonly actorId: string;
  readonly groupId: string;
}

/**
 * File `actorId`'s profile into `groupId` with the profile's own client — a
 * client that is not a member files nothing, since the profile would be visible
 * nowhere. The write is idempotent (one row per `(entity, group)`), so a retry
 * or a second device is safe.
 */
export async function shareProfileToWorkspace(
  input: ShareProfileToWorkspaceInput,
): Promise<boolean> {
  const { client, actorId, groupId } = input;
  const rows = await client.membership.query();
  if (rows.some((row) => row.actor_id === actorId && row.group_id === groupId) === false) {
    return false;
  }
  await client.actions.shareProfile({ profileId: profileIdForActor(actorId), groupId });
  return true;
}

export interface LeaveWorkspaceInput {
  /** The leaving actor's own client; only its own rows may be dropped. */
  readonly client: IssueTrackerClient;
  readonly actorId: string;
  readonly groupId: string;
}

/**
 * Drop the actor's `groupMember` row and their profile's membership in
 * `groupId` as one Action.
 */
export async function leaveWorkspace(input: LeaveWorkspaceInput): Promise<boolean> {
  const { client, actorId, groupId } = input;
  const members = await client.membership.query();
  const member = members.find(
    (candidate) => candidate.actor_id === actorId && candidate.group_id === groupId,
  );
  if (member === undefined) return false;
  await client.actions.leaveWorkspace({
    profileId: profileIdForActor(actorId),
    groupId,
    memberId: member.id,
  });
  return true;
}
