/**
 * Workspace membership for the issue-tracker demo.
 *
 * A workspace is a Group; an actor joins it through a `groupMember` row,
 * and the actor's group-scoped `profile` is made visible to the workspace
 * by an `entityGroup` row. The two stores are independent, so
 * `addToWorkspace` writes both in one Action — a partially-joined actor
 * (a member whose profile the workspace cannot see, or vice versa) is
 * impossible.
 *
 * **Joining is an invite.** Groups are closed by default (#126): only an
 * existing member can put another actor's `groupMember` row. The demo
 * uses the shared workspace's service actor (`demo-seeder`) as the
 * inviter. Leaving, by contrast, is self-service: the invite grants the
 * new member the permissions to drop its own rows again.
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
 * The `addToWorkspace` Action: put the joining actor's `groupMember` row
 * for the workspace group and file the actor's `profile` into it, in one
 * wire-level Action through `defineAction` / `client.atomic`.
 *
 * Run by a member of the target group (the demo's `demo-seeder`); a
 * non-member's attempt is refused by the local permission pass and, if it
 * reached the wire, by the server.
 */
export const addToWorkspace = defineAction(
  schema,
  (
    { membership, profile: profileDraft },
    params: {
      readonly actorId: string;
      readonly profileId: string;
      readonly groupId: string;
      readonly permissions: readonly string[];
    },
  ): void => {
    membership.create({
      group_id: params.groupId,
      actor_id: params.actorId,
      permissions: [...params.permissions],
    });
    profileDraft.addToGroup(params.profileId, params.groupId);
  },
);

export const workspaceActions = { addToWorkspace } as const;

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
  await inviter.actions.addToWorkspace({
    actorId,
    profileId: profileIdForActor(actorId),
    groupId,
    permissions,
  });
  return true;
}

export interface LeaveWorkspaceInput {
  /** The leaving actor's own client; only the two system namespaces it writes. */
  readonly client: MembershipWriter;
  readonly actorId: string;
  readonly groupId: string;
}

/** The namespaces a leave writes through: the actor's `profile` and `groupMember` rows. */
export interface MembershipWriter {
  readonly profile: NamespacedClient<Schema>["profile"];
  readonly membership: NamespacedClient<Schema>["membership"];
}

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
