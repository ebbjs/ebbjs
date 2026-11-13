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

import {
  carriesComponent,
  ebbComponent,
  ebbComponentKind,
  isFieldMap,
  systemValue,
  systemValueString,
  type EbbComponentKind,
  type Entity,
  type FieldValue,
  type Update,
} from "@ebbjs/core";

/**
 * The local view the checker resolves a system write against. It is
 * the caller's read of the materialized cache, not a storage handle —
 * the operations stay pure and take the resolved values as input.
 */
export interface MembershipView {
  /** Live group ids for an entity id. */
  groupsOf(entityId: string): readonly string[];
  /** The group a live membership row scopes to, or `undefined` when unknown. */
  groupOfMembership(membershipId: string): string | undefined;
}

/**
 * One platform component's atomic value from a batch's folded components, or
 * `null` when the batch does not carry that kind.
 */
const platformValue = (
  components: ReadonlyMap<string, FieldValue>,
  kind: EbbComponentKind,
): Readonly<Record<string, unknown>> | null => {
  const field = components.get(ebbComponent(kind));
  if (field === undefined || isFieldMap(field)) return null;
  const value = field.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
};

/** One subject's writes in a batch, folded to the components it carries. */
export interface SubjectWrites {
  /**
   * The platform kind the batch's components name, or `null` for a row whose
   * writes carry only user components. Derived from the component, never read
   * as the row's committed model.
   */
  kind: EbbComponentKind | null;
  readonly components: Map<string, FieldValue>;
  deleted: boolean;
}

/** Fold a batch's Updates into one entry per subject. */
const foldSubjects = (updates: readonly Update[]): Map<string, SubjectWrites> => {
  const subjects = new Map<string, SubjectWrites>();
  for (const update of updates) {
    const entry: SubjectWrites = subjects.get(update.subject_id) ?? {
      kind: null,
      components: new Map(),
      deleted: false,
    };
    if (update.method === "delete") {
      entry.deleted = true;
    } else {
      entry.kind = ebbComponentKind(update.component) ?? entry.kind;
      if (update.method !== "drop") entry.components.set(update.component, update.data);
    }
    subjects.set(update.subject_id, entry);
  }
  return subjects;
};

const sortedUnique = (groups: readonly string[]): readonly string[] => [...new Set(groups)].sort();

/**
 * The `ebb/membership` row id for an `(entity, group)` pair.
 *
 * One row per pair (#623): two devices that share the same entity into the
 * same group before syncing must converge on one row, or an unshare
 * deletes the row one device can see and silently leaves the entity shared.
 * The id is derived rather than random so a re-share is idempotent.
 *
 * The encoding is length-prefixed, not `eg_<entity>_<group>`: ids are
 * opaque client-chosen strings, so the readable form maps
 * `("a_b", "c")` and `("a", "b_c")` to the same row. The row id was never
 * a capability — deletes are authorized over the entity's groups and row
 * identity is pinned — so a predictable id changes no authorization.
 */
export const entityGroupId = (entityId: string, groupId: string): string =>
  `eg_${entityId.length}_${entityId}${groupId}`;

/**
 * Resolve one subject's fan-out group set from the platform component its
 * batch carries:
 *
 * - `ebb/group` → its own id (a group is its own group);
 * - `ebb/grant` / `ebb/membership` → the value's `group_id`;
 * - `ebb/link` → the source entity's groups;
 * - a delete → the membership row's group when the local view knows one, else
 *   the subject's own group set (a content row);
 * - anything else → the entity's groups.
 *
 * An unresolvable scope is `[]`: the committer reports it as
 * `missing_ownership` rather than guessing.
 */
export const resolveSubjectGroups = (
  subjectId: string,
  writes: SubjectWrites,
  view: MembershipView,
): readonly string[] => {
  switch (writes.kind) {
    case "group":
      return [subjectId];
    case "grant":
    case "membership": {
      const groupId = platformValue(writes.components, writes.kind)?.["group_id"];
      return typeof groupId === "string" ? [groupId] : [];
    }
    case "link": {
      const sourceId = platformValue(writes.components, "link")?.["source_id"];
      return typeof sourceId === "string" ? view.groupsOf(sourceId) : [];
    }
    default:
      break;
  }
  if (writes.deleted) {
    const groupId = view.groupOfMembership(subjectId);
    return groupId === undefined ? view.groupsOf(subjectId) : [groupId];
  }
  return view.groupsOf(subjectId);
};

/** Sorted union of the fan-out groups of every subject a batch writes. */
export const membershipScope = (
  updates: readonly Update[],
  view: MembershipView,
): readonly string[] =>
  sortedUnique(
    [...foldSubjects(updates)].flatMap(([subjectId, writes]) =>
      resolveSubjectGroups(subjectId, writes, view),
    ),
  );

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
 * A live grant row reduced to what the lockout guard reads:
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

/** A grant delta: the rows to remove and the permission lists to overwrite. */
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

/**
 * Reduce one live grant row to the guard's inputs. A tombstoned or malformed
 * row (missing / non-array permission list) is `null`, so the caller defers
 * rather than reading it as "no permissions".
 */
export const liveGroupMember = (row: Entity): LiveGroupMember | null => {
  if (row.deleted_hlc !== null) return null;
  const groupId = systemValueString(row, "grant", "group_id");
  const permissions = systemValue(row, "grant")?.["permissions"];
  if (groupId === null || !isStringArray(permissions)) return null;
  return { id: row.id, groupId, permissions };
};

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** The live grant rows of one group, ready for the guard. */
export const groupMembersOf = (
  rows: readonly Entity[],
  groupId: string,
): readonly LiveGroupMember[] =>
  rows.flatMap((row) => {
    const member = liveGroupMember(row);
    return member === null || member.groupId !== groupId ? [] : [member];
  });

/**
 * The local reads the `last_group_member` guard consults. The committer
 * passes the storage-backed view; the draft planner passes the client's
 * capability, so both write surfaces refuse identically.
 */
export interface GroupMemberView {
  row(id: string): Promise<Entity | null>;
  groupMembers(groupId: string): Promise<readonly LiveGroupMember[]>;
}

/**
 * The `last_group_member` refusal for a grant delta, read from the local view.
 * `undefined` when the target row is absent, not a grant, tombstoned, or
 * malformed, or when the group's local member view is empty — the caller then
 * defers to the server's authoritative check.
 */
export const lastGroupMemberRefusal = async (
  view: GroupMemberView,
  id: string,
  delta: GroupMemberDelta,
): Promise<string | undefined> => {
  const row = await view.row(id);
  if (row === null || !carriesComponent(row, "grant") || row.deleted_hlc !== null) return undefined;
  const groupId = systemValueString(row, "grant", "group_id");
  if (groupId === null) return undefined;
  return lastGroupMemberViolation(await view.groupMembers(groupId), delta);
};
