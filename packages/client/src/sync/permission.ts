/**
 * Local permission pre-check (#319) and its read-only query (#322).
 *
 * A best-effort client-side mirror of `EbbServer.Storage.Authorizer` +
 * `PermissionHelper`: every Update a client authors is checked for
 * `<type>.<verb>` before the Action reaches the Outbox, so the common
 * "you can't do that" case fails fast with no round-trip. The server
 * remains the authority; when the actor's groups are not yet known
 * (`handshake()` has not run) the whole pass is skipped and the write
 * goes to the wire.
 *
 * `can()` asks the same question as a query, so an app can decide what
 * to render *before* attempting a write. Both paths resolve a subject's
 * rule through {@link resolveRule} and decide it through
 * {@link ruleHolds}, so they cannot disagree on the rule table. The
 * write path additionally unions the Action's in-flight bootstrap grant
 * and in-flight `entityGroup` puts, which a query over committed state
 * cannot see; `can()` is correspondingly conservative and reports
 * `unknown` where it cannot resolve a subject.
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

import { readEntityMemberships, readMembership, type LiveMembership } from "./entity-group";

/** The three write verbs a permission can be granted for. */
export type PermissionVerb = "create" | "update" | "delete";

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

/** Wire method → the verb it is authorized as. */
const METHOD_VERB = {
  put: "create",
  patch: "update",
  delete: "delete",
} as const;

/** Verb → the wire method that exercises it. */
const METHOD_BY_VERB = {
  create: "put",
  update: "patch",
  delete: "delete",
} as const;

const VERBS: ReadonlySet<string> = new Set(["create", "update", "delete"]);

const isVerb = (value: string): value is PermissionVerb => VERBS.has(value);

/**
 * The single `<type>.<verb>` rule: a permission is granted by an exact
 * match or the `type.*` wildcard. Both the write-path pre-check and
 * `client.can()` decide through this.
 */
const grantsPermission = (
  permissions: readonly string[],
  type: string,
  verb: PermissionVerb,
): boolean => permissions.includes(`${type}.${verb}`) || permissions.includes(`${type}.*`);

/**
 * One subject's authorization rule, resolved: the permission the actor
 * must hold and the group set it is union-matched over.
 */
interface ResolvedRule {
  /** Permission namespace, e.g. `todo` for `todo.update`. */
  readonly type: string;
  readonly verb: PermissionVerb;
  /** The permission string the actor must hold, `${type}.${verb}`. */
  readonly required: string;
  readonly groupIds: readonly string[];
  /** Membership mutations consult cached permissions only. */
  readonly cachedOnly: boolean;
}

/**
 * Why `can()` could not decide. `no-handshake` when the actor's groups
 * have never been fetched; `entity-unknown` when the subject, or an
 * entity it references, is not in the local store; `no-owner` when the
 * subject resolves but has no local group set — the server's
 * `missing_ownership`, which the query deliberately defers rather than
 * guessing.
 */
export type CanUnknownReason = "no-handshake" | "entity-unknown" | "no-owner";

type RuleResolution =
  | { readonly kind: "rule"; readonly rule: ResolvedRule }
  | { readonly kind: "unresolved"; readonly reason: CanUnknownReason };

/**
 * The lookups the rule table needs to resolve one subject. Both the
 * write path (over a wire Update plus the Action's in-flight context)
 * and the query path (over a materialized row) supply these.
 */
interface RuleInputs {
  /** Read a field's value from the subject's data. */
  readonly fieldValue: (name: string) => unknown;
  readonly exists: (id: string) => Promise<Entity | null>;
  /** The true type of an entity id, or `null` when it is not local. */
  readonly resolveType: (id: string) => Promise<string | null>;
  /** The entity's group set (its `entityGroup` memberships). */
  readonly groupSetFor: (id: string) => Promise<readonly string[]>;
  readonly readMembership: (membershipId: string) => Promise<LiveMembership | null>;
}

/**
 * The storage-backed half of {@link RuleInputs}, shared by the write path
 * and the query path so a subject's `exists` / `readMembership` lookups
 * have one implementation. Callers supply `fieldValue` and override
 * `resolveType` / `groupSetFor` with their own source (the Action's
 * in-flight context, or committed storage).
 */
const storageInputs = (
  storage: StorageAdapter,
  fieldValue: (name: string) => unknown,
): Omit<RuleInputs, "resolveType" | "groupSetFor"> => ({
  fieldValue,
  exists: (id) => storage.entities.get(id),
  readMembership: (membershipId) => readMembership(storage, membershipId),
});

/** Read a wire field value; `data` is `null` on a delete. */
const fieldValue = (update: Update, name: string): unknown => update.data?.fields?.[name]?.value;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asStringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * The rule table: for a subject `(type, id, method)`, the permission it
 * requires and the groups to union-match. Returns `unresolved` when the
 * inputs the rule needs are not locally available — the write path then
 * defers to the server, and `can()` reports `unknown`.
 *
 * Rules mirror `EbbServer.Storage.PermissionHelper` and #319:
 * - user entity → `<type>.<verb>` over the entity's group set;
 * - `group` → `group.<verb>` in the group itself;
 * - `groupMember` → `groupMember.<verb>` in the membership's group;
 * - `entityGroup` put → `<entityType>.create` in the target group;
 *   delete → `<entityType>.update` in the entity's current set;
 *   patch → `entityGroup.update` in the membership's group;
 * - `relationship` put → `<sourceType>.update` over the source's set;
 *   patch/delete → `relationship.<verb>` over the source's set.
 */
async function resolveRule(
  subjectType: string,
  subjectId: string,
  method: Update["method"],
  inputs: RuleInputs,
): Promise<RuleResolution> {
  const verb = METHOD_VERB[method];
  const rule = (r: ResolvedRule): RuleResolution => ({ kind: "rule", rule: r });

  switch (subjectType) {
    case "group": {
      return rule({
        type: "group",
        verb,
        required: `group.${verb}`,
        groupIds: [subjectId],
        cachedOnly: false,
      });
    }

    case "groupMember": {
      const groupIds = await resolveMembershipGroupIds(subjectId, inputs);
      if (groupIds.length === 0) return { kind: "unresolved", reason: "entity-unknown" };
      return rule({
        type: "groupMember",
        verb,
        required: `groupMember.${verb}`,
        groupIds,
        cachedOnly: false,
      });
    }

    case "entityGroup": {
      if (method === "put") {
        const groupId = asString(inputs.fieldValue("group_id"));
        const entityId = asString(inputs.fieldValue("entity_id"));
        if (groupId === null || entityId === null) {
          return { kind: "unresolved", reason: "entity-unknown" };
        }
        const type = await inputs.resolveType(entityId);
        if (type === null) return { kind: "unresolved", reason: "entity-unknown" };
        return rule({
          type,
          verb: "create",
          required: `${type}.create`,
          groupIds: [groupId],
          cachedOnly: true,
        });
      }
      if (method === "delete") {
        const membership = await inputs.readMembership(subjectId);
        if (membership === null) return { kind: "unresolved", reason: "entity-unknown" };
        const type = await inputs.resolveType(membership.entityId);
        if (type === null) return { kind: "unresolved", reason: "entity-unknown" };
        const groupIds = await inputs.groupSetFor(membership.entityId);
        return rule({
          type,
          verb: "update",
          required: `${type}.update`,
          groupIds,
          cachedOnly: true,
        });
      }
      // patch — the membership's own group, cached permissions only.
      const membership = await inputs.readMembership(subjectId);
      const groupId = asString(inputs.fieldValue("group_id")) ?? membership?.groupId ?? null;
      if (groupId === null) return { kind: "unresolved", reason: "entity-unknown" };
      return rule({
        type: "entityGroup",
        verb: "update",
        required: "entityGroup.update",
        groupIds: [groupId],
        cachedOnly: true,
      });
    }

    case "relationship": {
      if (method === "put") {
        const sourceId = asString(inputs.fieldValue("source_id"));
        if (sourceId === null) return { kind: "unresolved", reason: "entity-unknown" };
        // The permission type follows the source entity's true type,
        // never the wire `type` label, which is forgeable (#323).
        const type = await inputs.resolveType(sourceId);
        if (type === null) return { kind: "unresolved", reason: "entity-unknown" };
        const groupIds = await inputs.groupSetFor(sourceId);
        if (groupIds.length === 0) return { kind: "unresolved", reason: "no-owner" };
        return rule({
          type,
          verb: "update",
          required: `${type}.update`,
          groupIds,
          cachedOnly: false,
        });
      }
      // The wire `source_id` is authoritative when present (a patch can
      // re-point the edge); only fall back to the local row.
      const wireSourceId = asString(inputs.fieldValue("source_id"));
      const row = wireSourceId === null ? await inputs.exists(subjectId) : null;
      const sourceId =
        wireSourceId ??
        (row?.type === "relationship" ? asString(row.data?.fields?.["source_id"]?.value) : null);
      if (sourceId === null) return { kind: "unresolved", reason: "entity-unknown" };
      const groupIds = await inputs.groupSetFor(sourceId);
      if (groupIds.length === 0) return { kind: "unresolved", reason: "no-owner" };
      return rule({
        type: "relationship",
        verb,
        required: `relationship.${verb}`,
        groupIds,
        cachedOnly: false,
      });
    }

    default: {
      const groupIds = await inputs.groupSetFor(subjectId);
      // No owners is the server's `missing_ownership`, not ours.
      if (groupIds.length === 0) return { kind: "unresolved", reason: "no-owner" };
      return rule({
        type: subjectType,
        verb,
        required: `${subjectType}.${verb}`,
        groupIds,
        cachedOnly: false,
      });
    }
  }
}

/** Shared empty bootstrap map for the query path, which has no Action in flight. */
const NO_BOOTSTRAP: ReadonlyMap<string, readonly string[]> = new Map();

/**
 * The one place the server's `cached_permissions` rule is stated: a
 * membership mutation (`cachedOnly`) never unions the bootstrap grant,
 * every other subject may. `bootstrap` is empty on the query path.
 */
const buildPermissionsFor =
  (
    cached: Map<string, readonly string[]>,
    bootstrap: ReadonlyMap<string, readonly string[]>,
  ): ((groupId: string, cachedOnly: boolean) => readonly string[] | null) =>
  (groupId, cachedOnly) => {
    const cachedPermissions = cached.get(groupId) ?? null;
    const declared = cachedOnly ? null : (bootstrap.get(groupId) ?? null);
    if (cachedPermissions === null && declared === null) return null;
    return [...new Set([...(cachedPermissions ?? []), ...(declared ?? [])])];
  };

/**
 * Whether a resolved rule is held by the actor. `permissionsFor` returns
 * the permissions cached for a group (plus any bootstrap grant the write
 * path allows), or `null` when the group is unknown.
 */
const ruleHolds = (
  rule: ResolvedRule,
  permissionsFor: (groupId: string, cachedOnly: boolean) => readonly string[] | null,
): boolean =>
  rule.groupIds.some((groupId) => {
    const permissions = permissionsFor(groupId, rule.cachedOnly);
    return permissions !== null && grantsPermission(permissions, rule.type, rule.verb);
  });

/**
 * Resolve the group a system entity (e.g. `groupMember`) belongs to: the
 * wire `group_id` when present, else the locally-materialized row's own
 * field.
 */
const resolveMembershipGroupIds = async (
  subjectId: string,
  inputs: RuleInputs,
): Promise<readonly string[]> => {
  const wire = asString(inputs.fieldValue("group_id"));
  if (wire !== null) return [wire];
  const row = await inputs.exists(subjectId);
  const groupId = asString(row?.data?.fields?.["group_id"]?.value);
  return groupId === null ? [] : [groupId];
};

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
  await mergeLocalMemberships(cached, ctx);

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

  const permissionsFor = buildPermissionsFor(cached, bootstrap);

  const isBootstrapExempt = (update: Update): boolean => {
    // `bootstrap` only holds groups the Action also puts the actor's
    // own membership into, matching the server's exemption exactly.
    if (update.subject_type === "group" && update.method === "put") {
      return bootstrap.has(update.subject_id);
    }
    if (update.subject_type === "groupMember" && update.method === "put") {
      const groupId = asString(fieldValue(update, "group_id"));
      return (
        fieldValue(update, "actor_id") === ctx.actorId && groupId !== null && bootstrap.has(groupId)
      );
    }
    if (update.subject_type === "entityGroup" && update.method === "put") {
      const groupId = asString(fieldValue(update, "group_id"));
      const entityId = asString(fieldValue(update, "entity_id"));
      return (
        groupId !== null && bootstrap.has(groupId) && entityId !== null && createdIds.has(entityId)
      );
    }
    return false;
  };

  const check = async (update: Update): Promise<PermissionViolation | null> => {
    const resolution = await resolveRule(update.subject_type, update.subject_id, update.method, {
      ...storageInputs(ctx.storage, (name) => fieldValue(update, name)),
      resolveType,
      groupSetFor,
    });
    if (resolution.kind === "unresolved") return null;
    return ruleHolds(resolution.rule, permissionsFor)
      ? null
      : {
          subjectType: update.subject_type,
          subjectId: update.subject_id,
          required: resolution.rule.required,
          groupIds: resolution.rule.groupIds,
        };
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
 * Merge the actor's own locally-materialized `groupMember` rows into
 * the handshake's permission map. The handshake is a snapshot: after a
 * bootstrap the client's membership row is applied locally before the
 * next handshake, so without this the pass would falsely refuse a
 * write into the group it just created. Best-effort — the server stays
 * the authority.
 */
const mergeLocalMemberships = async (
  cached: Map<string, readonly string[]>,
  ctx: PermissionContext,
): Promise<void> => {
  const rows = await ctx.storage.entities.query("groupMember");
  for (const row of rows) {
    if (row.deleted_hlc !== null) continue;
    if (row.data?.fields?.["actor_id"]?.value !== ctx.actorId) continue;
    const groupId = asString(row.data?.fields?.["group_id"]?.value);
    if (groupId === null) continue;
    const permissions = asStringArray(row.data?.fields?.["permissions"]?.value);
    cached.set(groupId, [...new Set([...(cached.get(groupId) ?? []), ...permissions])]);
  }
};

// ---------------------------------------------------------------------------
// Read-only query (#322)
// ---------------------------------------------------------------------------

/** The subject of a per-entity {@link PermissionQuery}: an id or anything carrying one. */
export type CanSubject = string | { readonly id: string };

/**
 * The answer to a {@link PermissionQuery}. A discriminated union:
 * `allowed` / `denied` are decisions, `unknown` means the local view is
 * insufficient to decide (no handshake, an unresolvable entity, or an
 * entity with no local owner) and the server remains the authority.
 * `unknown` is deliberately not folded into `denied` — over-hiding UI
 * the server would allow is as wrong as over-promising.
 */
export type CanResult =
  | { readonly kind: "allowed"; readonly groupIds: readonly string[] }
  | { readonly kind: "denied"; readonly violation: PermissionViolation }
  | { readonly kind: "unknown"; readonly reason: CanUnknownReason };

export interface CanContext extends PermissionContext {
  /** True once `handshake()` has completed successfully at least once. */
  readonly handshaken: boolean;
}

/** The `client.can(...)` surface. */
export interface PermissionQuery {
  /** Does the actor hold `<type>.<verb>` in any of its groups? */
  can(permission: string): Promise<CanResult>;
  /** Does the actor hold `<verb>` for the entity `subject` names? */
  can(subject: CanSubject, verb: PermissionVerb): Promise<CanResult>;
}

/**
 * The global form: does the actor hold `<type>.<verb>` anywhere? Consulted
 * groups are the handshake's actor groups plus the actor's local
 * `groupMember` rows. Mirrors the write path: with no handshake the actor's
 * groups are unknown, so the answer is `unknown` rather than `denied`.
 */
export async function queryActorPermission(
  permission: string,
  ctx: CanContext,
): Promise<CanResult> {
  const { type, verb } = parsePermission(permission);
  if (!ctx.handshaken) {
    return { kind: "unknown", reason: "no-handshake" };
  }
  const cached = new Map(ctx.actorGroups.map((g) => [g.id, g.permissions]));
  await mergeLocalMemberships(cached, ctx);
  const groupIds = [...cached.keys()];
  if (groupIds.some((id) => grantsPermission(cached.get(id) ?? [], type, verb))) {
    return { kind: "allowed", groupIds };
  }
  return {
    kind: "denied",
    // The global form has no single subject; `"*"` marks "the actor".
    violation: { subjectType: type, subjectId: "*", required: `${type}.${verb}`, groupIds },
  };
}

/**
 * The per-entity form: resolve the entity's type and group set and apply
 * the same rule table the write path uses. `unknown` covers an id the
 * local store cannot resolve and an entity with no local owner.
 */
export async function queryEntityPermission(
  subject: CanSubject,
  verb: PermissionVerb,
  ctx: CanContext,
): Promise<CanResult> {
  if (!ctx.handshaken) {
    return { kind: "unknown", reason: "no-handshake" };
  }
  const id = typeof subject === "string" ? subject : subject.id;
  const row = await ctx.storage.entities.get(id);
  if (row === null) {
    return { kind: "unknown", reason: "entity-unknown" };
  }

  const cached = new Map(ctx.actorGroups.map((g) => [g.id, g.permissions]));
  await mergeLocalMemberships(cached, ctx);
  // No Action is in flight, so there is no bootstrap grant to union.
  const permissionsFor = buildPermissionsFor(cached, NO_BOOTSTRAP);

  const inputs = storageInputs(ctx.storage, (name) => row.data?.fields?.[name]?.value);
  const resolution = await resolveRule(row.type, id, METHOD_BY_VERB[verb], {
    ...inputs,
    resolveType: async (entityId) => (await inputs.exists(entityId))?.type ?? null,
    groupSetFor: async (entityId) =>
      (await readEntityMemberships(ctx.storage, entityId)).map((m) => m.groupId),
  });
  if (resolution.kind === "unresolved") {
    return { kind: "unknown", reason: resolution.reason };
  }
  const { rule } = resolution;
  if (ruleHolds(rule, permissionsFor)) {
    return { kind: "allowed", groupIds: rule.groupIds };
  }
  return {
    kind: "denied",
    violation: {
      subjectType: row.type,
      subjectId: id,
      required: rule.required,
      groupIds: rule.groupIds,
    },
  };
}

/**
 * Parse a `"<type>.<verb>"` permission string into the rule's two parts.
 * The verb is split on the last dot so a dotted type survives. Throws a
 * `TypeError` on a malformed string — this is a programming error, not a
 * permission outcome.
 */
const parsePermission = (permission: string): { type: string; verb: PermissionVerb } => {
  const dot = permission.lastIndexOf(".");
  const type = dot > 0 ? permission.slice(0, dot) : "";
  const verb = dot > 0 ? permission.slice(dot + 1) : "";
  if (type.length === 0 || !isVerb(verb)) {
    throw new TypeError(
      `can(): expected "<type>.<verb>" with verb one of create/update/delete, got "${permission}"`,
    );
  }
  return { type, verb };
};
