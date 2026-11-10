/**
 * Local permission pre-check (#319) and its read-only query (#322).
 *
 * A best-effort client-side mirror of `EbbServer.Storage.Authorizer` +
 * `PermissionHelper`: every Update a client authors is checked for
 * `<model>.<verb>` before the Action reaches the Outbox, so the common
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
 * contains `"<model>.<verb>"` or `"<model>.*"`. User entities and
 * domain edges use union semantics over the entity's group set (any
 * group may grant it); membership mutations of an existing entity
 * consult cached permissions only, never the Action's declared
 * bootstrap grant.
 *
 * Permissions are checked per row, not per Update: one Action's component
 * Updates for one subject fold into one row mutation, and that mutation is
 * the `create` (the row's first write) or an `update` (a write to a row that
 * already exists).
 *
 * For a user-entity write, the permission model is the model the id was
 * committed under, never the component's model prefix, which is forgeable
 * (#624). A write whose components name another model is refused here
 * whatever permission the actor holds: the server refuses it
 * structurally, so no grant could make it pass. That check covers user
 * entities only — a `relationship` or `entityGroup` write whose subject id
 * is committed as some other model passes this best-effort pass and is
 * refused by the server. A `relationship` row's source is likewise its
 * identity: a write that declares another `source_id` is refused here with
 * no permission to report, mirroring the server's "a relationship row cannot
 * be re-pointed at another source" (#624); moving an edge is delete plus
 * create, and a delete's wire source is ignored. A delete in the same
 * `write()` batch releases the row's source binding for the Actions that
 * follow it — as the server's request simulation does — so the delete plus
 * re-create that moves an edge is authorized here too; within one Action the
 * release is order-independent, and a refused Action releases nothing. A
 * delete still sitting in the Outbox — no echo yet — releases nothing either,
 * so an edge moved across two `write()` calls is refused locally until the
 * delete syncs; batch the delete and the re-create. The server also binds an
 * id's first model for the whole request, so an Action that relabels an id an
 * earlier Action in the same batch created is refused there but not here;
 * Actions are otherwise checked one at a time.
 */

import {
  componentModel,
  componentName,
  isFieldMap,
  type Action,
  type Entity,
  type FieldValue,
  type Update,
} from "@ebbjs/core";
import type { StorageAdapter } from "@ebbjs/storage/types";

import { readEntityMemberships, readMembership, type LiveMembership } from "./entity-group";

/** The three write verbs a permission can be granted for. */
export type PermissionVerb = "create" | "update" | "delete";

/** One row the local pass refused, and why. */
export type PermissionViolation =
  | MissingPermissionViolation
  | TypeMismatchViolation
  | SourceMismatchViolation;

/**
 * The actor holds no permission that would allow the write: no group in
 * {@link groupIds} grants {@link required}.
 */
export interface MissingPermissionViolation {
  readonly kind: "missing-permission";
  /** The model the row is committed under. */
  readonly model: string;
  readonly subjectId: string;
  /** The permission the actor lacked, e.g. `"todo.create"`. */
  readonly required: string;
  /** The groups that were consulted; empty when none resolved. */
  readonly groupIds: readonly string[];
}

/**
 * The write cannot be authorized at any permission (#624): its components
 * name a model other than the one the entity is committed under, which the
 * server refuses structurally. There is deliberately no `required` — the
 * actor may hold every grant for both models and the write still fails.
 */
export interface TypeMismatchViolation {
  readonly kind: "type-mismatch";
  /** The model the write's components named. */
  readonly model: string;
  readonly subjectId: string;
  /** The model the entity is committed under locally. */
  readonly committedModel: string;
  /** The entity's group set, which the committed model is checked against. */
  readonly groupIds: readonly string[];
}

/**
 * The write cannot be authorized at any permission: a `relationship` write
 * declared a source other than the one the row is committed with, which the
 * server refuses structurally (#624). A row's source is its identity, so
 * moving an edge is expressed as delete plus create, never as a re-point.
 * There is deliberately no `required` — the actor may hold every
 * `relationship` grant and the write still fails.
 */
export interface SourceMismatchViolation {
  readonly kind: "source-mismatch";
  /** The model the write's components named, always `"relationship"`. */
  readonly model: string;
  readonly subjectId: string;
  /** The source the write declared, i.e. the `source_id` component value. */
  readonly declaredSourceId: string;
  /** The source the relationship row is committed with locally. */
  readonly committedSourceId: string;
  /** The committed source's group set. */
  readonly groupIds: readonly string[];
}

/**
 * Aggregated refusal of a locally-authored batch. Mirrors
 * `EntityValidationError` / `ActionRejectedError`: a named `Error`
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
      return `${violation.model} ${violation.subjectId}: missing "${violation.required}" (checked: ${groups})`;
    case "type-mismatch":
      return (
        `${violation.model} ${violation.subjectId}: declared model "${violation.model}"` +
        ` but the entity is committed as "${violation.committedModel}"; an entity's model cannot` +
        ` change (checked: ${groups})`
      );
    case "source-mismatch":
      return (
        `${violation.model} ${violation.subjectId}: declared source` +
        ` "${violation.declaredSourceId}" but the row is committed with source` +
        ` "${violation.committedSourceId}"; a relationship row cannot be re-pointed at another` +
        ` source (checked: ${groups})`
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

/** Models that carry their own authorization rules. */
const SYSTEM_MODELS = new Set(["group", "groupMember", "relationship", "entityGroup"]);

const VERBS: ReadonlySet<string> = new Set(["create", "update", "delete"]);

const isVerb = (value: string): value is PermissionVerb => VERBS.has(value);

/**
 * The single `<model>.<verb>` rule: a permission is granted by an exact
 * match or the `model.*` wildcard. Both the write-path pre-check and
 * `client.can()` decide through this.
 */
const grantsPermission = (
  permissions: readonly string[],
  model: string,
  verb: PermissionVerb,
): boolean => permissions.includes(`${model}.${verb}`) || permissions.includes(`${model}.*`);

/**
 * One subject's authorization rule, resolved: the permission the actor
 * must hold and the group set it is union-matched over.
 */
interface ResolvedRule {
  /** Permission namespace, e.g. `todo` for `todo.update`. */
  readonly model: string;
  readonly verb: PermissionVerb;
  /** The permission string the actor must hold, `${model}.${verb}`. */
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
      /** The write named a model other than the committed one. */
      readonly reason: "type-mismatch";
      readonly committedModel: string;
    }
  | {
      /** The write declared a relationship source other than the row's own. */
      readonly reason: "source-mismatch";
      readonly declaredSourceId: string;
      readonly committedSourceId: string;
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
 * write path (over a wire Action's folded row) and the query path (over a
 * materialized row) supply these.
 */
interface RuleInputs {
  /** Read a field's component value from the subject's data. */
  readonly fieldValue: (name: string) => unknown;
  readonly exists: (id: string) => Promise<Entity | null>;
  /** The true model of an entity id, or `null` when it is not local. */
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

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asStringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** One subject's folded writes in an Action. */
interface SubjectWrites {
  /** The model its components name; `undefined` for a delete-only row. */
  readonly model?: string;
  /** The component values it carries, keyed by full component name. */
  readonly components: ReadonlyMap<string, FieldValue>;
  readonly deleted: boolean;
  /**
   * Whether the write carries a `replace`. The planner writes a create that
   * way, so the verb a create is authorized as is the wire's own statement of
   * intent; a `merge` is an update.
   */
  readonly replaced: boolean;
}

/** Fold one Action's Updates into one entry per subject, in first-seen order. */
const foldSubjects = (updates: readonly Update[]): Map<string, SubjectWrites> => {
  const subjects = new Map<string, SubjectWrites>();
  for (const update of updates) {
    const entry: SubjectWrites = subjects.get(update.subject_id) ?? {
      components: new Map<string, FieldValue>(),
      deleted: false,
      replaced: false,
    };
    if (update.method === "delete") {
      subjects.set(update.subject_id, { ...entry, deleted: true });
      continue;
    }
    const components = new Map(entry.components);
    if (update.method !== "drop") components.set(update.component, update.data);
    subjects.set(update.subject_id, {
      model: componentModel(update.component),
      components,
      deleted: entry.deleted,
      replaced: entry.replaced || update.method === "replace",
    });
  }
  return subjects;
};

/** One wire field's value from a subject's component values, or `undefined`. */
const componentValue = (writes: SubjectWrites, name: string): unknown => {
  if (writes.model === undefined) return undefined;
  const value = writes.components.get(componentName(writes.model, name));
  return value === undefined || isFieldMap(value) ? undefined : value.value;
};

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
 * The rule table: for a subject `(model, id, verb)`, the permission it
 * requires and the groups to union-match. Returns `unresolved` when the
 * inputs the rule needs are not locally available — the write path then
 * defers to the server, and `can()` reports `unknown`.
 *
 * Rules mirror `EbbServer.Storage.PermissionHelper` and #319:
 * - user entity → `<committed model>.<verb>` over the entity's group set,
 *   where the committed model is the entity's local type, never the
 *   component's model prefix (#624). An id the local store has never seen has
 *   no committed model, so the component's prefix stands — and a declared
 *   model that contradicts the committed one is refused outright with no
 *   permission to report, as the server refuses it;
 * - `group` → `group.<verb>` in the group itself;
 * - `groupMember` → `groupMember.<verb>` in the membership's group;
 * - `entityGroup` create → `<entityModel>.create` in the target group **and**
 *   `<entityModel>.update` over the entity's current group set, because
 *   filing an entity the store already places in a group is a write to it
 *   (#623). An entity with no locally-known group set is the server's
 *   "new to the index" branch, where `create` stands alone;
 * - the one duplicate-row refusal is not mirrored: our clients derive one
 *   row id per `(entity, group)`, so they cannot express it, and the
 *   server stays the authority;
 * - `entityGroup` delete → `<entityModel>.update` in the entity's current set;
 * - `relationship` create → `<sourceModel>.update` over the source's set;
 *   update/delete → `relationship.<verb>` over the source's set. A row's
 *   source is its identity: a write whose declared `source_id` differs from
 *   the committed row's is refused outright (#624), since the server will not
 *   re-point an edge. An id whose binding this batch has released — its
 *   delete rides in this Action or an earlier one of the same batch — reads as
 *   a new edge, authorized by the wire source, which is how delete plus
 *   create moves one. The delete and update scopes still come from the stored
 *   row, as the server scopes them. An id the local store has no live
 *   relationship row for is a new edge too. A delete's wire `source_id` is
 *   ignored — the server resolves the stored row — so only the committed
 *   source can authorize it.
 */
async function resolveRule(
  model: string,
  subjectId: string,
  verb: PermissionVerb,
  writes: SubjectWrites,
  inputs: RuleInputs,
  released: ReadonlySet<string>,
): Promise<RuleResolution> {
  const rule = (r: ResolvedRule): RuleResolution => ({ kind: "rule", rule: r });

  switch (model) {
    case "group": {
      return rule({
        model: "group",
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
        model: "groupMember",
        verb,
        required: `groupMember.${verb}`,
        groupIds,
        cachedOnly: false,
      });
    }

    case "entityGroup": {
      if (verb !== "delete") {
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
            model: type,
            verb: "create",
            required: `${type}.create`,
            groupIds: [groupId],
            cachedOnly: true,
          },
        ];
        const sourceGroups = await inputs.committedGroupSetFor(entityId);
        if (sourceGroups.length > 0) {
          rules.push({
            model: type,
            verb: "update",
            required: `${type}.update`,
            groupIds: sourceGroups,
            cachedOnly: true,
          });
        }
        return { kind: "rules", rules };
      }
      const membership = await inputs.readMembership(subjectId);
      if (membership === null) return { kind: "unresolved", reason: "entity-unknown" };
      const type = await inputs.resolveType(membership.entityId);
      if (type === null) return { kind: "unresolved", reason: "entity-unknown" };
      const groupIds = await inputs.groupSetFor(membership.entityId);
      return rule({
        model: type,
        verb: "update",
        required: `${type}.update`,
        groupIds,
        cachedOnly: true,
      });
    }

    case "relationship": {
      const declaredSourceId = asString(inputs.fieldValue("source_id"));
      const committedSourceId = await committedRelationshipSource(subjectId, inputs);
      // A delete in this batch releases the binding, so the re-point check
      // has nothing left to contradict and the row reads as a new edge.
      const boundSourceId = released.has(subjectId) ? null : committedSourceId;
      // A row's source is its identity: the server refuses a declared source
      // other than the committed one rather than re-pointing the edge, so
      // neither may this pass allow it. A delete carries a source the server
      // never reads — it resolves the stored row — so a stale one there is
      // ignored, not refused.
      if (
        verb !== "delete" &&
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

      // A create states the source it is made with, so it is authorized as a
      // write to that source entity. An update to an existing edge is a
      // `relationship` write, scoped by the source it keeps.
      if (verb === "create") {
        if (declaredSourceId === null) return { kind: "unresolved", reason: "entity-unknown" };
        // The permission model follows the source entity's true model,
        // never the wire `type` label, which is forgeable (#323).
        const type = await inputs.resolveType(declaredSourceId);
        if (type === null) return { kind: "unresolved", reason: "entity-unknown" };
        const groupIds = await inputs.groupSetFor(declaredSourceId);
        if (groupIds.length === 0) return { kind: "unresolved", reason: "no-owner" };
        return rule({
          model: type,
          verb: "update",
          required: `${type}.update`,
          groupIds,
          cachedOnly: false,
        });
      }
      // A delete's groups come from the stored row; an update may restate
      // the source it keeps. Neither reads the batch release: the stored
      // row scopes both.
      const sourceId =
        verb === "delete" ? committedSourceId : (declaredSourceId ?? committedSourceId);
      if (sourceId === null) return { kind: "unresolved", reason: "entity-unknown" };
      const groupIds = await inputs.groupSetFor(sourceId);
      if (groupIds.length === 0) return { kind: "unresolved", reason: "no-owner" };
      return rule({
        model: "relationship",
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
      const committedModel = await inputs.resolveType(subjectId);
      // A model is identity: the server refuses components naming a model
      // other than the one the id is committed under rather than falling back
      // to it, so neither may this pass allow it (#624).
      if (committedModel !== null && committedModel !== model) {
        return { kind: "refused", reason: "type-mismatch", committedModel, groupIds };
      }
      const type = committedModel ?? model;
      return rule({
        model: type,
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
    return permissions !== null && grantsPermission(permissions, rule.model, rule.verb);
  });

/** The subject a decision is about, in the violation's vocabulary. */
interface DecisionSubject {
  readonly model: string;
  readonly subjectId: string;
}

const missingPermission = (
  subject: DecisionSubject,
  rule: ResolvedRule,
): MissingPermissionViolation => ({
  kind: "missing-permission",
  model: subject.model,
  subjectId: subject.subjectId,
  required: rule.required,
  groupIds: rule.groupIds,
});

/** The violation a structural refusal reports; each reason names its own cause. */
const refusedViolation = (
  resolution: Extract<RuleResolution, { kind: "refused" }>,
  subject: DecisionSubject,
): TypeMismatchViolation | SourceMismatchViolation => {
  switch (resolution.reason) {
    case "type-mismatch":
      return {
        kind: "type-mismatch",
        model: subject.model,
        subjectId: subject.subjectId,
        committedModel: resolution.committedModel,
        groupIds: resolution.groupIds,
      };
    case "source-mismatch":
      return {
        kind: "source-mismatch",
        model: subject.model,
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
 * The relationship ids whose deletes ride in this Action. A delete names no
 * component, so its model comes from the local row. The union is taken before
 * any subject is checked, so inside one Action the delete's position does not
 * matter — the server's simulation is built the same way.
 */
const releasedByDeletes = async (
  released: ReadonlySet<string>,
  subjects: ReadonlyMap<string, SubjectWrites>,
  modelOf: (id: string) => Promise<string | undefined>,
): Promise<ReadonlySet<string>> => {
  const ids: string[] = [];
  for (const [id, writes] of subjects) {
    if (!writes.deleted) continue;
    if ((writes.model ?? (await modelOf(id))) === "relationship") ids.push(id);
  }
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
  const subjects = foldSubjects(action.updates);
  const cached = new Map(ctx.actorGroups.map((g) => [g.id, g.permissions]));
  await mergeLocalMemberships(cached, ctx);

  const exists = async (id: string): Promise<Entity | null> => ctx.storage.entities.get(id);
  const released = await releasedByDeletes(
    releasedBefore,
    subjects,
    async (id) => (await exists(id))?.type,
  );

  // A row's first write is a create, a write to an existing row an update.
  // The batch has not materialized anything, so existence is the local store's
  // and, for the rows this Action introduces, its own.
  const createdModels = new Map<string, string>();
  for (const [id, writes] of subjects) {
    if (writes.deleted || writes.model === undefined) continue;
    if (SYSTEM_MODELS.has(writes.model)) continue;
    createdModels.set(id, writes.model);
  }
  const createdIds = new Set<string>();
  for (const id of createdModels.keys()) {
    if ((await exists(id)) === null) createdIds.add(id);
  }

  // A group put for an id that does not already resolve to a `group`
  // entity is a bootstrap; the actor's own membership in it is not yet
  // cached, so the Action's declared grant stands in.
  const newGroupIds = new Set<string>();
  for (const [id, writes] of subjects) {
    if (writes.deleted || writes.model !== "group") continue;
    const existing = await exists(id);
    if (existing === null || existing.type !== "group") newGroupIds.add(id);
  }

  const bootstrap = new Map<string, readonly string[]>();
  for (const writes of subjects.values()) {
    if (writes.deleted || writes.model !== "groupMember") continue;
    if (componentValue(writes, "actor_id") !== ctx.actorId) continue;
    const groupId = asString(componentValue(writes, "group_id"));
    if (groupId === null || !newGroupIds.has(groupId)) continue;
    bootstrap.set(groupId, asStringArray(componentValue(writes, "permissions")));
  }

  const resolveType = async (entityId: string): Promise<string | null> => {
    const existing = await exists(entityId);
    if (existing !== null) return existing.type;
    return createdModels.get(entityId) ?? null;
  };

  // The entity's group set: its local membership rows plus the
  // `entityGroup` writes riding along in the same Action.
  const groupSetFor = async (entityId: string): Promise<readonly string[]> => {
    const memberships = await readEntityMemberships(ctx.storage, entityId);
    const groupIds = new Set(memberships.map((m) => m.groupId));
    for (const [, writes] of subjects) {
      if (writes.deleted || writes.model !== "entityGroup") continue;
      if (asString(componentValue(writes, "entity_id")) !== entityId) continue;
      const groupId = asString(componentValue(writes, "group_id"));
      if (groupId !== null) groupIds.add(groupId);
    }
    return [...groupIds];
  };

  const permissionsFor = buildPermissionsFor(cached, bootstrap);

  const isBootstrapExempt = (subjectId: string, writes: SubjectWrites): boolean => {
    // `bootstrap` only holds groups the Action also puts the actor's
    // own membership into, matching the server's exemption exactly.
    if (writes.deleted) return false;
    if (writes.model === "group") return bootstrap.has(subjectId);
    if (writes.model === "groupMember") {
      const groupId = asString(componentValue(writes, "group_id"));
      return (
        componentValue(writes, "actor_id") === ctx.actorId &&
        groupId !== null &&
        bootstrap.has(groupId)
      );
    }
    if (writes.model === "entityGroup") {
      const groupId = asString(componentValue(writes, "group_id"));
      const entityId = asString(componentValue(writes, "entity_id"));
      return (
        groupId !== null && bootstrap.has(groupId) && entityId !== null && createdIds.has(entityId)
      );
    }
    return false;
  };

  const check = async (
    subjectId: string,
    writes: SubjectWrites,
  ): Promise<PermissionViolation | null> => {
    const model = writes.model ?? (await exists(subjectId))?.type;
    // A delete of a row the store does not know names no model: the server
    // resolves it from its own index, and this pass has nothing to say.
    if (model === undefined) return null;
    const verb: PermissionVerb = writes.deleted ? "delete" : writes.replaced ? "create" : "update";
    const resolution = await resolveRule(
      model,
      subjectId,
      verb,
      writes,
      {
        ...storageInputs(ctx.storage, (name) => componentValue(writes, name)),
        resolveType,
        groupSetFor,
        committedGroupSetFor: async (entityId) =>
          (await readEntityMemberships(ctx.storage, entityId)).map((m) => m.groupId),
      },
      released,
    );
    const decision = decideRule(resolution, { model, subjectId }, permissionsFor);
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
  for (const [subjectId, writes] of subjects) {
    if (isBootstrapExempt(subjectId, writes)) continue;
    const violation = await check(subjectId, writes);
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
  /** Does the actor hold `<model>.<verb>` in any of its groups? */
  can(permission: string): Promise<CanResult>;
  /** Does the actor hold `<verb>` for the entity `subject` names? */
  can(subject: CanSubject, verb: PermissionVerb): Promise<CanResult>;
}

/**
 * The global form: does the actor hold `<model>.<verb>` anywhere? Consulted
 * groups are the handshake's actor groups plus the actor's local
 * `groupMember` rows. Mirrors the write path: with no handshake the actor's
 * groups are unknown, so the answer is `unknown` rather than `denied`.
 */
export async function queryActorPermission(
  permission: string,
  ctx: CanContext,
): Promise<CanResult> {
  const { model, verb } = parsePermission(permission);
  if (!ctx.handshaken) {
    return { kind: "unknown", reason: "no-handshake" };
  }
  const cached = new Map(ctx.actorGroups.map((g) => [g.id, g.permissions]));
  await mergeLocalMemberships(cached, ctx);
  const groupIds = [...cached.keys()];
  if (groupIds.some((id) => grantsPermission(cached.get(id) ?? [], model, verb))) {
    return { kind: "allowed", groupIds };
  }
  return {
    kind: "denied",
    // The global form has no single subject; `"*"` marks "the actor".
    violation: {
      kind: "missing-permission",
      model,
      subjectId: "*",
      required: `${model}.${verb}`,
      groupIds,
    },
  };
}

/**
 * The per-entity form: resolve the entity's model and group set and apply
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
  const writes: SubjectWrites = {
    model: row.type,
    components: new Map(),
    deleted: verb === "delete",
    replaced: verb === "create",
  };
  const resolution = await resolveRule(
    row.type,
    id,
    verb,
    writes,
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
  const decision = decideRule(resolution, { model: row.type, subjectId: id }, permissionsFor);
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
 * Parse a `"<model>.<verb>"` permission string into the rule's two parts.
 * The verb is split on the last dot so a dotted model survives. Throws a
 * `TypeError` on a malformed string — this is a programming error, not a
 * permission outcome.
 */
const parsePermission = (permission: string): { model: string; verb: PermissionVerb } => {
  const dot = permission.lastIndexOf(".");
  const model = dot > 0 ? permission.slice(0, dot) : "";
  const verb = dot > 0 ? permission.slice(dot + 1) : "";
  if (model.length === 0 || !isVerb(verb)) {
    throw new TypeError(
      `can(): expected "<model>.<verb>" with verb one of create/update/delete, got "${permission}"`,
    );
  }
  return { model, verb };
};
