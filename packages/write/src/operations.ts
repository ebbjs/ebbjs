/**
 * The operation vocabulary: a pure, synchronous description of one
 * client mutation. An {@link Operation} receives an {@link OpContext}
 * (ids, the registry, the actor — no storage reads) and the planner's
 * resolved input, and returns the wire Updates it would emit together
 * with the group set those Updates fan out to.
 *
 * Keeping the mutation as a value (rather than a method that submits)
 * is what lets the draft planner, `defineAction`, and the seed path
 * share one write path, and what lets the committer wrap a batch in a
 * single Action.
 */

import {
  componentName,
  EBB_COMPONENT_KINDS,
  EBB_MODEL_NAME,
  ebbComponent,
  generateId,
  isFieldMap,
  isUnset,
  type EbbComponentKind,
  type Entity,
  type FieldValue,
  type Update,
} from "@ebbjs/core";
import {
  EntityValidationError,
  findNestedUnsetPath,
  GROUPS_ACCESSOR,
  isPlainObject,
  nestedUnsetMessage,
  validatePayload,
  type ModelRegistry,
  type FieldMarker,
} from "@ebbjs/schema";

import { projectFieldValue } from "./field-projection";
import { lastMembershipViolation, membershipScope, type MembershipView } from "./membership";
import type { PointerValue } from "./pointer";
import type { Rejection } from "./rejection";
import {
  buildEntityGroupDelete,
  buildEntityGroupUpdates,
  buildManyEntityUpdate,
  collectManyTargetIds,
  buildRelationshipUpdate,
  buildRelationshipWrite,
  type ManyPointerValue,
} from "./relationship";
import { systemRowUpdate } from "./system-rows";

/**
 * Refusal of an Action: a client-side membership failure
 * (`last_membership` / `missing_ownership` / `last_group_member`), or the
 * server's `rejected[]` for the submitted Action. Extends the wire
 * `Rejection` with the per-Update model the client-side checks can attribute,
 * which the server's per-Action report does not carry today.
 */
export type ActionRejection = Rejection & { readonly model?: string };

/**
 * Aggregated refusal of an Action. Mirrors `EntityValidationError` —
 * same `Error` shape, named subclass, structured readonly reasons,
 * message formatted from them.
 *
 * Thrown before submission for a client-side membership failure, so no
 * Action reaches the outbox, and after submission for a server
 * rejection so every action surface fails the one way.
 */
export class ActionRejectedError extends Error {
  readonly rejections: readonly ActionRejection[];

  constructor(rejections: readonly ActionRejection[]) {
    super(formatRejections(rejections));
    this.name = "ActionRejectedError";
    this.rejections = rejections;
  }
}

/**
 * The client-provable `last_group_member` refusal: a grant (`ebb/grant`)
 * delta that would leave its group with no member holding a non-empty
 * permission list.
 */
export const lastGroupMemberError = (id: string, details: string): ActionRejectedError =>
  new ActionRejectedError([
    { id, model: ebbComponent("grant"), reason: "last_group_member", details },
  ]);

const formatRejections = (rejections: readonly ActionRejection[]): string => {
  if (rejections.length === 0) return "ActionRejectedError";
  const lines = rejections.map((rejection) => `  - ${describeRejection(rejection)}`);
  return `ActionRejectedError: ${rejections.length} rejected update(s)\n${lines.join("\n")}`;
};

const describeRejection = (rejection: ActionRejection): string => {
  const subject =
    rejection.model === undefined ? rejection.id : `${rejection.model} ${rejection.id}`;
  const details =
    rejection.details === undefined || rejection.details === null ? "" : ` (${rejection.details})`;
  return `${subject}: ${rejection.reason}${details}`;
};

/** Mints the ids and clock stamps an operation consumes. */
export interface OperationIds {
  /** Mint a fresh Update id (`u_…`). */
  updateId(): string;
  /** Advance the local clock and return a fresh HLC timestamp. */
  hlc(): string;
  /**
   * Mint an id of a non-Update row the batch addresses — a link row, say. A
   * seam rather than a direct `generateId` call so a caller that needs a
   * deterministic batch (the function runtime's reference fixtures) can
   * control every id the planner emits.
   */
  newId(prefix: string): string;
}

/**
 * What an operation may consult. Pure values only — no storage, no
 * network: an operation that needs a read is a planner concern that
 * hands the resolved value to a pure operation. Draft handles are not
 * here: the draft planner mints and resolves them before an operation
 * runs.
 */
export interface OpContext {
  readonly registry: ModelRegistry;
  readonly ids: OperationIds;
  /** Local actor id; collaborative-text run ids embed it. */
  readonly actorId: string;
}

/** Whose write this is — the named entity, not the link row. */
export interface OperationSubject {
  readonly id: string;
  readonly type: string;
}

/** The wire description of one operation's effect. */
export interface OperationResult {
  readonly updates: readonly Update[];
  /** The fan-out scope of these Updates; the committer compares these. */
  readonly groups: readonly string[];
  /** Diagnostics: the entity this write is attributed to. */
  readonly subject?: OperationSubject;
}

/** A pure, synchronous mutation. */
export type Operation<I = unknown> = (ctx: OpContext, input: I) => OperationResult;

/**
 * One operation bound to its resolved input. Erased to `never` so a
 * batch can hold operations of different input types while the
 * committer still runs each one with the input it was built from.
 */
export interface OperationCall {
  readonly operation: Operation<never>;
  readonly input: never;
}

/** Bind an operation to its input without running it. */
export const call = <I>(operation: Operation<I>, input: I): OperationCall => ({
  operation,
  input: input as never,
});

/**
 * One resolved relationship edge: the accessor name, the wire
 * relationship type, and the target entity id. The planner collapses
 * handles / entity shapes to ids before building these.
 */
export interface ResolvedPointer {
  readonly as: string;
  readonly type: string;
  readonly targetId: string;
}

/**
 * Input for {@link createEntity}. Field values are already-resolved
 * wire values (handles collapsed); the planner owns minting the id
 * and collapsing references.
 */
export interface CreateEntityInput {
  readonly entity: string;
  readonly id: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly pointers?: readonly ResolvedPointer[];
  readonly groups: readonly string[];
  readonly validate?: boolean;
}

/**
 * The one platform kind a value map names.
 *
 * A platform row carries exactly one of the four components: each names a
 * different kind of row, so a write naming two would be two kinds on one row
 * and a write naming none would be a row with no kind. Both are refused before
 * any Update exists.
 */
const platformKindOf = (
  entity: string,
  values: Record<string, unknown>,
): EbbComponentKind | null => {
  if (entity !== EBB_MODEL_NAME) return null;
  const named = EBB_COMPONENT_KINDS.filter((kind) => values[kind] !== undefined);
  if (named.length === 1) return named[0]!;
  const got = named.length === 0 ? "none" : named.map(ebbComponent).join(", ");
  const allowed = EBB_COMPONENT_KINDS.map(ebbComponent).join(", ");
  throw new EntityValidationError([
    {
      entityName: entity,
      message: `a platform row carries exactly one component (${allowed}); got ${got}`,
    },
  ]);
};

/** The one platform component a create names, with its value narrowed to an object. */
const platformComponentOf = (
  entity: string,
  values: Readonly<Record<string, unknown>>,
): { kind: EbbComponentKind; value: Readonly<Record<string, unknown>> } | null => {
  const kind = platformKindOf(entity, values);
  if (kind === null) return null;
  const value = values[kind];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EntityValidationError([
      {
        entityName: entity,
        field: kind,
        message: `"${ebbComponent(kind)}" takes one object value`,
      },
    ]);
  }
  return { kind, value: value as Readonly<Record<string, unknown>> };
};

/**
 * Create one entity: one `replace` per leaf component (a keyed component
 * merges, because `replace` is refused for a key space), one membership row
 * per group, then one link row per resolved pointer. Field validation runs
 * here (never partially) unless the caller opted out.
 *
 * A platform row (`ebb`) is one atomic component, so it takes the platform
 * path: exactly one `ebb/*` component, validated as a whole value.
 */
export const createEntity: Operation<CreateEntityInput> = (ctx, input) => {
  const groups = [...input.groups];
  const updates: Update[] = [];

  const platform = platformComponentOf(input.entity, input.fields);
  const def = ctx.registry.get(input.entity);
  if (input.validate !== false && def !== undefined) {
    const violations = validatePayload(def.createShape, input.fields, input.entity, false);
    if (violations.length > 0) {
      throw new EntityValidationError(violations);
    }
  }

  if (platform !== null) {
    updates.push(systemRowUpdate(platform.kind, input.id, platform.value, ctx.ids));
  } else {
    updates.push(
      ...componentUpdates(
        input.id,
        input.entity,
        input.fields,
        { updateId: () => ctx.ids.updateId(), hlc: ctx.ids.hlc() },
        def?.markers,
        "replace",
      ),
    );
  }
  updates.push(...buildEntityGroupUpdates(input.id, groups, ctx.ids));

  for (const pointer of input.pointers ?? []) {
    updates.push(
      ...buildRelationshipUpdate({
        relationshipId: ctx.ids.newId("rel"),
        sourceId: input.id,
        targetId: pointer.targetId,
        field: pointer.as,
        type: pointer.type,
        updateId: ctx.ids.updateId(),
        hlc: () => ctx.ids.hlc(),
      }),
    );
  }

  return {
    updates,
    groups,
    subject: { id: input.id, type: input.entity },
  };
};

/** The local view a platform-row write resolves against: no cached membership. */
const EMPTY_MEMBERSHIP_VIEW: MembershipView = {
  groupsOf: () => [],
  groupOfMembership: () => undefined,
};

/** Input for {@link createSystemEntity}. */
export interface CreateSystemEntityInput {
  /** Which of the four platform components the row carries. */
  readonly kind: EbbComponentKind;
  readonly id: string;
  /** The component's whole value; an atomic value has no partial write. */
  readonly value: Readonly<Record<string, unknown>>;
  readonly validate?: boolean;
}

/**
 * Create one platform row: one `ebb/*` Update carrying the component's whole
 * value. The row's fan-out scope comes from the value itself (`ebb/group` is
 * its own group; `ebb/grant` and `ebb/membership` name their `group_id`), so no
 * cached membership view is consulted.
 *
 * Validation checks the whole value against the component's object shape: a
 * value missing a required field is refused rather than written as a partial.
 */
export const createSystemEntity: Operation<CreateSystemEntityInput> = (ctx, input) => {
  const def = ctx.registry.get(EBB_MODEL_NAME);
  const shape = def?.components?.[input.kind]?.shape;
  if (input.validate !== false && shape !== undefined) {
    const violations = validatePayload(shape, input.value, EBB_MODEL_NAME, false);
    if (violations.length > 0) {
      throw new EntityValidationError(violations);
    }
  }
  const updates = [systemRowUpdate(input.kind, input.id, input.value, ctx.ids)];
  return {
    updates,
    groups: membershipScope(updates, EMPTY_MEMBERSHIP_VIEW),
    subject: { id: input.id, type: EBB_MODEL_NAME },
  };
};

/** Input for {@link createGroup}. */
export interface CreateGroupInput {
  readonly groupId: string;
  readonly memberId: string;
  readonly name: string;
  readonly permissions: readonly string[];
  /** Local app label; a created group is scoped to it when set. */
  readonly appId?: string;
  readonly validate?: boolean;
}

/**
 * The canonical group bootstrap: the `ebb/group` put plus the acting actor's
 * own `ebb/grant` put carrying the caller-derived permission wildcards, in one
 * Action. A group is its own group, so no membership row is emitted for it.
 */
export const createGroup: Operation<CreateGroupInput> = (ctx, input) => {
  const groupValue: Record<string, unknown> = { name: input.name };
  // Absent scope is every app; the creating app's scope is the one it names.
  if (input.appId !== undefined) groupValue.apps = [input.appId];

  const group = createSystemEntity(ctx, {
    kind: "group",
    id: input.groupId,
    value: groupValue,
    validate: input.validate,
  });
  const member = createSystemEntity(ctx, {
    kind: "grant",
    id: input.memberId,
    value: {
      group_id: input.groupId,
      actor_id: ctx.actorId,
      permissions: [...input.permissions],
    },
    validate: input.validate,
  });
  return {
    updates: [...group.updates, ...member.updates],
    groups: [...new Set([...group.groups, ...member.groups])],
    subject: { id: input.groupId, type: EBB_MODEL_NAME },
  };
};

/**
 * The permissions a bootstrapping actor needs to operate on every registered
 * entity. The server matches only an exact `<subject>.<verb>` or
 * `<subject>.*`, so the actor's own grant carries one wildcard per permission
 * subject rather than a global `*` that grants nothing.
 *
 * A subject is a model, except where a component declares its own permission:
 * the four platform components do, so the platform model contributes
 * `ebb/group.*`, `ebb/grant.*`, `ebb/membership.*` and `ebb/link.*` rather than
 * one `ebb.*`. The model subject is granted as well, because a row `delete`
 * names no component and is authorized against the row's committed model.
 */
export const fullGroupPermissions = (registry: ModelRegistry): readonly string[] => {
  const subjects = new Set<string>();
  for (const name of registry.modelNames()) {
    subjects.add(name);
    for (const component of registry.componentsOf(name)) {
      subjects.add(registry.permissionOf(name, component.name));
    }
  }
  return [...subjects].sort().map((subject) => `${subject}.*`);
};

/** The ids and call the group bootstrap shares across both authoring surfaces. */
export interface GroupBootstrap {
  readonly groupId: string;
  readonly memberId: string;
  readonly call: OperationCall;
}

/**
 * Mint the ids and build the bootstrap call for the draft surface's
 * `group.create`, which lands the group and its first member in one
 * Action.
 */
export const groupBootstrap = (
  registry: ModelRegistry,
  name: string,
  validate?: boolean,
  appId?: string,
): GroupBootstrap => {
  const groupId = generateId("e");
  const memberId = generateId("e");
  return {
    groupId,
    memberId,
    call: call(createGroup, {
      groupId,
      memberId,
      name,
      permissions: fullGroupPermissions(registry),
      validate,
      appId,
    }),
  };
};

/** Input for {@link patchEntity}. */
export interface PatchEntityInput {
  readonly entity: string;
  readonly id: string;
  readonly payload: unknown;
  /** Membership set the write fans out to; empty when locally unknown. */
  readonly groups: readonly string[];
  readonly validate?: boolean;
}

/**
 * Patch an existing entity. Validation is per-field (a partial shape)
 * and refuses an empty patch, mirroring `create`'s stricter
 * counterpart.
 */
export const patchEntity: Operation<PatchEntityInput> = (ctx, input) => {
  const def = ctx.registry.get(input.entity);
  const platformKind = isPlainObject(input.payload)
    ? platformKindOf(input.entity, input.payload)
    : null;
  if (input.validate !== false && def !== undefined) {
    const violations = validatePayload(def.shape, input.payload, input.entity, true);
    if (violations.length > 0) {
      throw new EntityValidationError(violations);
    }
    if (isEmptyPayload(input.payload)) {
      throw new EntityValidationError([
        { entityName: input.entity, message: `update: patch must contain at least one field` },
      ]);
    }
  }
  return {
    updates: componentUpdates(
      input.id,
      input.entity,
      input.payload,
      { updateId: () => ctx.ids.updateId(), hlc: ctx.ids.hlc() },
      def?.markers,
      // A platform component's value is one merge position, so a patch replaces
      // the whole value rather than merging per key.
      platformKind === null ? "merge" : "replace",
    ),
    groups: [...input.groups],
    subject: { id: input.id, type: input.entity },
  };
};

/** Input for {@link deleteEntity}. */
export interface DeleteEntityInput {
  readonly entity: string;
  readonly id: string;
  /** Membership set the write fans out to; empty when locally unknown. */
  readonly groups: readonly string[];
}

/** Soft-delete an entity: one `delete` Update, naming no component. */
export const deleteEntity: Operation<DeleteEntityInput> = (ctx, input) => ({
  updates: [
    {
      id: ctx.ids.updateId(),
      subject_id: input.id,
      method: "delete",
      data: null,
    },
  ],
  groups: [...input.groups],
  subject: { id: input.id, type: input.entity },
});

/** Input for {@link dropEntity}. */
export interface DropEntityInput {
  readonly entity: string;
  readonly id: string;
  /** Components to detach, by the row field each attaches under. */
  readonly fields: readonly string[];
  /** Membership set the write fans out to; empty when locally unknown. */
  readonly groups: readonly string[];
}

/**
 * Detach one or more components from a row: one `drop` Update per named field.
 *
 * Dropping the last component is **not** a delete — the row keeps its id, its
 * type and its existence, and simply carries nothing. A drop takes no value,
 * so it names components rather than a patch payload; `unset` in a patch
 * still means "clear the position" (a tombstone), which is a different write.
 *
 * Refused before any Update exists: an empty field list, a component the model
 * does not declare, and a platform component. A platform row is one atomic
 * component, so detaching it would leave a row with no kind; removing a
 * platform row is a delete.
 */
export const dropEntity: Operation<DropEntityInput> = (ctx, input) => {
  if (input.entity === EBB_MODEL_NAME) {
    throw new EntityValidationError([
      {
        entityName: input.entity,
        message: `drop: "${input.entity}" is the platform model and a platform row carries one atomic component; removing it is a delete, not a drop`,
      },
    ]);
  }
  // Unlike a patch's empty-payload check, this is not behind `validate`:
  // a no-op drop is a caller bug whether or not validation ran.
  if (input.fields.length === 0) {
    throw new EntityValidationError([
      { entityName: input.entity, message: `drop: must name at least one component` },
    ]);
  }
  const def = ctx.registry.get(input.entity);
  if (def !== undefined) {
    for (const field of input.fields) {
      if (def.components[field] === undefined) {
        throw new EntityValidationError([
          {
            entityName: input.entity,
            field,
            message: `drop: component "${field}" is not declared on entity "${input.entity}"`,
          },
        ]);
      }
    }
  }
  return {
    updates: dropComponents(input.id, input.entity, input.fields, {
      updateId: () => ctx.ids.updateId(),
    }),
    groups: [...input.groups],
    subject: { id: input.id, type: input.entity },
  };
};

/** Input for {@link duplicateEntity}. */
export interface DuplicateEntityInput {
  readonly entity: string;
  /** The new row's id; the source row is never named on the wire. */
  readonly subjectId: string;
  /** The row to copy, already read from the current or pre-sync view. */
  readonly source: Entity;
  readonly groups: readonly string[];
  readonly validate?: boolean;
}

/**
 * Copy a source row onto a fresh id: one Update per component carrying the
 * values verbatim — leaf and nested `update_id` / `hlc` stamps included, so a
 * collaborative-text map survives as a reference snapshot rather than a
 * re-stamped write — plus one membership row per group. A leaf component is
 * a `replace`, a keyed one a `merge`. A platform row's copy is its one
 * `ebb/*` component. The copy is validated against the entity's shape like
 * `create`.
 */
export const duplicateEntity: Operation<DuplicateEntityInput> = (ctx, input) => {
  const fields = input.source.data?.fields ?? {};
  const def = ctx.registry.get(input.entity);
  if (input.validate !== false && def !== undefined) {
    // A copy validates the live values it carries; absence in the source
    // row is normal, so this is a partial check like an update.
    const violations = validatePayload(def.shape, projectFieldValues(fields), input.entity, true);
    if (violations.length > 0) {
      throw new EntityValidationError(violations);
    }
  }
  return {
    updates: [
      ...Object.entries(fields).map(([field, value]): Update => {
        const updateId = ctx.ids.updateId();
        return {
          id: updateId,
          subject_id: input.subjectId,
          component: componentName(input.entity, field),
          method: isFieldMap(value) ? "merge" : "replace",
          data: cloneFieldValue(value),
        };
      }),
      ...buildEntityGroupUpdates(input.subjectId, input.groups, ctx.ids),
    ],
    groups: [...input.groups],
    subject: { id: input.subjectId, type: input.entity },
  };
};

/**
 * Project a wire field map to the plain values the schema validator checks.
 * Tombstoned and absent leaves are omitted: a copy carries absence forward
 * rather than asserting a null.
 */
const projectFieldValues = (fields: Record<string, FieldValue>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    const value = projectFieldValue(field);
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
};

/** Deep-clone a wire field value so the copy never aliases the source's objects. */
const cloneValue = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = cloneValue(entry);
  return out;
};

const cloneFieldValue = (field: FieldValue): FieldValue =>
  isFieldMap(field)
    ? {
        map: Object.fromEntries(Object.entries(field.map).map(([k, v]) => [k, cloneFieldValue(v)])),
      }
    : { ...field, value: cloneValue(field.value) };

/** One membership row to delete: its id and the group it scopes to. */
export interface MembershipRemoval {
  readonly membershipId: string;
  readonly groupId: string;
}

/** Input for {@link changeGroups}. */
export interface ChangeGroupsInput {
  readonly entity: string;
  readonly entityId: string;
  /** Groups to add; one membership put each. */
  readonly puts?: readonly string[];
  /** Membership rows to delete; one delete each. */
  readonly removes?: readonly MembershipRemoval[];
  /**
   * The entity's live cached group ids, when the caller read them.
   * Enables the client-side `last_membership` refusal; absent when the
   * local view cannot say whether the entity is unowned.
   */
  readonly currentGroups?: readonly string[];
}

/**
 * Add, remove, or replace an entity's membership rows in one operation.
 * Adds precede removes so an incremental observer never sees the entity
 * with an empty membership set mid-Action. The fan-out scope is the union
 * of every affected group, resolved by the membership checker from the
 * Updates themselves.
 */
export const changeGroups: Operation<ChangeGroupsInput> = (ctx, input) => {
  const puts = input.puts ?? [];
  const removes = input.removes ?? [];
  const updates: Update[] = [...buildEntityGroupUpdates(input.entityId, puts, ctx.ids)];

  updates.push(
    ...removes.map((removal) =>
      buildEntityGroupDelete({
        membershipId: removal.membershipId,
        updateId: ctx.ids.updateId(),
      }),
    ),
  );

  const violation = lastMembershipViolation(input.currentGroups, {
    puts,
    removedGroups: removes.map((removal) => removal.groupId),
  });
  if (violation !== undefined) {
    throw new ActionRejectedError([
      {
        id: input.entityId,
        model: input.entity,
        reason: "last_membership",
        details: violation,
      },
    ]);
  }

  const removeByMembershipId = new Map(
    removes.map((removal) => [removal.membershipId, removal.groupId]),
  );
  const view: MembershipView = {
    groupsOf: (entityId) => (entityId === input.entityId ? (input.currentGroups ?? []) : []),
    groupOfMembership: (membershipId) => removeByMembershipId.get(membershipId),
  };
  const groups = membershipScope(updates, view).filter((groupId) => groupId.length > 0);
  if (updates.length > 0 && groups.length === 0) {
    throw new ActionRejectedError([
      {
        id: input.entityId,
        model: input.entity,
        reason: "missing_ownership",
        details: `membership write for "${input.entityId}" resolves to no owning group`,
      },
    ]);
  }

  return {
    updates,
    groups,
    subject: { id: input.entityId, type: input.entity },
  };
};

/** The pointer shape a relationship write carries per cardinality. */
export interface RelationshipPointer {
  readonly targetId?: PointerValue;
  readonly targetIds?: ManyPointerValue;
}

/** Input for {@link writeRelationship}. */
export interface WriteRelationshipInput {
  readonly entity: string;
  readonly sourceId: string;
  readonly as: string;
  readonly pointer: RelationshipPointer;
  /**
   * `subject_id` the one-cardinality delete must name. The draft
   * planner resolves the existing link row's id (a storage read) and
   * passes it in.
   */
  readonly relationshipSubjectId?: string;
  /** The source entity's live membership set. */
  readonly groups: readonly string[];
}

/** A relationship definition resolved through the registry. */
export type DeclaredRelationship = NonNullable<ReturnType<ModelRegistry["getRelationship"]>>;

/**
 * Resolve a declared relationship, refusing the built-in membership
 * accessor (membership verbs own it) and an undeclared accessor before any
 * wire Update exists. Shared by every relationship-writing path so the
 * refusals and their messages have one definition.
 */
export const requireRelationship = (
  registry: ModelRegistry,
  entity: string,
  as: string,
): DeclaredRelationship => {
  if (as === GROUPS_ACCESSOR) {
    throw new EntityValidationError([
      {
        entityName: entity,
        message: `link/unlink/setLinks: "${GROUPS_ACCESSOR}" is the built-in membership accessor; use addToGroup/removeFromGroup/setGroups instead`,
      },
    ]);
  }
  const rel = registry.getRelationship(entity, as);
  if (rel === undefined) {
    throw new EntityValidationError([
      {
        entityName: entity,
        message: `submitRelationshipWrite: relationship "${as}" is not declared on entity "${entity}"`,
      },
    ]);
  }
  return rel;
};

/**
 * Link, unlink, or set the links of one relationship. The built-in
 * membership accessor is refused (membership verbs own it), and an
 * undeclared relationship is refused before any wire Update exists.
 * Many-cardinality emits the source's canonical-FK component merge plus one
 * link Update per target; one-cardinality emits one link Update (or a
 * `delete`).
 */
export const writeRelationship: Operation<WriteRelationshipInput> = (ctx, input) => {
  const { entity, sourceId, as } = input;
  const rel = requireRelationship(ctx.registry, entity, as);

  let entityUpdate: Update | undefined;
  if (rel.sourceCardinality === "many" && input.pointer.targetIds !== undefined) {
    const updateId = ctx.ids.updateId();
    entityUpdate = buildManyEntityUpdate({
      sourceId,
      sourceEntityName: entity,
      as,
      targetIds: collectManyTargetIds(input.pointer.targetIds),
      updateId,
      hlc: ctx.ids.hlc(),
    });
  }

  const result = buildRelationshipWrite(ctx.registry, {
    source: { name: entity },
    target: { name: rel.target.name },
    newId: ctx.ids.newId,
    hlc: () => ctx.ids.hlc(),
    as,
    sourceId,
    entityUpdate,
    relationshipSubjectId: input.relationshipSubjectId,
    targetId: input.pointer.targetId,
    targetIds: input.pointer.targetIds,
  });
  const updates: Update[] = [];
  if (result.entityUpdate !== undefined) updates.push(result.entityUpdate);
  updates.push(...result.relationshipUpdates);

  return {
    updates,
    groups: [...input.groups],
    subject: { id: sourceId, type: entity },
  };
};

/** True when the payload is `{}` or every field is `undefined` — a no-op the caller almost certainly didn't intend. */
const isEmptyPayload = (payload: unknown): boolean => {
  if (payload === null || typeof payload !== "object") return true;
  for (const value of Object.values(payload)) {
    if (value !== undefined) return false;
  }
  return true;
};

/** The ids one payload's component writes consume. */
export interface ComponentUpdateIds {
  updateId(): string;
  hlc: string;
}

/** The ids one drop's component Updates consume. */
export interface ComponentDropIds {
  updateId(): string;
}

/**
 * Compile component names into one `drop` Update each, addressed by the
 * `<model>/<field>` leaf rule every other component write uses. A drop
 * carries no value, so `data` is `null` and the field list is the whole
 * payload.
 */
export const dropComponents = (
  subjectId: string,
  model: string,
  fields: readonly string[],
  ids: ComponentDropIds,
): Update[] =>
  fields.map((field) => ({
    id: ids.updateId(),
    subject_id: subjectId,
    component: componentName(model, field),
    method: "drop",
    data: null,
  }));

/**
 * Compile a plain payload into one component Update per field: a keyed
 * component's plain object becomes a `map` value and always merges (a key
 * space cannot be replaced), every other field stays a leaf written with
 * `preferred`.
 *
 * `undefined` fields are dropped (absence, not an explicitly undefined value)
 * and `unset` compiles to a tombstone leaf, the same `{ value: null }` the
 * merge rule has always understood. A literal `null` is passed through:
 * tombstones arrive from other producers (seeding, a peer's write), so the
 * envelope layer must not refuse one; rejecting `null` is validation's job.
 *
 * The registry supplies the merge marker per field. Without one (an
 * unregistered model) every field is a leaf, and the component name is still
 * `<model>/<field>`.
 */
export const componentUpdates = (
  subjectId: string,
  model: string,
  payload: unknown,
  ids: ComponentUpdateIds,
  markers?: { readonly [field: string]: FieldMarker },
  preferred: "merge" | "replace" = "merge",
): Update[] => {
  const updates: Update[] = [];
  if (payload === null || typeof payload !== "object") return updates;
  for (const [field, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    const updateId = ids.updateId();
    const keyed = markers?.[field]?.map === true;
    updates.push({
      id: updateId,
      subject_id: subjectId,
      component: componentName(model, field),
      method: keyed ? "merge" : preferred,
      data: wrapComponentValue(value, field, updateId, ids.hlc, keyed),
    });
  }
  return updates;
};

const wrapComponentValue = (
  value: unknown,
  field: string,
  updateId: string,
  hlc: string,
  keyed: boolean,
): FieldValue => {
  if (isUnset(value)) return { value: null, update_id: updateId, hlc };
  if (keyed && isPlainObject(value)) return wrapMapValue(value, field, updateId, hlc);
  // An object leaf's properties are parts of one value, not positions, so
  // `unset` inside one has no envelope. Refusing here keeps the sentinel off
  // the wire instead of letting it compile to an empty object.
  const nested = findNestedUnsetPath(value, field);
  if (nested !== undefined) throw new Error(nestedUnsetMessage(nested));
  return { value, update_id: updateId, hlc };
};

const wrapMapValue = (
  entries: Record<string, unknown>,
  field: string,
  updateId: string,
  hlc: string,
): FieldValue => ({
  map: Object.fromEntries(
    Object.entries(entries).map(([key, value]) => {
      if (isUnset(value)) return [key, { value: null, update_id: updateId, hlc }];
      // A tombstone is the last permitted depth: one level below the map.
      const nested = findNestedUnsetPath(value, `${field}.${key}`);
      if (nested !== undefined) throw new Error(nestedUnsetMessage(nested));
      return [key, { value, update_id: updateId, hlc }];
    }),
  ),
});
