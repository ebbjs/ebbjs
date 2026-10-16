/**
 * The membership checker: client-side resolution of a system write's
 * fan-out group set, and the two structural refusals the server
 * enforces for membership — `missing_ownership` (a write that resolves
 * to no group) and `last_membership` (a delta that would leave an
 * entity with no owning group).
 *
 * The rules mirror the server's `EntityIndex.fan_out_groups/2` and
 * `Authorizer` (#461/#264) so the client refuses, before an Action
 * reaches the outbox, what the server would reject anyway. Coherence
 * (the identical-group-set rule) is the committer's job; this module
 * supplies the scope every operation in a batch is compared by.
 */

import type { Update } from "@ebbjs/core";

/**
 * Subject types the server treats as system writes: they are exempt
 * from the identical-group-set rule because a system-only Action's
 * union is the membership operation's visibility scope (#461).
 */
export const SYSTEM_ENTITY_TYPES = ["group", "groupMember", "relationship", "entityGroup"] as const;

const SYSTEM_TYPE_SET: ReadonlySet<string> = new Set(SYSTEM_ENTITY_TYPES);

/** True for a subject type the server authorizes as a system entity. */
export const isSystemEntityType = (subjectType: string): boolean =>
  SYSTEM_TYPE_SET.has(subjectType);

/**
 * True when the Update is a system write. A batch whose Updates are all
 * system writes may span groups; one content write makes the whole
 * Action content-bearing and subject to the identical-group-set rule.
 */
export const isSystemUpdate = (update: Update): boolean => isSystemEntityType(update.subject_type);

/** True when every Update is a system write. Vacuously true for none. */
export const isSystemOnly = (updates: readonly Update[]): boolean => updates.every(isSystemUpdate);

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
