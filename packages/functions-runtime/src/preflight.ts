/**
 * The membership pre-flight: the refusals the client planner makes before an
 * Action reaches the outbox, checked against the invocation's overlay instead
 * of a materialized cache.
 *
 * The point is the same as on the client — a `missing_ownership`,
 * `last_membership`, or `last_group_member` refusal surfaces at the offending
 * `ctx.*` call with the same reason and details, rather than at return as a
 * 422. The check only refuses what the invocation can prove: where the local
 * view cannot see the state (a pre-existing row's memberships, a group's full
 * member roster) the check defers and the server's fail-whole mapping is the
 * backstop.
 */

import type { Update } from "@ebbjs/core";
import {
  ActionRejectedError,
  lastGroupMemberError,
  lastGroupMemberViolation,
  lastMembershipViolation,
  membershipScope,
  type LiveGroupMember,
  type MembershipView,
} from "@ebbjs/write";

/** The overlay-backed view a pre-flight reads. */
export interface PreflightView extends MembershipView {
  /**
   * The group's member roster when this invocation can prove it is complete,
   * `undefined` when it cannot (the usual case). A group this invocation
   * created has no other members, so its roster is knowable; an existing
   * group's members are not readable through `ctx.get`.
   */
  groupMembersOf(groupId: string): readonly LiveGroupMember[] | undefined;
}

/**
 * Refuse a membership write whose Updates resolve to no owning group. Mirrors
 * `changeGroups`: a membership row always has an owner, and an Action that
 * claims one without naming it would be rejected as `missing_ownership`.
 */
export const assertMembershipScope = (
  view: PreflightView,
  entity: string,
  entityId: string,
  updates: readonly Update[],
): void => {
  if (updates.length === 0) return;
  const groups = membershipScope(updates, view);
  if (groups.length > 0) return;
  throw new ActionRejectedError([
    {
      id: entityId,
      model: entity,
      reason: "missing_ownership",
      details: `membership write for "${entityId}" resolves to no owning group`,
    },
  ]);
};

/**
 * Refuse a membership removal that would leave the entity with no owning
 * group. An entity whose groups this invocation cannot see passes: the local
 * view cannot tell "no memberships" from "not cached".
 */
export const assertLastMembership = (
  view: PreflightView,
  entity: string,
  entityId: string,
  removedGroups: readonly string[],
): void => {
  const details = lastMembershipViolation(view.groupsOf(entityId), {
    puts: [],
    removedGroups,
  });
  if (details === undefined) return;
  throw new ActionRejectedError([
    { id: entityId, model: entity, reason: "last_membership", details },
  ]);
};

/** A grant delta: the rows to remove and the permission lists to overwrite. */
export interface GroupMemberDeltaInput {
  readonly removedIds: readonly string[];
  readonly upserts: readonly { readonly id: string; readonly permissions: readonly string[] }[];
}

/**
 * Refuse a grant delta that would leave the group with no member holding a
 * permission list. Only a provable roster is checked — deferring is
 * deliberate, matching the client's cold-cache behaviour.
 */
export const assertLastGroupMember = (
  view: PreflightView,
  memberId: string,
  groupId: string,
  delta: GroupMemberDeltaInput,
): void => {
  const roster = view.groupMembersOf(groupId);
  if (roster === undefined) return;
  const details = lastGroupMemberViolation(roster, delta);
  if (details === undefined) return;
  throw lastGroupMemberError(memberId, details);
};
