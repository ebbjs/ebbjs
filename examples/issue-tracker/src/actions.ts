/**
 * Every write the demo performs, declared once at module scope and mounted on
 * each client `bootstrap` builds. A callback cannot live inside a component, so
 * components call `client.actions.<name>(params)`; everything one call drafts
 * commits as one Action, and a refusal throws `ActionRejectedError`.
 */

import { defineAction, type EntityValues } from "@ebbjs/client";
import { issue, schema } from "./schema";

/**
 * Create an issue and, when an assignee is picked, its `assignee` link in the
 * same Action, so the row is never briefly visible without its link.
 */
export const createIssue = defineAction(
  schema,
  (
    { issue },
    params: {
      title: string;
      status: string;
      priority: string;
      /** The profile to link as assignee; `null` creates the row unassigned. */
      assigneeId: string | null;
      groupId: string;
    },
  ) =>
    issue.create(
      {
        title: params.title,
        status: params.status,
        priority: params.priority,
        assignee: params.assigneeId,
      },
      { groups: [params.groupId] },
    ),
);

/** Patch the issue's editable fields. Untouched fields keep their value. */
export const updateIssue = defineAction(
  schema,
  ({ issue: issues }, params: { id: string; patch: Partial<EntityValues<typeof issue>> }) => {
    issues.update(params.id, params.patch);
  },
);

/** Point the issue's `assignee` at a profile, or clear it with `null`. */
export const setIssueAssignee = defineAction(
  schema,
  ({ issue }, params: { id: string; assigneeId: string | null }) => {
    if (params.assigneeId === null) {
      issue.unlink(params.id, "assignee");
      return;
    }
    issue.link(params.id, "assignee", params.assigneeId);
  },
);

/** Soft-delete the issue: the row's tombstone drops out of every query. */
export const deleteIssue = defineAction(schema, ({ issue }, params: { id: string }) => {
  issue.delete(params.id);
});

/**
 * Put the joining actor's `groupMember` row for a workspace group. Groups are
 * closed by default (#126), so the demo's service actor runs this to invite.
 */
export const inviteMember = defineAction(
  schema,
  (
    { membership },
    params: {
      actorId: string;
      groupId: string;
      permissions: readonly string[];
    },
  ): void => {
    membership.create({
      group_id: params.groupId,
      actor_id: params.actorId,
      permissions: [...params.permissions],
    });
  },
);

/**
 * File the actor's own profile into a workspace group. Only the owner holds the
 * authority: the write authorizes over the profile's groups, which include that
 * actor's personal group (#623). Filing twice is a no-op.
 */
export const shareProfile = defineAction(
  schema,
  ({ profile }, params: { profileId: string; groupId: string }) => {
    profile.addToGroup(params.profileId, params.groupId);
  },
);

/**
 * Leave a workspace: the profile's membership and the actor's `groupMember` row
 * in one Action. Both are the member's own rows, and the profile write is
 * authorized in the personal group, which survives the `groupMember` deletion.
 */
export const leaveWorkspace = defineAction(
  schema,
  (
    { profile, membership },
    params: {
      profileId: string;
      groupId: string;
      memberId: string;
    },
  ) => {
    profile.removeFromGroup(params.profileId, params.groupId);
    membership.delete(params.memberId);
  },
);

/** The demo's write surface; mounted as `actions` on every client it builds. */
export const demoActions = {
  createIssue,
  updateIssue,
  setIssueAssignee,
  deleteIssue,
  inviteMember,
  shareProfile,
  leaveWorkspace,
} as const;
