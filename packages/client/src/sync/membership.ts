/**
 * The membership checker: client-side resolution of a system write's
 * fan-out group set, and the structural refusals the server enforces
 * for membership — `missing_ownership` (a write that resolves to no
 * group), `last_membership` (a delta that would leave an entity with
 * no owning group), and `last_group_member` (a delta that would leave
 * a group with no member holding a non-empty permission list).
 *
 * The rules mirror the server's `EntityIndex.fan_out_groups/2` and
 * `Authorizer` (#461/#264) so the client refuses, before an Action
 * reaches the outbox, what the server would reject anyway. The scope
 * resolution also feeds the `groups` union the committer returns.
 */

import type { Update } from "@ebbjs/core";

/**
 * The local view the checker resolves a system write against. It is
 * the caller's read of the materialized cache, not a storage handle —
 * the operations stay pure and take the resolved values as input.
 */
export interface MembershipView {
  /** Live group ids for an entity id. */
  groupsOf(entityId: string): readonly string[];
  /** The group a live `entityGroup` row scopes to, or `undefined` when unknown. */
  groupOfMembership(membershipId: string): string | undefined;
}

/** The wire `group_id` a membership put carries, or `[]` when absent. */
const wireGroupIds = (update: Update): readonly string[] => {
  const value = update.data?.fields?.["group_id"]?.value;
  return typeof value === "string" ? [value] : [];
};

/** The wire `source_id` a relationship put carries, or `undefined`. */
const wireSourceId = (update: Update): string | undefined => {
  const value = update.data?.fields?.["source_id"]?.value;
  return typeof value === "string" ? value : undefined;
};

const sortedUnique = (groups: readonly string[]): readonly string[] => [...new Set(groups)].sort();

/**
 * Resolve one Update's fan-out group set:
 *
 * - `group` → its own id (a group is its own group);
 * - `groupMember` / `entityGroup` put → the wired `group_id`;
 * - `entityGroup` delete → the membership row's group (the wire form
 *   drops the reference, so the local view supplies it);
 * - `relationship` → the source entity's groups;
 * - a content subject → the entity's groups.
 *
 * An unresolvable scope is `[]`: the committer reports it as
 * `missing_ownership` rather than guessing.
 */
export const resolveUpdateGroups = (update: Update, view: MembershipView): readonly string[] => {
  switch (update.subject_type) {
    case "group":
      return [update.subject_id];
    case "groupMember":
      return wireGroupIds(update);
    case "entityGroup": {
      if (update.method !== "delete") return wireGroupIds(update);
      const groupId = view.groupOfMembership(update.subject_id);
      return groupId === undefined ? [] : [groupId];
    }
    case "relationship": {
      const sourceId = wireSourceId(update);
      return sourceId === undefined ? [] : view.groupsOf(sourceId);
    }
    default:
      return view.groupsOf(update.subject_id);
  }
};

/** Sorted union of the fan-out groups of every Update in a batch. */
export const membershipScope = (
  updates: readonly Update[],
  view: MembershipView,
): readonly string[] =>
  sortedUnique(updates.flatMap((update) => resolveUpdateGroups(update, view)));

/** A membership delta: the groups to add and the rows (with groups) to delete. */
export interface MembershipDelta {
  readonly puts: readonly string[];
  /** Each removed row's group, so a delete's scope is known without a read. */
  readonly removedGroups: readonly string[];
}

/**
 * The entity's resulting group set after the delta, mirroring the
 * server's net-delta rule: cached groups plus puts, minus the rows
 * removed, with a removed group cancelled when a put re-adds it.
 */
export const resultingGroups = (
  currentGroups: readonly string[],
  delta: MembershipDelta,
): readonly string[] => {
  const added = new Set(delta.puts);
  const removed = new Set(delta.removedGroups);
  const removedAndNotReadded = [...removed].filter((group) => !added.has(group));
  const surviving = new Set([...currentGroups, ...delta.puts]);
  for (const group of removedAndNotReadded) surviving.delete(group);
  return sortedUnique([...surviving]);
};

/**
 * The `last_membership` refusal for a delta that would leave the entity
 * with no owning group, or `undefined` when at least one survives.
 *
 * The check needs the entity's current groups; a caller whose local
 * view is empty cannot tell "no memberships" from "not cached", so it
 * passes `currentGroups: undefined` and defers to the server.
 */
export const lastMembershipViolation = (
  currentGroups: readonly string[] | undefined,
  delta: MembershipDelta,
): string | undefined => {
  if (currentGroups === undefined || currentGroups.length === 0) return undefined;
  const resulting = resultingGroups(currentGroups, delta);
  if (resulting.length > 0) return undefined;
  return `removing this membership would leave the entity with no owning group`;
};

/**
 * A live `groupMember` row reduced to what the lockout guard reads:
 * the row id, the group it scopes to, and its permission list. An
 * empty list grants nothing, so such a member cannot administer the
 * group.
 */
export interface LiveGroupMember {
  readonly id: string;
  readonly groupId: string;
  readonly permissions: readonly string[];
}

/** One membership row's permission list after the delta, keyed by row id. */
export interface GroupMemberUpsert {
  readonly id: string;
  readonly permissions: readonly string[];
}

/** A `groupMember` delta: the rows to remove and the permission lists to overwrite. */
export interface GroupMemberDelta {
  readonly removedIds: readonly string[];
  readonly upserts: readonly GroupMemberUpsert[];
}

/**
 * The `last_group_member` refusal for a delta that would leave a group
 * with no membership holding a non-empty permission list, or
 * `undefined` when at least one capable member survives.
 *
 * The check needs the group's current members; a caller whose local
 * view is empty cannot tell "no members" from "not cached", so it
 * passes `currentMembers: undefined` and defers to the server. An
 * upsert the local view does not know is still counted when its
 * permission list is non-empty — the caller can only add a capable
 * member, never prove a lockout.
 */
export const lastGroupMemberViolation = (
  currentMembers: readonly LiveGroupMember[] | undefined,
  delta: GroupMemberDelta,
): string | undefined => {
  if (currentMembers === undefined || currentMembers.length === 0) return undefined;
  const permissions = new Map(currentMembers.map((member) => [member.id, member.permissions]));
  for (const id of delta.removedIds) permissions.delete(id);
  for (const upsert of delta.upserts) permissions.set(upsert.id, upsert.permissions);
  const capable = [...permissions.values()].some((list) => list.length > 0);
  if (capable) return undefined;
  return `removing this membership would leave the group with no member that can administer it`;
};
