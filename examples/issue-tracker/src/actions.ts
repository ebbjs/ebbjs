/**
 * Every write the issue-tracker demo performs, declared once at module
 * scope and mounted on each client `bootstrap` builds.
 *
 * An action callback is synchronous and runs before the Action is
 * submitted, so it cannot live inside a component: components call
 * `client.actions.<name>(params)`, and everything one call drafts commits
 * as one Action or not at all. A refusal from the server throws
 * `ActionRejectedError`.
 */

import { defineAction, type NamespacedClient } from "@ebbjs/client";
import { schema, type Schema } from "./schema";

/** The issue fields an edit may patch. */
export interface IssuePatch {
  readonly title?: string;
  readonly status?: string;
  readonly priority?: string;
}

/**
 * Create an issue and, when an assignee is picked, its `assignee` link in
 * the same Action, so the row is never briefly visible without its link.
 * Returns the handle so the form can select the row it just created.
 */
export const createIssue = defineAction(
  schema,
  (
    { issue },
    params: {
      readonly title: string;
      readonly status: string;
      readonly priority: string;
      /** The profile to link as assignee; `null` creates the row unassigned. */
      readonly assigneeId: string | null;
      readonly groupId: string;
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
  ({ issue }, params: { readonly id: string; readonly patch: IssuePatch }) => {
    issue.update(params.id, params.patch);
  },
);

/** Point the issue's `assignee` at a profile, or clear it with `null`. */
export const setIssueAssignee = defineAction(
  schema,
  ({ issue }, params: { readonly id: string; readonly assigneeId: string | null }) => {
    if (params.assigneeId === null) {
      issue.unlink(params.id, "assignee");
      return;
    }
    issue.link(params.id, "assignee", params.assigneeId);
  },
);

/** Soft-delete the issue: the row's tombstone drops out of every query. */
export const deleteIssue = defineAction(schema, ({ issue }, params: { readonly id: string }) => {
  issue.delete(params.id);
});

/**
 * Put the joining actor's `groupMember` row for a workspace group. Groups
 * are closed by default (#126), so the demo's service actor runs this to
 * invite; a non-member's attempt is refused by the local permission pass
 * and, if it reached the wire, by the server.
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

/**
 * File the actor's own profile into a workspace group. Only the profile's
 * owner holds the authority: the write authorizes over the profile's
 * groups, which include that actor's personal group (#623). A profile
 * already filed in the group is a no-op, which keeps a retry safe.
 */
export const shareProfile = defineAction(
  schema,
  ({ profile }, params: { readonly profileId: string; readonly groupId: string }) => {
    profile.addToGroup(params.profileId, params.groupId);
  },
);

/**
 * Leave a workspace: drop the profile's membership and the actor's
 * `groupMember` row in one Action. Both are the member's own rows, and the
 * profile write is authorized by the actor's `profile.*` permission in its
 * personal group, which survives the `groupMember` deletion.
 */
export const leaveWorkspace = defineAction(
  schema,
  (
    { profile, membership },
    params: {
      readonly profileId: string;
      readonly groupId: string;
      readonly memberId: string;
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

export type DemoActions = typeof demoActions;

/** The typed client the demo passes around: schema-bound with its Actions. */
export type DemoClient = NamespacedClient<Schema, DemoActions>;
