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
 * {@link decideRule}, so they cannot disagree on the rule table. The
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
 *
 * For a user-entity write, the permission type is the type the id was
 * committed under, never the wire `subject_type`, which is forgeable
 * (#624). A user-entity write that declares another type is refused here
 * whatever permission the actor holds: the server refuses it
 * structurally, so no grant could make it pass. That type check covers
 * user entities only — a `relationship` or `entityGroup` write whose
 * subject id is committed as some other type passes this best-effort
 * pass and is refused by the server. A `relationship` row's source is
 * likewise its identity: a put or patch that declares another
 * `source_id` is refused here with no permission to report, mirroring
 * the server's "a relationship row cannot be re-pointed at another
 * source" (#624); moving an edge is delete + put, and a delete's wire
 * source is ignored. A delete in the same `write()` batch releases the
 * row's source binding for the Actions that follow it — as the server's
 * request simulation does — so the delete + put that moves an edge is
 * authorized here too; within one Action the release is order-independent,
 * and a refused Action releases nothing. A delete still sitting in the
 * Outbox — no echo yet — releases nothing either, so an edge moved across
 * two `write()` calls is refused locally until the delete syncs; batch the
 * delete and the re-put. The server also binds an id's first type for the
 * whole request, so an Action that relabels an id an earlier Action in the
 * same batch created is refused there but not here; Actions are otherwise
 * checked one at a time.
 */

import type { Action, Entity, Update } from "@ebbjs/core";
import type { StorageAdapter } from "@ebbjs/storage/types";

import { readEntityMemberships, readMembership, type LiveMembership } from "./entity-group";

/** The three write verbs a permission can be granted for. */
export type PermissionVerb = "create" | "update" | "delete";

/** One Update the local pass refused, and why. */
export type PermissionViolation =
  | MissingPermissionViolation
  | TypeMismatchViolation
  | SourceMismatchViolation
  | MethodUnsupportedViolation;

/**
 * The actor holds no permission that would allow the write: no group in
 * {@link groupIds} grants {@link required}.
 */
export interface MissingPermissionViolation {
  readonly kind: "missing-permission";
  readonly subjectType: string;
  readonly subjectId: string;
  /** The permission the actor lacked, e.g. `"todo.create"`. */
  readonly required: string;
  /** The groups that were consulted; empty when none resolved. */
  readonly groupIds: readonly string[];
}

/**
 * The write cannot be authorized at any permission (#624): it declared a
 * type other than the one the entity is committed under, which the
 * server refuses structurally. There is deliberately no `required` — the
 * actor may hold every grant for both types and the write still fails.
 */
export interface TypeMismatchViolation {
  readonly kind: "type-mismatch";
  /** The type the write declared, i.e. the wire `subject_type`. */
  readonly subjectType: string;
  readonly subjectId: string;
  /** The type the entity is committed under locally. */
  readonly committedType: string;
  /** The entity's group set, which the committed type is checked against. */
  readonly groupIds: readonly string[];
}

/**
 * The write cannot be authorized at any permission: a `relationship` put
 * or patch declared a source other than the one the row is committed
 * with, which the server refuses structurally (#624). A row's source is
 * its identity, so moving an edge is expressed as delete + put, never as
 * a re-point. There is deliberately no `required` — the actor may hold
 * every `relationship` grant and the write still fails.
 */
export interface SourceMismatchViolation {
  readonly kind: "source-mismatch";
  /** The type the write declared, always `"relationship"`. */
  readonly subjectType: string;
  readonly subjectId: string;
  /** The source the write declared, i.e. the wire `source_id`. */
  readonly declaredSourceId: string;
  /** The source the relationship row is committed with locally. */
  readonly committedSourceId: string;
  /** The committed source's group set. */
  readonly groupIds: readonly string[];
}

/**
 * The write cannot be authorized at any permission: the server refuses the
 * method outright, so there is no grant that would allow it (#623).
 * `entityGroup` patch is the only member — a membership row is replaced by
 * a delete plus a put, never edited in place.
 */
export interface MethodUnsupportedViolation {
  readonly kind: "method-unsupported";
  readonly subjectType: string;
  readonly subjectId: string;
  /** The method the write used, e.g. `"patch"`. */
  readonly method: string;
  /** The group whose row the write named; empty when none resolved. */
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
  return `PermissionError: ${violations.length} violation(s)\n${lines.join("\n")}`;
};

/** Compile-time exhaustiveness guard: a new variant must be handled, not guessed. */
const assertNever = (value: never): never => {
  throw new Error(`unhandled variant: ${JSON.stringify(value)}`);
};

const describeViolation = (violation: PermissionViolation): string => {
  const groups = violation.groupIds.length === 0 ? "no group" : violation.groupIds.join(", ");
  switch (violation.kind) {
    case "missing-permission":
      return `${violation.subjectType} ${violation.subjectId}: missing "${violation.required}" (checked: ${groups})`;
    case "type-mismatch":
      return (
        `${violation.subjectType} ${violation.subjectId}: declared type "${violation.subjectType}"` +
        ` but the entity is committed as "${violation.committedType}"; an entity's type cannot` +
        ` change (checked: ${groups})`
      );
    case "source-mismatch":
      return (
        `${violation.subjectType} ${violation.subjectId}: declared source` +
        ` "${violation.declaredSourceId}" but the row is committed with source` +
        ` "${violation.committedSourceId}"; a relationship row cannot be re-pointed at another` +
        ` source (checked: ${groups})`
      );
    case "method-unsupported":
      return (
        `${violation.subjectType} ${violation.subjectId}: the server does not support` +
        ` \`${violation.method}\` here; express the change as a delete plus a put` +
        ` (checked: ${groups})`
      );
    default:
      return assertNever(violation);
  }
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

/** Which piece of row identity a structural refusal is about (#624). */
type RefusalDetail =
  | {
      /** The write declared a type other than the committed one. */
      readonly reason: "type-mismatch";
      readonly committedType: string;
    }
  | {
      /** The write declared a relationship source other than the row's own. */
      readonly reason: "source-mismatch";
      readonly declaredSourceId: string;
      readonly committedSourceId: string;
    }
  | {
      /** The server refuses the method outright; no grant would allow it. */
      readonly reason: "method-unsupported";
      readonly method: string;
    };

type RuleResolution =
  | { readonly kind: "rule"; readonly rule: ResolvedRule }
  /**
   * Every rule must hold: a shared entity needs the target group's
   * `create` *and* a write permission where it already lives (#623).
   */
  | { readonly kind: "rules"; readonly rules: readonly ResolvedRule[] }
  /**
   * The write contradicts state the server enforces structurally, so no
   * permission can allow it. Carries only what the refusal reports —
   * there is no rule to apply.
   */
  | ({ readonly kind: "refused"; readonly groupIds: readonly string[] } & RefusalDetail)
  | { readonly kind: "unresolved"; readonly reason: CanUnknownReason };

/** What a {@link RuleResolution} means for one subject. */
type RuleDecision =
  | { readonly kind: "allowed"; readonly groupIds: readonly string[] }
  | { readonly kind: "denied"; readonly violation: PermissionViolation }
  | { readonly kind: "unknown"; readonly reason: CanUnknownReason };

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
  /**
   * The entity's **committed** group set: its local `entityGroup` rows,
   * never the puts riding in the same Action. The share rule reads this,
   * because an entity the store has not filed yet is new to it and the
   * target gate stands alone (#623) — the server reads its caches the same
   * way.
   */
  readonly committedGroupSetFor: (id: string) => Promise<readonly string[]>;
  readonly readMembership: (membershipId: string) => Promise<LiveMembership | null>;
}

/**
 * The storage-backed half of {@link RuleInputs}, shared by the write path
 * and the query path so a subject's `exists` / `readMembership` lookups
 * have one implementation. Callers supply `fieldValue` and override
 * `resolveType` / `groupSetFor` / `committedGroupSetFor` with their own
 * source (the Action's in-flight context, or committed storage).
 */
const storageInputs = (
  storage: StorageAdapter,
  fieldValue: (name: string) => unknown,
): Omit<RuleInputs, "resolveType" | "groupSetFor" | "committedGroupSetFor"> => ({
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
 * The source a relationship row is committed with, or `null` when the
 * local store knows no such row (a new edge, or one whose row is
 * tombstoned — the server's by-id row is gone too).
 */
const committedRelationshipSource = async (
  subjectId: string,
  inputs: RuleInputs,
): Promise<string | null> => {
  const row = await inputs.exists(subjectId);
  if (row?.type !== "relationship" || row.deleted_hlc !== null) return null;
  return asString(row.data?.fields?.["source_id"]?.value);
};

/**
 * The rule table: for a subject `(type, id, method)`, the permission it
 * requires and the groups to union-match. Returns `unresolved` when the
 * inputs the rule needs are not locally available — the write path then
 * defers to the server, and `can()` reports `unknown`.
 *
 * Rules mirror `EbbServer.Storage.PermissionHelper` and #319:
 * - user entity → `<committed type>.<verb>` over the entity's group set,
 *   where the committed type is the entity's local type, never the wire
 *   `subject_type` (#624). An id the local store has never seen has no
 *   committed type, so the wire type stands — and a declared type that
 *   contradicts the committed one is refused outright with no permission
 *   to report, as the server refuses it;
 * - `group` → `group.<verb>` in the group itself;
 * - `groupMember` → `groupMember.<verb>` in the membership's group;
 * - `entityGroup` put → `<entityType>.create` in the target group **and**
 *   `<entityType>.update` over the entity's current group set, because
 *   filing an entity the store already places in a group is a write to it
 *   (#623). An entity with no locally-known group set is the server's
 *   "new to the index" branch, where `create` stands alone. The server
 *   also refuses `patch` outright, so this pass reports it as a structural
 *   refusal with no permission consulted;
 * - the one duplicate-row refusal is not mirrored: our clients derive one
 *   row id per `(entity, group)`, so they cannot express it, and the
 *   server stays the authority;
 * - `entityGroup` delete → `<entityType>.update` in the entity's current set;
 * - `relationship` put → `<sourceType>.update` over the source's set;
 *   patch/delete → `relationship.<verb>` over the source's set. A row's
 *   source is its identity: a put or patch whose declared `source_id`
 *   differs from the committed row's is refused outright (#624), since
 *   the server will not re-point an edge. An id whose binding this batch
 *   has released — its delete rides in this Action or an earlier one of
 *   the same batch — reads as a new edge, authorized by the wire source,
 *   which is how delete + put moves one. The delete and patch scopes still
 *   come from the stored row, as the server scopes them. An id the local
 *   store has no live relationship row for is a new edge too. A delete's
 *   wire `source_id` is ignored — the server resolves the stored row — so
 *   only the committed source can authorize it.
 */
async function resolveRule(
  subjectType: string,
  subjectId: string,
  method: Update["method"],
  inputs: RuleInputs,
  released: ReadonlySet<string>,
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

        // Filing an entity is a write to it: the target group's `create`
        // is not enough where the entity already lives, so both rules must
        // hold (#623). An entity with no locally-known group set is the
        // server's "new to the index" branch, where `create` stands alone —
        // deferring there rather than inventing a local refusal.
        const rules: ResolvedRule[] = [
          {
            type,
            verb: "create",
            required: `${type}.create`,
            groupIds: [groupId],
            cachedOnly: true,
          },
        ];
        const sourceGroups = await inputs.committedGroupSetFor(entityId);
        if (sourceGroups.length > 0) {
          rules.push({
            type,
            verb: "update",
            required: `${type}.update`,
            groupIds: sourceGroups,
            cachedOnly: true,
          });
        }
        return { kind: "rules", rules };
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
      // patch — the server refuses the method outright, whatever the
      // caller holds, so no permission rule can describe it (#623).
      const membership = await inputs.readMembership(subjectId);
      const groupId = asString(inputs.fieldValue("group_id")) ?? membership?.groupId ?? null;
      return {
        kind: "refused",
        reason: "method-unsupported",
        method,
        groupIds: groupId === null ? [] : [groupId],
      };
    }

    case "relationship": {
      const declaredSourceId = asString(inputs.fieldValue("source_id"));
      const committedSourceId = await committedRelationshipSource(subjectId, inputs);
      // A delete in this batch releases the binding, so the re-point check
      // has nothing left to contradict.
      const boundSourceId = released.has(subjectId) ? null : committedSourceId;
      // A row's source is its identity: for a put or patch the server
      // refuses a declared source other than the committed one rather than
      // re-pointing the edge, so neither may this pass allow it. A delete
      // carries a source the server never reads — it resolves the stored
      // row — so a stale one there is ignored, not refused.
      if (
        method !== "delete" &&
        declaredSourceId !== null &&
        boundSourceId !== null &&
        declaredSourceId !== boundSourceId
      ) {
        return {
          kind: "refused",
          reason: "source-mismatch",
          declaredSourceId,
          committedSourceId: boundSourceId,
          groupIds: await inputs.groupSetFor(boundSourceId),
        };
      }

      if (method === "put") {
        if (declaredSourceId === null) return { kind: "unresolved", reason: "entity-unknown" };
        // The permission type follows the source entity's true type,
        // never the wire `type` label, which is forgeable (#323).
        const type = await inputs.resolveType(declaredSourceId);
        if (type === null) return { kind: "unresolved", reason: "entity-unknown" };
        const groupIds = await inputs.groupSetFor(declaredSourceId);
        if (groupIds.length === 0) return { kind: "unresolved", reason: "no-owner" };
        return rule({
          type,
          verb: "update",
          required: `${type}.update`,
          groupIds,
          cachedOnly: false,
        });
      }
      // A delete's groups come from the stored row; a patch may restate
      // the source it keeps. Neither reads the batch release: the stored
      // row scopes both.
      const sourceId =
        method === "delete" ? committedSourceId : (declaredSourceId ?? committedSourceId);
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
      const committedType = await inputs.resolveType(subjectId);
      // A type is identity: the server refuses a declared type other than
      // the one the id is committed under rather than falling back to it,
      // so neither may this pass allow it (#624).
      if (committedType !== null && committedType !== subjectType) {
        return { kind: "refused", reason: "type-mismatch", committedType, groupIds };
      }
      const type = committedType ?? subjectType;
      return rule({
        type,
        verb,
        required: `${type}.${verb}`,
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

/** The subject a decision is about, in the violation's vocabulary. */
interface DecisionSubject {
  readonly subjectType: string;
  readonly subjectId: string;
}

const missingPermission = (
  subject: DecisionSubject,
  rule: ResolvedRule,
): MissingPermissionViolation => ({
  kind: "missing-permission",
  subjectType: subject.subjectType,
  subjectId: subject.subjectId,
  required: rule.required,
  groupIds: rule.groupIds,
});

/** The violation a structural refusal reports; each reason names its own cause. */
const refusedViolation = (
  resolution: Extract<RuleResolution, { kind: "refused" }>,
  subject: DecisionSubject,
): TypeMismatchViolation | SourceMismatchViolation | MethodUnsupportedViolation => {
  switch (resolution.reason) {
    case "type-mismatch":
      return {
        kind: "type-mismatch",
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        committedType: resolution.committedType,
        groupIds: resolution.groupIds,
      };
    case "method-unsupported":
      return {
        kind: "method-unsupported",
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        method: resolution.method,
        groupIds: resolution.groupIds,
      };
    case "source-mismatch":
      return {
        kind: "source-mismatch",
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        declaredSourceId: resolution.declaredSourceId,
        committedSourceId: resolution.committedSourceId,
        groupIds: resolution.groupIds,
      };
    default:
      return assertNever(resolution);
  }
};

/**
 * The single place a {@link RuleResolution} becomes a decision. Only an
 * explicit `rule` the actor holds is an allow; every other variant denies
 * or defers, and a variant added later fails to compile until it does one
 * of those too.
 */
const decideRule = (
  resolution: RuleResolution,
  subject: DecisionSubject,
  permissionsFor: (groupId: string, cachedOnly: boolean) => readonly string[] | null,
): RuleDecision => {
  switch (resolution.kind) {
    case "rule":
      return ruleHolds(resolution.rule, permissionsFor)
        ? { kind: "allowed", groupIds: resolution.rule.groupIds }
        : { kind: "denied", violation: missingPermission(subject, resolution.rule) };
    case "rules": {
      // Every rule must hold. The first one that does not is the one
      // reported: it is the grant the caller has to go and get.
      const missing = resolution.rules.find((rule) => !ruleHolds(rule, permissionsFor));
      if (missing === undefined) {
        return {
          kind: "allowed",
          groupIds: [...new Set(resolution.rules.flatMap((rule) => rule.groupIds))],
        };
      }
      return { kind: "denied", violation: missingPermission(subject, missing) };
    }
    case "refused":
      return { kind: "denied", violation: refusedViolation(resolution, subject) };
    case "unresolved":
      return { kind: "unknown", reason: resolution.reason };
    default:
      return assertNever(resolution);
  }
};

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

/** No relationship id is released: the query path sees committed state only. */
const NO_RELEASED: ReadonlySet<string> = new Set();

/**
 * A relationship id whose delete rides in this Action. The union is taken
 * before any Update is checked, so inside one Action the delete's position
 * does not matter — the server's simulation is built the same way.
 */
const releasedByDeletes = (
  released: ReadonlySet<string>,
  updates: readonly Update[],
): ReadonlySet<string> => {
  const ids = updates.flatMap((update) =>
    update.subject_type === "relationship" && update.method === "delete" ? [update.subject_id] : [],
  );
  if (ids.length === 0) return released;
  return new Set([...released, ...ids]);
};

/** What one Action contributes to the batch. */
interface ActionViolations {
  readonly violations: readonly PermissionViolation[];
  /**
   * The relationship ids this Action's deletes release. The caller adopts
   * them only when the Action is accepted, so a refused Action releases
   * nothing for the Actions after it.
   */
  readonly released: ReadonlySet<string>;
}

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
  let released: ReadonlySet<string> = NO_RELEASED;
  for (const action of actions) {
    const result = await collectActionViolations(action, ctx, released);
    violations.push(...result.violations);
    if (result.violations.length === 0) released = result.released;
  }
  return violations;
}

const collectActionViolations = async (
  action: Action,
  ctx: PermissionContext,
  releasedBefore: ReadonlySet<string>,
): Promise<ActionViolations> => {
  const updates = action.updates;
  const released = releasedByDeletes(releasedBefore, updates);
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
    const resolution = await resolveRule(
      update.subject_type,
      update.subject_id,
      update.method,
      {
        ...storageInputs(ctx.storage, (name) => fieldValue(update, name)),
        resolveType,
        groupSetFor,
        committedGroupSetFor: async (entityId) =>
          (await readEntityMemberships(ctx.storage, entityId)).map((m) => m.groupId),
      },
      released,
    );
    const decision = decideRule(
      resolution,
      { subjectType: update.subject_type, subjectId: update.subject_id },
      permissionsFor,
    );
    switch (decision.kind) {
      case "allowed":
      case "unknown":
        return null;
      case "denied":
        return decision.violation;
      default:
        return assertNever(decision);
    }
  };

  const violations: PermissionViolation[] = [];
  for (const update of updates) {
    if (isBootstrapExempt(update)) continue;
    const violation = await check(update);
    if (violation !== null) violations.push(violation);
  }
  return { violations, released };
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
    violation: {
      kind: "missing-permission",
      subjectType: type,
      subjectId: "*",
      required: `${type}.${verb}`,
      groupIds,
    },
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
  const resolution = await resolveRule(
    row.type,
    id,
    METHOD_BY_VERB[verb],
    {
      ...inputs,
      resolveType: async (entityId) => (await inputs.exists(entityId))?.type ?? null,
      // The query path sees committed state only, so both reads agree.
      groupSetFor: async (entityId) =>
        (await readEntityMemberships(ctx.storage, entityId)).map((m) => m.groupId),
      committedGroupSetFor: async (entityId) =>
        (await readEntityMemberships(ctx.storage, entityId)).map((m) => m.groupId),
    },
    NO_RELEASED,
  );
  const decision = decideRule(resolution, { subjectType: row.type, subjectId: id }, permissionsFor);
  switch (decision.kind) {
    case "allowed":
      return { kind: "allowed", groupIds: decision.groupIds };
    case "denied":
      return { kind: "denied", violation: decision.violation };
    case "unknown":
      return { kind: "unknown", reason: decision.reason };
    default:
      return assertNever(decision);
  }
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
