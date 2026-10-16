/**
 * The operation vocabulary: a pure, synchronous description of one
 * client mutation. An {@link Operation} receives an {@link OpContext}
 * (ids, handles, the registry — no storage reads) and the planner's
 * resolved input, and returns the wire Updates it would emit together
 * with the group set those Updates fan out to.
 *
 * Keeping the mutation as a value (rather than a method that submits)
 * is what lets the imperative namespaces and `client.atomic` /
 * `defineAction` share one planner, and what lets the committer wrap
 * a batch in a single Action while enforcing #127's coherence rule.
 */

import { generateId, type Update } from "@ebbjs/core";

import type { EntityRegistry } from "../schema/entity-registry";
import { EntityValidationError, validatePayload } from "../schema/entity-registry";
import { GROUPS_ACCESSOR } from "../schema/system-entities";
import { buildInitialContentField } from "../fields/collaborative-text/wire";
import { DOC_CONTENT_FIELD, generatedDocEntityName } from "../fields/collaborative-text/schema";
import type { Rejection } from "./types";
import {
  buildEntityGroupUpdates,
  buildManyEntityUpdate,
  collectManyTargetIds,
  buildRelationshipUpdate,
  buildRelationshipWrite,
  type ManyPointerValue,
  type PointerValue,
} from "./relationship";

/**
 * Refusal of an atomic call: a client-side coherence failure, or the
 * server's `rejected[]` for the submitted Action. Extends the wire
 * `Rejection` with the per-Update `subjectType` the client-side
 * coherence check can attribute, which the server's per-Action report
 * does not carry today.
 */
export type AtomicRejection = Rejection & { readonly subjectType?: string };

/**
 * Aggregated refusal of an atomic call. Mirrors
 * `EntityValidationError` — same `Error` shape, named subclass,
 * structured readonly reasons, message formatted from them.
 *
 * Thrown before submission for a coherence failure, so no Action
 * reaches the outbox.
 */
export class AtomicActionError extends Error {
  readonly rejections: readonly AtomicRejection[];

  constructor(rejections: readonly AtomicRejection[]) {
    super(formatRejections(rejections));
    this.name = "AtomicActionError";
    this.rejections = rejections;
  }
}

const formatRejections = (rejections: readonly AtomicRejection[]): string => {
  if (rejections.length === 0) return "AtomicActionError";
  const lines = rejections.map((rejection) => `  - ${describeRejection(rejection)}`);
  return `AtomicActionError: ${rejections.length} rejected update(s)\n${lines.join("\n")}`;
};

const describeRejection = (rejection: AtomicRejection): string => {
  const subject =
    rejection.subjectType === undefined ? rejection.id : `${rejection.subjectType} ${rejection.id}`;
  const details =
    rejection.details === undefined || rejection.details === null ? "" : ` (${rejection.details})`;
  return `${subject}: ${rejection.reason}${details}`;
};

/** Mints the ids and clock stamps an operation consumes. */
export interface OperationIds {
  /** Mint a fresh entity id (`e_…`). */
  entityId(): string;
  /** Mint a fresh Update id (`u_…`). */
  updateId(): string;
  /** Advance the local clock and return a fresh HLC timestamp. */
  hlc(): string;
}

/** One marked draft handle, addressable by its entity id. */
export type OperationHandle = { readonly id: string } & Record<string, unknown>;

/**
 * The handle registry a batch accumulates. `idOf` answers "which
 * entity does this value name" only for handles this batch created;
 * anything else (a plain string id, a materialized entity) is null.
 */
export interface OperationHandles {
  register(handle: OperationHandle): void;
  idOf(value: unknown): string | null;
}

/**
 * What an operation may consult. Pure values only — no storage, no
 * network: an operation that needs a read is a planner concern that
 * hands the resolved value to a pure operation.
 */
export interface OpContext {
  readonly registry: EntityRegistry;
  readonly ids: OperationIds;
  readonly handles: OperationHandles;
  /** Local actor id; collaborative-text run ids embed it. */
  readonly actorId: string;
}

/** Whose write this is — the named entity, not the relationship row. */
export interface OperationSubject {
  readonly id: string;
  readonly type: string;
}

/** The wire description of one operation's effect. */
export interface OperationResult {
  readonly updates: readonly Update[];
  /** The fan-out scope of these Updates; the committer compares these. */
  readonly groups: readonly string[];
  /** Marked draft handle this operation created, when it created one. */
  readonly handle?: OperationHandle;
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

const ATOMIC_HANDLE = Symbol.for("@ebbjs/atomic-handle");

const isAtomicHandle = (value: unknown): value is OperationHandle =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<symbol, unknown>)[ATOMIC_HANDLE] === true;

/** Stamp a create handle so later reference resolution recognises it. */
export const markHandle = <T extends Record<string, unknown>>(handle: T): T => {
  Object.defineProperty(handle, ATOMIC_HANDLE, { value: true, enumerable: false });
  return handle;
};

export { isAtomicHandle };

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
 * and collapsing references. `handle` is the already-marked draft
 * handle the atomic planner handed back to its callback, threaded
 * through so the op reports the same object.
 */
export interface CreateEntityInput {
  readonly entity: string;
  readonly id: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly pointers?: readonly ResolvedPointer[];
  /** Derived collaborative-text bodies, keyed by field. */
  readonly bodies?: Readonly<Record<string, string>>;
  readonly groups: readonly string[];
  readonly validate?: boolean;
  readonly handle?: OperationHandle;
}

/**
 * Create one entity: the entity `put`, one `entityGroup` row per
 * group, then one document entity + edge + membership set per derived
 * collaborative-text body, then one Relationship `put` per resolved
 * pointer. Field validation runs here (never partially) unless the
 * caller opted out.
 */
export const createEntity: Operation<CreateEntityInput> = (ctx, input) => {
  const groups = [...input.groups];
  const updates: Update[] = [];

  const def = ctx.registry.get(input.entity);
  if (input.validate !== false && def !== undefined) {
    const violations = validatePayload(def.shape, input.fields, input.entity, false);
    if (violations.length > 0) {
      throw new EntityValidationError(violations);
    }
  }

  const updateId = ctx.ids.updateId();
  const hlc = ctx.ids.hlc();
  updates.push({
    id: updateId,
    subject_id: input.id,
    subject_type: input.entity,
    method: "put",
    data: { fields: wrapFields(input.fields, updateId, hlc) },
  });
  updates.push(...buildEntityGroupUpdates(input.id, groups, () => ctx.ids.updateId()));

  // A derived body creates its own document entity, the edge from the
  // parent, and the document's membership rows in the same batch, so
  // the body and the parent commit atomically.
  for (const [field, text] of Object.entries(input.bodies ?? {})) {
    const docEntity =
      ctx.registry.getRelationship(input.entity, field)?.target.name ??
      generatedDocEntityName(input.entity, field);
    const docId = ctx.ids.entityId();
    const docUpdateId = ctx.ids.updateId();
    const docHlc = ctx.ids.hlc();
    updates.push({
      id: docUpdateId,
      subject_id: docId,
      subject_type: docEntity,
      method: "put",
      data: {
        fields: {
          [DOC_CONTENT_FIELD]: buildInitialContentField(text, docHlc, ctx.actorId, docUpdateId),
        },
      },
    });
    updates.push(
      buildRelationshipUpdate({
        relationshipId: generateId("rel"),
        sourceId: input.id,
        targetId: docId,
        field,
        type: input.entity,
        updateId: ctx.ids.updateId(),
      }),
    );
    updates.push(...buildEntityGroupUpdates(docId, groups, () => ctx.ids.updateId()));
  }

  for (const pointer of input.pointers ?? []) {
    updates.push(
      buildRelationshipUpdate({
        relationshipId: generateId("rel"),
        sourceId: input.id,
        targetId: pointer.targetId,
        field: pointer.as,
        type: pointer.type,
        updateId: ctx.ids.updateId(),
      }),
    );
  }

  return {
    updates,
    groups,
    handle: input.handle ?? markHandle({ id: input.id, ...input.fields, ...input.bodies }),
    subject: { id: input.id, type: input.entity },
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
  const hlc = ctx.ids.hlc();
  const updateId = ctx.ids.updateId();
  return {
    updates: [
      {
        id: updateId,
        subject_id: input.id,
        subject_type: input.entity,
        method: "patch",
        data: { fields: wrapFields(input.payload, updateId, hlc) },
      },
    ],
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

/** Soft-delete an entity: one `delete` Update whose `data` is `null`. */
export const deleteEntity: Operation<DeleteEntityInput> = (ctx, input) => ({
  updates: [
    {
      id: ctx.ids.updateId(),
      subject_id: input.id,
      subject_type: input.entity,
      method: "delete",
      data: null,
    },
  ],
  groups: [...input.groups],
  subject: { id: input.id, type: input.entity },
});

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
   * `subject_id` the one-cardinality delete must name. The namespace
   * resolves the existing relationship row's id (a storage read) and
   * passes it in.
   */
  readonly relationshipSubjectId?: string;
  /** The source entity's live membership set. */
  readonly groups: readonly string[];
}

/**
 * Link, unlink, or set the links of one relationship. The built-in
 * membership accessor is refused (membership verbs own it), and an
 * undeclared relationship is refused before any wire Update exists.
 * Many-cardinality emits the source's canonical-FK `put` plus one
 * Relationship `put` per target; one-cardinality emits a single
 * Relationship `put` (or `delete`).
 */
export const writeRelationship: Operation<WriteRelationshipInput> = (ctx, input) => {
  const { entity, sourceId, as } = input;
  if (as === GROUPS_ACCESSOR) {
    throw new EntityValidationError([
      {
        entityName: entity,
        message: `link/unlink/setLinks: "${GROUPS_ACCESSOR}" is the built-in membership accessor; use addToGroup/removeFromGroup/setGroups instead`,
      },
    ]);
  }
  const rel = ctx.registry.getRelationship(entity, as);
  if (rel === undefined) {
    throw new EntityValidationError([
      {
        entityName: entity,
        message: `submitRelationshipWrite: relationship "${as}" is not declared on entity "${entity}"`,
      },
    ]);
  }

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
    as,
    sourceId,
    entityUpdate,
    relationshipSubjectId: input.relationshipSubjectId,
    targetId: input.pointer.targetId,
    targetIds: input.pointer.targetIds,
  });
  const relationshipUpdates = Array.isArray(result.relationshipUpdate)
    ? result.relationshipUpdate
    : [result.relationshipUpdate];
  const updates: Update[] = [];
  if (result.entityUpdate !== undefined) updates.push(result.entityUpdate);
  for (const update of relationshipUpdates) updates.push(update);

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

/**
 * Flatten a payload into the wire envelope. `undefined` fields are
 * dropped (the wire envelope is absent, not explicitly undefined);
 * `null` is preserved so nullable fields round-trip cleanly.
 */
export const wrapFields = (
  payload: unknown,
  updateId: string,
  hlc: string,
): Record<string, { value: unknown; update_id: string; hlc: string }> => {
  const out: Record<string, { value: unknown; update_id: string; hlc: string }> = {};
  if (payload === null || typeof payload !== "object") return out;
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    out[key] = { value, update_id: updateId, hlc };
  }
  return out;
};
