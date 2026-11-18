/**
 * Local permission pre-check (#319) and its read-only query (#322).
 *
 * A best-effort client-side mirror of `EbbServer.Storage.Authorizer` +
 * `PermissionHelper`: every write a client authors is checked against the
 * permissions the actor holds before the Action reaches the Outbox, so the
 * common "you can't do that" case fails fast with no round-trip. The server
 * remains the authority; when the actor's groups are not yet known
 * (`handshake()` has not run) the whole pass is skipped and the write
 * goes to the wire.
 *
 * `can()` asks the same question as a query, so an app can decide what
 * to render *before* attempting a write. Both paths resolve a subject's
 * rule through {@link resolveRule} and decide it through
 * {@link decideRule}, so they cannot disagree on the rule table. The
 * write path additionally unions the Action's in-flight bootstrap grant
 * and in-flight `membership` puts, which a query over committed state
 * cannot see; `can()` is correspondingly conservative and reports
 * `unknown` where it cannot resolve a subject.
 *
 * A permission is held in a group when one of its grants covers the
 * write's subject: the grant's subject is the write's subject or an
 * ancestor of it, and its verb is the write's verb or `*`. So
 * `note.*` covers `note/body`, while `note/title.*` covers only
 * `note/title`. A user row's create and delete name the model; its
 * update names every component it writes, and every one must be
 * covered. A platform row names its component, `ebb/<kind>`; its
 * membership and link writes keep their own semantic subjects.
 * Checks are per row, not per Update: one Action's Updates for one
 * subject fold into one mutation, a `create` or an `update`.
 *
 * There is no deny: narrowing a member who holds `note.*` means
 * rewriting that grant to enumerate what they keep.
 *
 * Two refusals mirror the server structurally, so no grant can make them pass:
 * a user write naming a model other than the id's committed one (#624), and a
 * re-pointed immutable key on `ebb/grant` or `ebb/membership` (decision 13). An
 * `ebb/link` write needs no re-point rule: an edge is a key of its source row,
 * so there is no source field to contradict, and moving one is a tombstone plus
 * a presence in the same Update.
 */

import {
  carriesComponent,
  componentName,
  componentValue,
  EBB_COMPONENT_KINDS,
  EBB_MODEL_NAME,
  ebbComponent,
  isFieldMap,
  systemValueField,
  systemValueString,
  type Action,
  type EbbComponentKind,
  type Entity,
} from "@ebbjs/core";
import { foldSubjects, type SubjectWrites } from "@ebbjs/write";
import type { StorageAdapter } from "@ebbjs/storage/types";

import { readEntityMemberships, readMembership, type LiveMembership } from "./entity-group";

/** The three write verbs a permission can be granted for. */
export type PermissionVerb = "create" | "update" | "delete";

/** One row the local pass refused, and why. */
export type PermissionViolation =
  | MissingPermissionViolation
  | TypeMismatchViolation
  | KeyMismatchViolation;

/**
 * The actor holds no permission that would allow the write: no group in
 * {@link groupIds} grants {@link required}.
 */
export interface MissingPermissionViolation {
  readonly kind: "missing-permission";
  /**
   * The permission's subject: the committed model for a user row's create
   * or delete, or a component a user row's update writes, or the `ebb/*`
   * component a platform row names.
   */
  readonly permissionSubject: string;
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
 * The write cannot be authorized at any permission: an `ebb/membership` pair
 * or an `ebb/grant`'s `group_id` was re-pointed, which is fixed after create
 * (decision 13). There is deliberately no `required`.
 */
export interface KeyMismatchViolation {
  readonly kind: "key-mismatch";
  /** The component whose key is immutable, e.g. `ebb/membership`. */
  readonly component: string;
  readonly subjectId: string;
  /** The key field the write declared, e.g. `group_id`. */
  readonly field: string;
  /** The value the write declared. */
  readonly declaredValue: string;
  /** The value the row is committed with locally. */
  readonly committedValue: string;
  /** The committed row's group set. */
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
      return `${violation.permissionSubject} ${violation.subjectId}: missing "${violation.required}" (checked: ${groups})`;
    case "type-mismatch":
      return (
        `${violation.model} ${violation.subjectId}: declared model "${violation.model}"` +
        ` but the entity is committed as "${violation.committedModel}"; an entity's model cannot` +
        ` change (checked: ${groups})`
      );
    case "key-mismatch":
      return (
        `${violation.component} ${violation.subjectId}: declared ${violation.field}` +
        ` "${violation.declaredValue}" but the row is committed with` +
        ` "${violation.committedValue}"; ${violation.component} cannot be re-pointed (checked: ${groups})`
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

const VERBS: ReadonlySet<string> = new Set(["create", "update", "delete"]);

const isVerb = (value: string): value is PermissionVerb => VERBS.has(value);

const GRANT_ANY_VERB = "*";

/**
 * Parse a grant and a query string the same way, at the last dot: a subject
 * may contain dots and slashes, so only the final segment names the verb.
 */
const splitPermission = (
  permission: string,
): { readonly subject: string; readonly verb: string } | null => {
  const dot = permission.lastIndexOf(".");
  if (dot <= 0 || dot === permission.length - 1) return null;
  return { subject: permission.slice(0, dot), verb: permission.slice(dot + 1) };
};

/** Whether `grantSubject` is `subject` itself or an ancestor of it. */
const coversSubject = (grantSubject: string, subject: string): boolean =>
  subject === grantSubject || subject.startsWith(`${grantSubject}/`);

/**
 * Whether a grant covers a write: its subject is the write's subject or an
 * ancestor of it, and its verb is the write's verb or `*`. Both the
 * write-path pre-check and `client.can()` decide through this. A grant that
 * does not parse covers nothing.
 */
const grantsPermission = (
  permissions: readonly string[],
  subject: string,
  verb: PermissionVerb,
): boolean =>
  permissions.some((permission) => {
    const grant = splitPermission(permission);
    if (grant === null) return false;
    if (grant.verb !== verb && grant.verb !== GRANT_ANY_VERB) return false;
    return coversSubject(grant.subject, subject);
  });

/**
 * One subject's authorization rule, resolved: the permission the actor
 * must hold and the group set it is union-matched over.
 */
interface ResolvedRule {
  /** The permission's subject, e.g. `todo` or `note/body` or `ebb/grant`. */
  readonly subject: string;
  readonly verb: PermissionVerb;
  /** The permission string the actor must hold, `${subject}.${verb}`. */
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
      /** The write re-pointed a platform row's immutable key. */
      readonly reason: "key-mismatch";
      readonly component: string;
      readonly field: string;
      readonly declaredValue: string;
      readonly committedValue: string;
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
  readonly resolveModel: (id: string) => Promise<string | null>;
  /** The entity's group set (its `membership` memberships). */
  readonly groupSetFor: (id: string) => Promise<readonly string[]>;
  /**
   * The entity's **committed** group set: its local `membership` rows,
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
 * `resolveModel` / `groupSetFor` / `committedGroupSetFor` with their own
 * source (the Action's in-flight context, or committed storage).
 */
const storageInputs = (
  storage: StorageAdapter,
  fieldValue: (name: string) => unknown,
): Omit<RuleInputs, "resolveModel" | "groupSetFor" | "committedGroupSetFor"> => ({
  fieldValue,
  exists: (id) => storage.entities.get(id),
  readMembership: (membershipId) => readMembership(storage, membershipId),
});

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asStringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** One wire field's value from a subject's component values, or `undefined`. */
const rowFieldValue = (writes: SubjectWrites, name: string): unknown => {
  if (writes.model === undefined) return undefined;
  const value = writes.components.get(componentName(writes.model, name));
  return value === undefined || isFieldMap(value) ? undefined : value.value;
};

/** One field of the platform value a subject's writes carry, or `undefined`. */
const systemField = (writes: SubjectWrites, kind: EbbComponentKind, field: string): unknown =>
  componentValue(writes.components.get(ebbComponent(kind)))?.[field];

/**
 * The platform kind a stored row carries, or `null` for a user row. Every
 * platform row is an `ebb` row, so `row.model` cannot answer it.
 */
const platformKindOf = (row: Entity | null | undefined): EbbComponentKind | null => {
  if (row === null || row === undefined) return null;
  for (const kind of EBB_COMPONENT_KINDS) {
    if (carriesComponent(row, kind)) return kind;
  }
  return null;
};

/** One field of a subject's row, read through whichever kind it carries. */
const subjectField = (writes: SubjectWrites, name: string): unknown => {
  const kind = writes.kind;
  return kind === null ? rowFieldValue(writes, name) : systemField(writes, kind, name);
};

/** One field of a stored platform row's value, or `null` when it carries no such kind. */
const rowSystemField = (
  row: Entity | null | undefined,
  kind: EbbComponentKind,
  field: string,
): string | null => {
  if (row === null || row === undefined || row.deleted_hlc !== null) return null;
  if (!carriesComponent(row, kind)) return null;
  return systemValueString(row, kind, field);
};

/**
 * The value a platform row is committed with for one key field, or `null` when
 * the local store knows no live row carrying `kind` (a new row, or one whose
 * row is tombstoned — the server's by-id row is gone too).
 */
const committedSystemField = async (
  subjectId: string,
  kind: EbbComponentKind,
  field: string,
  inputs: RuleInputs,
): Promise<string | null> => rowSystemField(await inputs.exists(subjectId), kind, field);

/**
 * The rule table: for a write `(kind, model, id, verb, components)`, the
 * permissions it requires and the groups to union-match. Returns
 * `unresolved` when the inputs the rule needs are not locally available —
 * the write path then defers to the server, and `can()` reports `unknown`.
 *
 * Rules mirror `EbbServer.Storage.PermissionHelper` (#319). The permission
 * subject is the one the write names; platform rows keep their own scope and
 * semantic subjects:
 * - user entity create/delete → `<committed model>.<verb>` over its group
 *   set; an update → the same verb at every component it writes. A declared
 *   model contradicting the committed one is refused outright (#624).
 * - `ebb/group` → `ebb/group.<verb>` over its own group; `ebb/grant` →
 *   `ebb/grant.<verb>` over the grant's group.
 * - `ebb/membership` create → `<entityModel>.create` in the target group
 *   **and** `.update` over the entity's current set, because filing an entity
 *   the store already places in a group is a write to it (#623).
 * - `ebb/link` → `ebb/link.<verb>` over the subject row's own set: the edge is
 *   a key of that row's `ebb/link` component, so the row is the source.
 */
async function resolveRule(
  kind: EbbComponentKind | null,
  model: string,
  subjectId: string,
  verb: PermissionVerb,
  written: ReadonlySet<string>,
  inputs: RuleInputs,
): Promise<RuleResolution> {
  if (kind === null) return resolveUserRule(model, subjectId, verb, written, inputs);
  switch (kind) {
    case "group":
      return componentRule("group", verb, [subjectId], false);
    case "grant":
      return resolveGrantRule(subjectId, verb, inputs);
    case "membership":
      return resolveMembershipRule(subjectId, verb, inputs);
    case "link":
      return resolveLinkRule(subjectId, verb, inputs);
    default:
      return assertNever(kind);
  }
}

/**
 * A platform row's own permission: the component it names, scoped as the
 * caller reads its kind.
 */
const componentRule = (
  kind: EbbComponentKind,
  verb: PermissionVerb,
  groupIds: readonly string[],
  cachedOnly: boolean,
): RuleResolution => subjectRules([ebbComponent(kind)], verb, groupIds, cachedOnly);

/**
 * The rules a write naming `subjects` needs. Every one must hold: an update
 * that writes several components is only allowed if its grant covers each.
 */
const subjectRules = (
  subjects: readonly string[],
  verb: PermissionVerb,
  groupIds: readonly string[],
  cachedOnly: boolean,
): RuleResolution => {
  if (subjects.length === 0) throw new Error("a write rule needs at least one subject");
  const rules = subjects.map((subject) => ({
    subject,
    verb,
    required: `${subject}.${verb}`,
    groupIds,
    cachedOnly,
  }));
  return rules.length === 1 ? { kind: "rule", rule: rules[0] } : { kind: "rules", rules };
};

/**
 * A user-entity write: the model is the model the id was committed under,
 * never the component's model prefix, which is forgeable (#624). A create or
 * delete is a write to the row, so it names the model; an update names every
 * component it writes, and falls back to the model when it names none.
 */
async function resolveUserRule(
  model: string,
  subjectId: string,
  verb: PermissionVerb,
  written: ReadonlySet<string>,
  inputs: RuleInputs,
): Promise<RuleResolution> {
  const groupIds = await inputs.groupSetFor(subjectId);
  // No owners is the server's `missing_ownership`, not ours.
  if (groupIds.length === 0) return { kind: "unresolved", reason: "no-owner" };
  const committedModel = await inputs.resolveModel(subjectId);
  // A model is identity: the server refuses components naming a model
  // other than the one the id is committed under rather than falling back
  // to it, so neither may this pass allow it (#624).
  if (committedModel !== null && committedModel !== model) {
    return { kind: "refused", reason: "type-mismatch", committedModel, groupIds };
  }
  const resolved = committedModel ?? model;
  const subjects = verb === "update" && written.size > 0 ? [...written] : [resolved];
  return subjectRules(subjects, verb, groupIds, false);
}

/** The refusal a re-pointed key field reports, or `null` when the key is kept. */
const keyMismatch = async (
  kind: EbbComponentKind,
  field: string,
  subjectId: string,
  declared: string | null,
  committed: string | null,
): Promise<RuleResolution | null> => {
  if (declared === null || committed === null || declared === committed) return null;
  return {
    kind: "refused",
    reason: "key-mismatch",
    component: ebbComponent(kind),
    field,
    declaredValue: declared,
    committedValue: committed,
    groupIds: [committed],
  };
};

/** `ebb/grant`: its `group_id` is its identity, and the permission is its own. */
async function resolveGrantRule(
  subjectId: string,
  verb: PermissionVerb,
  inputs: RuleInputs,
): Promise<RuleResolution> {
  const declaredGroupId = asString(inputs.fieldValue("group_id"));
  const committedGroupId = await committedSystemField(subjectId, "grant", "group_id", inputs);
  if (verb !== "delete") {
    const refused = await keyMismatch(
      "grant",
      "group_id",
      subjectId,
      declaredGroupId,
      committedGroupId,
    );
    if (refused !== null) return refused;
  }
  const groupIds =
    declaredGroupId !== null
      ? [declaredGroupId]
      : committedGroupId !== null
        ? [committedGroupId]
        : await resolveMembershipGroupIds(subjectId, inputs);
  if (groupIds.length === 0) return { kind: "unresolved", reason: "entity-unknown" };
  return componentRule("grant", verb, groupIds, false);
}

/** `ebb/membership`: filing an entity is a write to it (#623). */
async function resolveMembershipRule(
  subjectId: string,
  verb: PermissionVerb,
  inputs: RuleInputs,
): Promise<RuleResolution> {
  const declaredGroupId = asString(inputs.fieldValue("group_id"));
  const declaredEntityId = asString(inputs.fieldValue("entity_id"));
  if (verb === "delete") {
    const membership = await inputs.readMembership(subjectId);
    if (membership === null) return { kind: "unresolved", reason: "entity-unknown" };
    const model = await inputs.resolveModel(membership.entityId);
    if (model === null) return { kind: "unresolved", reason: "entity-unknown" };
    return {
      kind: "rule",
      rule: {
        subject: model,
        verb: "update",
        required: `${model}.update`,
        groupIds: await inputs.groupSetFor(membership.entityId),
        cachedOnly: true,
      },
    };
  }

  // The pair is immutable: a re-put of the same pair is the idempotent write a
  // retried Action sends, but a write naming another pair is a move, and a move
  // is a delete of this row plus a create of another — the row id is derived
  // from the pair, so the same id cannot name a different one.
  for (const [field, declared] of [
    ["entity_id", declaredEntityId],
    ["group_id", declaredGroupId],
  ] as const) {
    const committed = await committedSystemField(subjectId, "membership", field, inputs);
    const refused = await keyMismatch("membership", field, subjectId, declared, committed);
    if (refused !== null) return refused;
  }

  if (declaredGroupId === null || declaredEntityId === null) {
    return { kind: "unresolved", reason: "entity-unknown" };
  }
  const model = await inputs.resolveModel(declaredEntityId);
  if (model === null) return { kind: "unresolved", reason: "entity-unknown" };

  const rules: ResolvedRule[] = [
    {
      subject: model,
      verb: "create",
      required: `${model}.create`,
      groupIds: [declaredGroupId],
      cachedOnly: true,
    },
  ];
  const sourceGroups = await inputs.committedGroupSetFor(declaredEntityId);
  if (sourceGroups.length > 0) {
    rules.push({
      subject: model,
      verb: "update",
      required: `${model}.update`,
      groupIds: sourceGroups,
      cachedOnly: true,
    });
  }
  return { kind: "rules", rules };
}

/**
 * `ebb/link`: the write names a key of the subject row's own edge set, so it is
 * authorized as `ebb/link.<verb>` in that row's group set. The row is the
 * source, which is why there is no source to resolve and no re-point to refuse.
 */
async function resolveLinkRule(
  subjectId: string,
  verb: PermissionVerb,
  inputs: RuleInputs,
): Promise<RuleResolution> {
  const groupIds = await inputs.groupSetFor(subjectId);
  if (groupIds.length === 0) return { kind: "unresolved", reason: "no-owner" };
  return componentRule("link", verb, groupIds, false);
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
    return permissions !== null && grantsPermission(permissions, rule.subject, rule.verb);
  });

/**
 * How a structural refusal names the row: a user row is the model it is
 * committed under, a platform row the component it carries rather than `ebb`.
 */
const rowSubject = (kind: EbbComponentKind | null, model: string): string =>
  kind === null ? model : ebbComponent(kind);

/** The row a decision is about. */
interface DecisionSubject {
  /**
   * How a structural refusal names the row: the model for a user row, the
   * component for a platform row.
   */
  readonly rowSubject: string;
  readonly subjectId: string;
}

const missingPermission = (subjectId: string, rule: ResolvedRule): MissingPermissionViolation => ({
  kind: "missing-permission",
  permissionSubject: rule.subject,
  subjectId,
  required: rule.required,
  groupIds: rule.groupIds,
});

/** The violation a structural refusal reports; each reason names its own cause. */
const refusedViolation = (
  resolution: Extract<RuleResolution, { kind: "refused" }>,
  subject: DecisionSubject,
): TypeMismatchViolation | KeyMismatchViolation => {
  switch (resolution.reason) {
    case "type-mismatch":
      return {
        kind: "type-mismatch",
        model: subject.rowSubject,
        subjectId: subject.subjectId,
        committedModel: resolution.committedModel,
        groupIds: resolution.groupIds,
      };
    case "key-mismatch":
      return {
        kind: "key-mismatch",
        component: resolution.component,
        subjectId: subject.subjectId,
        field: resolution.field,
        declaredValue: resolution.declaredValue,
        committedValue: resolution.committedValue,
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
        : { kind: "denied", violation: missingPermission(subject.subjectId, resolution.rule) };
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
      return { kind: "denied", violation: missingPermission(subject.subjectId, missing) };
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
 * Resolve the group an `ebb/grant` row belongs to: the wire `group_id` when
 * present, else the locally-materialized row's own value.
 */
const resolveMembershipGroupIds = async (
  subjectId: string,
  inputs: RuleInputs,
): Promise<readonly string[]> => {
  const wire = asString(inputs.fieldValue("group_id"));
  if (wire !== null) return [wire];
  const groupId = rowSystemField(await inputs.exists(subjectId), "grant", "group_id");
  return groupId === null ? [] : [groupId];
};

/** What one Action contributes to the batch. */
interface ActionViolations {
  readonly violations: readonly PermissionViolation[];
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
  for (const action of actions) {
    const result = await collectActionViolations(action, ctx);
    violations.push(...result.violations);
  }
  return violations;
}

const collectActionViolations = async (
  action: Action,
  ctx: PermissionContext,
): Promise<ActionViolations> => {
  const subjects = foldSubjects(action.updates);
  const cached = new Map(ctx.actorGroups.map((g) => [g.id, g.permissions]));
  await mergeLocalMemberships(cached, ctx);

  const exists = async (id: string): Promise<Entity | null> => ctx.storage.entities.get(id);

  // A row exists because the batch carries its create, and a write to a row
  // that exists is an update. The batch has not materialized anything, so a
  // create the local store already knows is a replay and not a create here.
  const subjectModels = new Map<string, string>();
  for (const [id, writes] of subjects) {
    if (writes.deleted || writes.model === undefined) continue;
    // A platform row is committed under `ebb`, whose own rules are per kind;
    // it is not a user model a later write should be authorized against.
    if (writes.model === EBB_MODEL_NAME) continue;
    subjectModels.set(id, writes.model);
  }
  const createdIds = new Set<string>();
  for (const [id, writes] of subjects) {
    if (!writes.created || !subjectModels.has(id)) continue;
    if ((await exists(id)) === null) createdIds.add(id);
  }

  // A group put for an id that does not already resolve to a `group`
  // entity is a bootstrap; the actor's own membership in it is not yet
  // cached, so the Action's declared grant stands in.
  const newGroupIds = new Set<string>();
  for (const [id, writes] of subjects) {
    if (writes.deleted || writes.kind !== "group") continue;
    const existing = await exists(id);
    if (existing === null || !carriesComponent(existing, "group")) newGroupIds.add(id);
  }

  const bootstrap = new Map<string, readonly string[]>();
  for (const writes of subjects.values()) {
    if (writes.deleted || writes.kind !== "grant") continue;
    if (systemField(writes, "grant", "actor_id") !== ctx.actorId) continue;
    const groupId = asString(systemField(writes, "grant", "group_id"));
    if (groupId === null || !newGroupIds.has(groupId)) continue;
    bootstrap.set(groupId, asStringArray(systemField(writes, "grant", "permissions")));
  }

  const resolveModel = async (entityId: string): Promise<string | null> => {
    const existing = await exists(entityId);
    if (existing !== null) return existing.model;
    return subjectModels.get(entityId) ?? null;
  };

  // The entity's group set: its local membership rows plus the
  // `ebb/membership` writes riding along in the same Action.
  const groupSetFor = async (entityId: string): Promise<readonly string[]> => {
    const memberships = await readEntityMemberships(ctx.storage, entityId);
    const groupIds = new Set(memberships.map((m) => m.groupId));
    for (const [, writes] of subjects) {
      if (writes.deleted || writes.kind !== "membership") continue;
      if (asString(systemField(writes, "membership", "entity_id")) !== entityId) continue;
      const groupId = asString(systemField(writes, "membership", "group_id"));
      if (groupId !== null) groupIds.add(groupId);
    }
    return [...groupIds];
  };

  const permissionsFor = buildPermissionsFor(cached, bootstrap);

  const isBootstrapExempt = (subjectId: string, writes: SubjectWrites): boolean => {
    // `bootstrap` only holds groups the Action also puts the actor's
    // own membership into, matching the server's exemption exactly.
    if (writes.deleted) return false;
    const kind = writes.kind;
    if (kind === "group") return bootstrap.has(subjectId);
    if (kind === "grant") {
      const groupId = asString(systemField(writes, "grant", "group_id"));
      return (
        systemField(writes, "grant", "actor_id") === ctx.actorId &&
        groupId !== null &&
        bootstrap.has(groupId)
      );
    }
    if (kind === "membership") {
      const groupId = asString(systemField(writes, "membership", "group_id"));
      const entityId = asString(systemField(writes, "membership", "entity_id"));
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
    const writtenKind = writes.kind;
    // A platform write is atomic, so its `replace` cannot state the verb —
    // existence answers it, and a delete's kind is its stored row's.
    const row = writes.model === undefined || writtenKind !== null ? await exists(subjectId) : null;
    const model = writes.model ?? row?.model;
    // A delete of a row the store does not know names no model: the server
    // resolves it from its own index, and this pass has nothing to say.
    if (model === undefined) return null;
    const kind = writtenKind ?? platformKindOf(row);
    // The verb follows the Action, not the store: a create is the Action that
    // carries the row's create, everything else is an update (#817). Asking
    // existence answers a different question — a row an earlier Action created
    // is not created by this one — and it is wrong for any component whose
    // absence is not the same as the row's (`ebb/link` is one).
    const verb: PermissionVerb = writes.deleted ? "delete" : writes.created ? "create" : "update";
    const resolution = await resolveRule(kind, model, subjectId, verb, writes.written, {
      ...storageInputs(ctx.storage, (name) => subjectField(writes, name)),
      resolveModel,
      groupSetFor,
      committedGroupSetFor: async (entityId) =>
        (await readEntityMemberships(ctx.storage, entityId)).map((m) => m.groupId),
    });
    const decision = decideRule(
      resolution,
      { rowSubject: rowSubject(kind, model), subjectId },
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
  for (const [subjectId, writes] of subjects) {
    if (isBootstrapExempt(subjectId, writes)) continue;
    const violation = await check(subjectId, writes);
    if (violation !== null) violations.push(violation);
  }
  return { violations };
};

/**
 * Merge the actor's own locally-materialized grants into the handshake's
 * permission map. The handshake is a snapshot, so after a bootstrap the pass
 * would otherwise refuse a write into the group it just created.
 */
const mergeLocalMemberships = async (
  cached: Map<string, readonly string[]>,
  ctx: PermissionContext,
): Promise<void> => {
  const grantIds = await ctx.storage.entities.queryByComponent(ebbComponent("grant"));
  for (const id of grantIds) {
    const row = await ctx.storage.entities.get(id);
    if (row === null) continue;
    if (systemValueField(row, "grant", "actor_id") !== ctx.actorId) continue;
    const groupId = asString(systemValueField(row, "grant", "group_id"));
    if (groupId === null) continue;
    const permissions = asStringArray(systemValueField(row, "grant", "permissions"));
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
  /** Does a grant on `<subject>.<verb>` or an ancestor of it hold in any group? */
  can(permission: string): Promise<CanResult>;
  /** Does the actor hold `<verb>` for the entity `subject` names? */
  can(subject: CanSubject, verb: PermissionVerb): Promise<CanResult>;
}

/**
 * The global form: does the actor hold `<subject>.<verb>` anywhere? Consulted
 * groups are the handshake's actor groups plus the actor's local grants.
 * Mirrors the write path: with no handshake the actor's
 * groups are unknown, so the answer is `unknown` rather than `denied`.
 */
export async function queryActorPermission(
  permission: string,
  ctx: CanContext,
): Promise<CanResult> {
  const { subject, verb } = parsePermission(permission);
  if (!ctx.handshaken) {
    return { kind: "unknown", reason: "no-handshake" };
  }
  const cached = new Map(ctx.actorGroups.map((g) => [g.id, g.permissions]));
  await mergeLocalMemberships(cached, ctx);
  const groupIds = [...cached.keys()];
  if (groupIds.some((id) => grantsPermission(cached.get(id) ?? [], subject, verb))) {
    return { kind: "allowed", groupIds };
  }
  return {
    kind: "denied",
    // The global form has no single entity; `"*"` marks "the actor".
    violation: {
      kind: "missing-permission",
      permissionSubject: subject,
      subjectId: "*",
      required: `${subject}.${verb}`,
      groupIds,
    },
  };
}

/** The query path names no component, so a user row is checked at its model. */
const NO_WRITTEN: ReadonlySet<string> = new Set();

/**
 * The per-entity form: resolve the entity's model and group set and apply
 * the same rule table the write path uses. `unknown` covers an id the
 * local store cannot resolve and an entity with no local owner.
 *
 * The query names no component, so a user row is checked at its model. A
 * grant that covers only some of the row's fields therefore reports
 * `denied` for an update: the query is conservative, and a caller that wants
 * the per-field answer has to ask about the write itself.
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

  const kind = platformKindOf(row);
  const inputs = storageInputs(ctx.storage, (name) =>
    kind === null
      ? row.data?.fields?.[name]?.value
      : (systemValueField(row, kind, name) ?? undefined),
  );
  const resolution = await resolveRule(kind, row.model, id, verb, NO_WRITTEN, {
    ...inputs,
    resolveModel: async (entityId) => (await inputs.exists(entityId))?.model ?? null,
    // The query path sees committed state only, so both reads agree.
    groupSetFor: async (entityId) =>
      (await readEntityMemberships(ctx.storage, entityId)).map((m) => m.groupId),
    committedGroupSetFor: async (entityId) =>
      (await readEntityMemberships(ctx.storage, entityId)).map((m) => m.groupId),
  });
  const decision = decideRule(
    resolution,
    { rowSubject: rowSubject(kind, row.model), subjectId: id },
    permissionsFor,
  );
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
 * Parse a `"<subject>.<verb>"` permission string into the rule's two parts.
 * The verb is the segment after the last dot, so a subject containing dots
 * or a `/` survives. Throws a `TypeError` on a malformed string — this is a
 * programming error, not a permission outcome.
 */
const parsePermission = (permission: string): { subject: string; verb: PermissionVerb } => {
  const parsed = splitPermission(permission);
  if (parsed === null || !isVerb(parsed.verb)) {
    throw new TypeError(
      `can(): expected "<subject>.<verb>" with verb one of create/update/delete, got "${permission}"`,
    );
  }
  return { subject: parsed.subject, verb: parsed.verb };
};
