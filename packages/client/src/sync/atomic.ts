/**
 * `client.atomic(...)` — resolve forward references between entities
 * created in one call and emit exactly one wire-level Action.
 *
 * The callback form receives one draft namespace per schema entity.
 * `draft.create(input)` allocates the entity's id eagerly, records a
 * pending write, and returns a handle carrying the id plus the
 * materialized field values. A value that is itself a handle (or a
 * string id / anything with a string `.id`) under a registered
 * relationship key is substituted with the target's id and emitted as
 * a wire `Relationship` Update — no hand-written relationship
 * boilerplate.
 *
 * Every write collected during the callback is flattened into one
 * `createAction`-shaped batch and submitted through the client's write
 * path, so the server sees a single Action and commits it atomically.
 *
 * The declaration form (`defineAction`) and the permission-coherence
 * check are separate issues (#232, #233); this module is the resolver
 * both consume.
 */

import { generateId, type Update } from "@ebbjs/core";
import type { Static, TObject, TSchema } from "@sinclair/typebox/type";

import type { EntityDef, ShapeFields } from "../schema/entity";
import type { EntityRegistry } from "../schema/entity-registry";
import { EntityValidationError, validatePayload } from "../schema/entity-registry";
import type { Schema } from "../schema/schema";
import { buildRelationshipUpdate, normalizePointer } from "./relationship";
import { resolveGroupIds, wrapFields, type EntityFields, type GroupRef } from "./namespace";
import { GROUPS_ACCESSOR, MEMBERSHIP_KIND } from "../schema/system-entities";
import type { WriteResponse } from "./types";

type AnyEntityDef = EntityDef<Record<string, TSchema>>;

/**
 * Error raised when the resolver cannot turn the collected drafts into
 * a valid batch — a self-referential field value, or a pointer value
 * that isn't a string / entity / handle.
 */
export class AtomicResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtomicResolutionError";
  }
}

/** Handle returned by a draft namespace's `create`. Carries the id eagerly. */
export type CreatedEntity<TFields extends Record<string, TSchema>> = Static<
  TObject<ShapeFields<TFields>>
> & { readonly id: string } & Record<string, unknown>;

/**
 * Input accepted by a draft namespace's `create`. Field values and
 * relationship pointers (a handle, id, or array of either) share one
 * loose record: the resolver distinguishes them by the registry's
 * relationship declarations, and validates the entity fields before
 * submission. Typing the input against the entity shape and the
 * relationship keys is #232's job.
 */
export type AtomicCreateInput = Record<string, unknown>;

/**
 * Options for a draft namespace's `create`. Mirrors the entity
 * namespace's create signature: `groups` is required and non-empty,
 * and one `kind: "member"` edge per group lands in the same Action.
 */
export interface AtomicCreateOptions {
  readonly groups: readonly GroupRef[];
}

/** Per-entity draft surface passed to the `client.atomic` callback. */
export interface AtomicDraftNamespace<TFields extends Record<string, TSchema>> {
  create(input: AtomicCreateInput, opts: AtomicCreateOptions): CreatedEntity<TFields>;
}

/** Draft namespaces keyed by schema entity name. */
export type AtomicDrafts<S> =
  S extends Schema<infer TEntities, unknown>
    ? { [K in keyof TEntities & string]: AtomicDraftNamespace<EntityFields<TEntities[K]>> }
    : Record<string, never>;

/**
 * `client.atomic` surface, present only when the client was built with
 * a `Schema`. `T` is the callback's return value, so the caller reads
 * the eagerly-created handles straight off the awaited result.
 */
export type AtomicClient<S> =
  S extends Schema<Record<string, AnyEntityDef>, unknown>
    ? { atomic<T>(build: (drafts: AtomicDrafts<S>) => T): Promise<T> }
    : // eslint-disable-next-line @typescript-eslint/ban-types
      {};

/**
 * Write-side capability the runtime consumes. The client supplies it
 * so the resolver stays free of the `client → atomic → client` cyclic
 * reference.
 */
export interface AtomicWriteCapability {
  readonly registry: EntityRegistry;
  /** Mint a fresh local HLC for one entity Update's field envelope. */
  freshHlc(): string;
  /** Mint a fresh Update id. */
  generateUpdateId(): string;
  /** Wrap the batch of Updates in one Action and submit it. */
  submitRelationshipUpdates(updates: readonly Update[]): Promise<WriteResponse>;
}

interface PendingPointer {
  readonly as: string;
  readonly type: string;
  readonly kind: string;
  readonly targetId: string;
}

interface PendingWrite {
  readonly entity: string;
  readonly id: string;
  readonly fields: Record<string, unknown>;
  readonly pointers: readonly PendingPointer[];
}

const ATOMIC_HANDLE = Symbol.for("@ebbjs/atomic-handle");

interface AtomicHandle {
  readonly id: string;
  readonly [ATOMIC_HANDLE]: true;
}

const isAtomicHandle = (value: unknown): value is AtomicHandle =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<symbol, unknown>)[ATOMIC_HANDLE] === true;

const markHandle = (handle: Record<string, unknown>): AtomicHandle => {
  Object.defineProperty(handle, ATOMIC_HANDLE, { value: true, enumerable: false });
  return handle as unknown as AtomicHandle;
};

/**
 * Resolve a field value into wire-safe data: atomic handles collapse
 * to their id, arrays and plain objects are walked, everything else
 * passes through. `seen` is the current path, so a value that contains
 * itself is rejected instead of recursing forever. A shared (DAG)
 * reference is fine — only a back-edge is a cycle.
 */
export function resolveReferences(value: unknown, seen: Set<object> = new Set()): unknown {
  if (isAtomicHandle(value)) return value.id;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) {
    throw new AtomicResolutionError("cycle detected while resolving atomic write fields");
  }
  seen.add(value);
  const resolved = Array.isArray(value)
    ? value.map((item) => resolveReferences(item, seen))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, resolveReferences(item, seen)]),
      );
  seen.delete(value);
  return resolved;
}

/**
 * Normalize a relationship pointer value into a list of target ids.
 * Accepts a handle, a string id, anything with a string `.id`, or an
 * array of those; `null`/`undefined` drop out (clear semantics).
 */
const resolvePointerTargets = (
  value: unknown,
  entityName: string,
  as: string,
): readonly string[] => {
  const items = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of items) {
    if (item === null || item === undefined) continue;
    try {
      const id = normalizePointer(item, `atomic pointer for "${entityName}.${as}"`);
      if (id !== null) out.push(id);
    } catch (err) {
      throw new AtomicResolutionError(err instanceof Error ? err.message : String(err));
    }
  }
  return out;
};

const declaresField = (def: AnyEntityDef, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(def.shape.properties ?? {}, key);

const createDraftNamespace = (
  entityName: string,
  def: AnyEntityDef,
  cap: AtomicWriteCapability,
  writes: PendingWrite[],
): AtomicDraftNamespace<Record<string, TSchema>> => ({
  create(input, opts) {
    const id = generateId("e");
    const source = (input ?? {}) as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    const pointers: PendingPointer[] = [];
    const handle: Record<string, unknown> = { id };

    for (const [key, value] of Object.entries(source)) {
      const rel = cap.registry.getRelationship(entityName, key);
      if (rel === undefined) {
        const resolved = resolveReferences(value);
        fields[key] = resolved;
        handle[key] = resolved;
        continue;
      }
      const targets = resolvePointerTargets(value, entityName, key);
      if (rel.sourceCardinality === "many") {
        handle[key] = targets;
        // A declared `as` field carries the canonical FK set on the
        // entity; an undeclared one lives only on the Relationship
        // records.
        if (declaresField(def, key)) fields[key] = targets;
        for (const targetId of targets) {
          pointers.push({ as: key, type: rel.type, kind: rel.kind, targetId });
        }
      } else {
        if (targets.length > 1) {
          throw new AtomicResolutionError(
            `atomic: one-cardinality relationship "${entityName}.${key}" received ${targets.length} targets`,
          );
        }
        const targetId = targets[0];
        handle[key] = targetId ?? null;
        if (targetId !== undefined) {
          pointers.push({ as: key, type: rel.type, kind: rel.kind, targetId });
        }
      }
    }

    // Membership is separate from the entity's field map: one
    // `kind: "member"` edge per group, emitted into the same Action.
    for (const targetId of resolveGroupIds(opts?.groups, entityName)) {
      pointers.push({
        as: GROUPS_ACCESSOR,
        type: entityName,
        kind: MEMBERSHIP_KIND,
        targetId,
      });
    }

    const violations = validatePayload(def.shape, fields, entityName, false);
    if (violations.length > 0) {
      throw new EntityValidationError(violations);
    }

    writes.push({ entity: entityName, id, fields, pointers });
    return markHandle(handle) as unknown as CreatedEntity<Record<string, TSchema>>;
  },
});

const buildDrafts = (
  entityDefs: Record<string, AnyEntityDef>,
  cap: AtomicWriteCapability,
  writes: PendingWrite[],
): Record<string, AtomicDraftNamespace<Record<string, TSchema>>> => {
  const out: Record<string, AtomicDraftNamespace<Record<string, TSchema>>> = {};
  for (const [name, def] of Object.entries(entityDefs)) {
    out[name] = createDraftNamespace(name, def, cap, writes);
  }
  return out;
};

/**
 * Flatten the collected writes into the wire Update list: one entity
 * `put` per created entity, followed by one `Relationship` `put` per
 * resolved pointer. The caller wraps the list in one Action.
 */
const buildUpdates = (writes: readonly PendingWrite[], cap: AtomicWriteCapability): Update[] => {
  const entityUpdates: Update[] = [];
  const relationshipUpdates: Update[] = [];
  for (const write of writes) {
    const updateId = cap.generateUpdateId();
    const hlc = cap.freshHlc();
    entityUpdates.push({
      id: updateId,
      subject_id: write.id,
      subject_type: write.entity,
      method: "put",
      data: { fields: wrapFields(write.fields, updateId, hlc) },
    });
    for (const pointer of write.pointers) {
      relationshipUpdates.push(
        buildRelationshipUpdate({
          relationshipId: generateId("rel"),
          sourceId: write.id,
          targetId: pointer.targetId,
          field: pointer.as,
          type: pointer.type,
          kind: pointer.kind,
          updateId: cap.generateUpdateId(),
        }),
      );
    }
  }
  return [...entityUpdates, ...relationshipUpdates];
};

/**
 * Build the `client.atomic` runtime for a schema. Each call gets a
 * fresh collector, runs the callback to gather writes, flattens them
 * into one Action, and submits once before resolving to the callback's
 * return value.
 */
export function createAtomicRuntime<S extends Schema<Record<string, AnyEntityDef>, unknown>>(
  schema: S,
  cap: AtomicWriteCapability,
): <T>(build: (drafts: AtomicDrafts<S>) => T) => Promise<T> {
  const entityDefs = schema.entities as Record<string, AnyEntityDef>;
  return async function atomic<T>(build: (drafts: AtomicDrafts<S>) => T): Promise<T> {
    const writes: PendingWrite[] = [];
    const drafts = buildDrafts(entityDefs, cap, writes);
    const result = build(drafts as AtomicDrafts<S>);
    const updates = buildUpdates(writes, cap);
    if (updates.length > 0) {
      await cap.submitRelationshipUpdates(updates);
    }
    return result;
  };
}
