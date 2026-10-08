/**
 * Local permission pre-check (#319). A best-effort client-side mirror
 * of `EbbServer.Storage.Authorizer` + `PermissionHelper`: every Update
 * a client authors is checked for `<type>.<verb>` before the Action
 * reaches the Outbox, so the common "you can't do that" case fails
 * fast with no round-trip. The server remains the authority; when the
 * actor's groups are not yet known (`handshake()` has not run) the
 * whole pass is skipped and the write goes to the wire.
 *
 * A permission is held in a group when that group's permission list
 * contains `"<type>.<verb>"` or `"<type>.*"`. User entities and
 * domain edges use union semantics over the entity's group set (any
 * group may grant it); membership mutations of an existing entity
 * consult cached permissions only, never the Action's declared
 * bootstrap grant.
 */

import type { Action, Entity, Update } from "@ebbjs/core";
import type { StorageAdapter } from "@ebbjs/storage/types";

import { readEntityMemberships, readMembership } from "./entity-group";

/** One Update the local pass refused, and why. */
export interface PermissionViolation {
  readonly subjectType: string;
  readonly subjectId: string;
  /** The permission the actor lacked, e.g. `"todo.create"`. */
  readonly required: string;
  /** The groups that were consulted; empty when none resolved. */
  readonly groupIds: readonly string[];
}

/**
 * Aggregated refusal of a locally-authored batch. Mirrors
 * `EntityValidationError` / `AtomicActionError`: a named `Error`
 * subclass with structured readonly reasons and a message formatted
 * from them. Thrown by `client.write()` before anything is enqueued.
 */
export class PermissionError extends Error {
  readonly violations: readonly PermissionViolation[];

  constructor(violations: readonly PermissionViolation[]) {
    super(formatViolations(violations));
    this.name = "PermissionError";
    this.violations = violations;
  }
}

const formatViolations = (violations: readonly PermissionViolation[]): string => {
  if (violations.length === 0) return "PermissionError";
  const lines = violations.map((v) => `  - ${describeViolation(v)}`);
  return `PermissionError: ${violations.length} permission violation(s)\n${lines.join("\n")}`;
};

const describeViolation = (violation: PermissionViolation): string => {
  const groups = violation.groupIds.length === 0 ? "no group" : violation.groupIds.join(", ");
  return `${violation.subjectType} ${violation.subjectId}: missing "${violation.required}" (checked: ${groups})`;
};

/** The actor's cached groups plus the storage the group set is read from. */
export interface PermissionContext {
  readonly actorId: string;
  readonly actorGroups: readonly { id: string; permissions: readonly string[] }[];
  readonly storage: StorageAdapter;
}

/** Subject types that carry their own authorization rules. */
const SYSTEM_TYPES = new Set(["group", "groupMember", "relationship", "entityGroup"]);

const VERB_BY_METHOD = {
  put: "create",
  patch: "update",
  delete: "delete",
} as const;

type Verb = (typeof VERB_BY_METHOD)[keyof typeof VERB_BY_METHOD];

const verbFor = (update: Update): Verb => VERB_BY_METHOD[update.method];

/** Read a wire field value; `data` is `null` on a delete. */
const fieldValue = (update: Update, name: string): unknown => update.data?.fields?.[name]?.value;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asStringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const holdsPermission = (permissions: readonly string[], type: string, verb: Verb): boolean =>
  permissions.includes(`${type}.${verb}`) || permissions.includes(`${type}.*`);

/**
 * Aggregate the permission violations for every Action in a batch.
 * Returns `[]` when the actor's groups are unknown — the pass is
 * best-effort and the server is the authority.
 */
export async function collectPermissionViolations(
  actions: readonly Action[],
  ctx: PermissionContext,
): Promise<readonly PermissionViolation[]> {
  if (ctx.actorGroups.length === 0) return [];

  const violations: PermissionViolation[] = [];
  for (const action of actions) {
    violations.push(...(await collectActionViolations(action, ctx)));
  }
  return violations;
}

const collectActionViolations = async (
  action: Action,
  ctx: PermissionContext,
): Promise<readonly PermissionViolation[]> => {
  const updates = action.updates;
  const cached = new Map(ctx.actorGroups.map((g) => [g.id, g.permissions]));

  const exists = async (id: string): Promise<Entity | null> => ctx.storage.entities.get(id);

  // A group put for an id that does not already resolve to a `group`
  // entity is a bootstrap; the actor's own membership in it is not yet
  // cached, so the Action's declared grant stands in.
  const newGroupIds = new Set<string>();
  for (const update of updates) {
    if (update.subject_type !== "group" || update.method !== "put") continue;
    const existing = await exists(update.subject_id);
    if (existing === null || existing.type !== "group") newGroupIds.add(update.subject_id);
  }

  const bootstrap = new Map<string, readonly string[]>();
  for (const update of updates) {
    if (update.subject_type !== "groupMember" || update.method !== "put") continue;
    if (fieldValue(update, "actor_id") !== ctx.actorId) continue;
    const groupId = asString(fieldValue(update, "group_id"));
    if (groupId === null || !newGroupIds.has(groupId)) continue;
    bootstrap.set(groupId, asStringArray(fieldValue(update, "permissions")));
  }

  // Types of the user entities the Action puts; the `entityGroup` wire
  // form carries only `entity_id`, so the type is recovered here.
  const createdTypes = new Map<string, string>();
  for (const update of updates) {
    if (SYSTEM_TYPES.has(update.subject_type) || update.method !== "put") continue;
    createdTypes.set(update.subject_id, update.subject_type);
  }

  // Existence is per id: a tombstoned row still counts as created-away.
  const createdIds = new Set<string>();
  for (const id of createdTypes.keys()) {
    if ((await exists(id)) === null) createdIds.add(id);
  }

  const resolveType = async (entityId: string): Promise<string | null> => {
    const existing = await exists(entityId);
    if (existing !== null) return existing.type;
    return createdTypes.get(entityId) ?? null;
  };

  // The entity's group set: its local membership rows plus the
  // `entityGroup` puts riding along in the same Action.
  const groupSetFor = async (entityId: string): Promise<readonly string[]> => {
    const memberships = await readEntityMemberships(ctx.storage, entityId);
    const groupIds = new Set(memberships.map((m) => m.groupId));
    for (const update of updates) {
      if (update.subject_type !== "entityGroup" || update.method !== "put") continue;
      if (fieldValue(update, "entity_id") !== entityId) continue;
      const groupId = asString(fieldValue(update, "group_id"));
      if (groupId !== null) groupIds.add(groupId);
    }
    return [...groupIds];
  };

  // `cachedOnly` selects the server's `cached_permissions`: membership
  // mutations of an existing entity never union the bootstrap grant.
  const permissionsFor = (groupId: string, cachedOnly: boolean): readonly string[] | null => {
    const cachedPermissions = cached.get(groupId) ?? null;
    const declared = cachedOnly ? null : (bootstrap.get(groupId) ?? null);
    if (cachedPermissions === null && declared === null) return null;
    return [...new Set([...(cachedPermissions ?? []), ...(declared ?? [])])];
  };

  const hasAny = (
    groupIds: readonly string[],
    type: string,
    verb: Verb,
    cachedOnly: boolean,
  ): boolean =>
    groupIds.some((groupId) => {
      const permissions = permissionsFor(groupId, cachedOnly);
      return permissions !== null && holdsPermission(permissions, type, verb);
    });

  const isBootstrapExempt = (update: Update): boolean => {
    if (update.subject_type === "group" && update.method === "put") {
      return newGroupIds.has(update.subject_id);
    }
    if (update.subject_type === "groupMember" && update.method === "put") {
      const groupId = asString(fieldValue(update, "group_id"));
      return (
        fieldValue(update, "actor_id") === ctx.actorId &&
        groupId !== null &&
        newGroupIds.has(groupId)
      );
    }
    if (update.subject_type === "entityGroup" && update.method === "put") {
      const groupId = asString(fieldValue(update, "group_id"));
      const entityId = asString(fieldValue(update, "entity_id"));
      return (
        groupId !== null &&
        newGroupIds.has(groupId) &&
        entityId !== null &&
        createdIds.has(entityId)
      );
    }
    return false;
  };

  const check = async (update: Update): Promise<PermissionViolation | null> => {
    const verb = verbFor(update);
    const violation = (required: string, groupIds: readonly string[]): PermissionViolation => ({
      subjectType: update.subject_type,
      subjectId: update.subject_id,
      required,
      groupIds,
    });

    switch (update.subject_type) {
      case "group": {
        const groupIds = [update.subject_id];
        const required = `group.${verb}`;
        return hasAny(groupIds, "group", verb, false) ? null : violation(required, groupIds);
      }

      case "groupMember": {
        const groupIds = await resolveSystemEntityGroupIds(update, ctx);
        // The by-id row is not cached locally; let the server resolve it.
        if (groupIds.length === 0) return null;
        const required = `groupMember.${verb}`;
        return hasAny(groupIds, "groupMember", verb, false) ? null : violation(required, groupIds);
      }

      case "entityGroup": {
        if (update.method === "put") {
          const groupId = asString(fieldValue(update, "group_id"));
          const entityId = asString(fieldValue(update, "entity_id"));
          if (groupId === null || entityId === null) return null;
          const type = await resolveType(entityId);
          if (type === null) return null;
          const required = `${type}.create`;
          return hasAny([groupId], type, "create", true) ? null : violation(required, [groupId]);
        }
        if (update.method === "delete") {
          const membership = await readMembership(ctx.storage, update.subject_id);
          if (membership === null) return null;
          const type = await resolveType(membership.entityId);
          if (type === null) return null;
          const groupIds = await groupSetFor(membership.entityId);
          const required = `${type}.update`;
          return hasAny(groupIds, type, "update", true) ? null : violation(required, groupIds);
        }
        // patch — the membership's own group, cached permissions only.
        const membership = await readMembership(ctx.storage, update.subject_id);
        const groupId = asString(fieldValue(update, "group_id")) ?? membership?.groupId ?? null;
        if (groupId === null) return null;
        return hasAny([groupId], "entityGroup", "update", true)
          ? null
          : violation("entityGroup.update", [groupId]);
      }

      case "relationship": {
        if (update.method === "put") {
          const type = asString(fieldValue(update, "type"));
          const sourceId = asString(fieldValue(update, "source_id"));
          if (type === null || sourceId === null) return null;
          const groupIds = await groupSetFor(sourceId);
          // The source has no locally-known ownership; the server decides.
          if (groupIds.length === 0) return null;
          const required = `${type}.update`;
          return hasAny(groupIds, type, "update", false) ? null : violation(required, groupIds);
        }
        const row = await exists(update.subject_id);
        const sourceId =
          row?.type === "relationship" ? asString(row.data?.fields?.["source_id"]?.value) : null;
        if (sourceId === null) return null;
        const groupIds = await groupSetFor(sourceId);
        if (groupIds.length === 0) return null;
        const required = `relationship.${verb}`;
        return hasAny(groupIds, "relationship", verb, false) ? null : violation(required, groupIds);
      }

      default: {
        const groupIds = await groupSetFor(update.subject_id);
        // No owners is the server's `missing_ownership`, not ours.
        if (groupIds.length === 0) return null;
        const required = `${update.subject_type}.${verb}`;
        return hasAny(groupIds, update.subject_type, verb, false)
          ? null
          : violation(required, groupIds);
      }
    }
  };

  const violations: PermissionViolation[] = [];
  for (const update of updates) {
    if (isBootstrapExempt(update)) continue;
    const violation = await check(update);
    if (violation !== null) violations.push(violation);
  }
  return violations;
};

/**
 * Resolve the group a system entity (e.g. `groupMember`) belongs to:
 * the wire `group_id` when present, else the locally-materialized
 * row's own field.
 */
const resolveSystemEntityGroupIds = async (
  update: Update,
  ctx: PermissionContext,
): Promise<readonly string[]> => {
  const wire = asString(fieldValue(update, "group_id"));
  if (wire !== null) return [wire];
  const row = await ctx.storage.entities.get(update.subject_id);
  const groupId = asString(row?.data?.fields?.["group_id"]?.value);
  return groupId === null ? [] : [groupId];
};
