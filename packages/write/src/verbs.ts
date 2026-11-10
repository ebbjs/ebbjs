/**
 * The semantic write verbs: one declaration of what `create` / `update` /
 * `delete` / `relate` / `unrelate` mean, and the planner calls that build
 * their Updates.
 *
 * The functions runtime's `ctx` and the reference fixtures resolve through here,
 * so the same verb produces the same Updates on both paths by construction.
 * They differ only in where the resolution inputs come from: a materialized
 * local cache for the client, an invocation's write buffer and its overlay for
 * the runtime.
 *
 * A verb is a plain value (never a method that submits), which is what lets a
 * fixture pin one as JSON and replay it through either surface.
 */

import { EntityValidationError, type EntityRegistry } from "@ebbjs/schema";

import {
  call,
  createEntity,
  deleteEntity,
  patchEntity,
  requireRelationship,
  writeRelationship,
  type CreateEntityInput,
  type OperationCall,
  type ResolvedPointer,
} from "./operations";
import { normalizePointer } from "./pointer";

/** A reference to an existing row: its id, or anything carrying one. */
export type PointerTarget = string | { readonly id: string };

/** The marker a create handle carries, so only a handle collapses in a field value. */
const CREATE_HANDLE = Symbol.for("@ebbjs/create-handle");

/** A create's return value: the new row's id, mintable before the commit. */
export interface CreateHandle {
  readonly id: string;
}

/** Stamp a handle so a later verb in the same batch can reference it. */
export const createHandle = (id: string): CreateHandle => {
  const handle = { id };
  Object.defineProperty(handle, CREATE_HANDLE, { value: true, enumerable: false });
  return Object.freeze(handle);
};

const isCreateHandle = (value: unknown): value is CreateHandle =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<symbol, unknown>)[CREATE_HANDLE] === true;

/**
 * A verb that mints a row. The id is supplied by the caller so a batch —
 * and a fixture pinning it — owns id allocation; a surface without one
 * mints its own.
 */
export interface CreateVerb {
  readonly verb: "create";
  readonly entity: string;
  readonly id: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly groups: readonly string[];
  readonly validate?: boolean;
}

export interface UpdateVerb {
  readonly verb: "update";
  readonly entity: string;
  readonly id: string;
  readonly patch: Readonly<Record<string, unknown>>;
  readonly groups?: readonly string[];
  readonly validate?: boolean;
}

export interface DeleteVerb {
  readonly verb: "delete";
  readonly entity: string;
  readonly id: string;
  readonly groups?: readonly string[];
}

/**
 * Link a relationship. One-cardinality relationships take a single
 * `target`; a many-cardinality relationship's canonical FK set lives on the
 * source row, so `targets` is the whole set the write carries (the client's
 * `setLinks({ replace })`).
 */
export interface RelateVerb {
  readonly verb: "relate";
  readonly entity: string;
  readonly id: string;
  readonly as: string;
  readonly target?: PointerTarget;
  readonly targets?: readonly PointerTarget[];
  readonly groups?: readonly string[];
}

/**
 * Remove a relationship. A one-cardinality edge is deleted by its
 * `relationship` row id; a many-cardinality write either drops `target` from
 * the current FK set or clears the set when no target is named.
 */
export interface UnrelateVerb {
  readonly verb: "unrelate";
  readonly entity: string;
  readonly id: string;
  readonly as: string;
  readonly target?: PointerTarget;
  readonly relationshipId?: string;
  readonly groups?: readonly string[];
}

export type WriteVerb = CreateVerb | UpdateVerb | DeleteVerb | RelateVerb | UnrelateVerb;

/**
 * What a verb needs resolved before it can become a planner call. The
 * functions runtime resolves it from its write buffer and overlay; the
 * client's draft planner from its materialized cache.
 */
export interface VerbResolution {
  /** The acting entity's fan-out groups; `[]` when locally unknown. */
  groupsOf(entityId: string): readonly string[];
  /**
   * The live `relationship` row id of a one-cardinality edge:
   * - a string — the row to delete;
   * - `null` — known to be unlinked, so the verb emits nothing;
   * - `undefined` — the caller cannot see it, so the verb refuses.
   */
  relationshipIdFor(sourceId: string, as: string, type: string): string | null | undefined;
  /** The source row's current canonical FK set for a many-cardinality `as`. */
  fkTargetsOf(sourceId: string, as: string): readonly string[] | undefined;
}

/** A resolution for a batch whose reads are all unknown — no groups, no edges. */
export const UNRESOLVED: VerbResolution = {
  groupsOf: () => [],
  relationshipIdFor: () => undefined,
  fkTargetsOf: () => undefined,
};

const groupsOf = (verb: UpdateVerb | DeleteVerb | RelateVerb | UnrelateVerb, res: VerbResolution) =>
  verb.groups ?? res.groupsOf(verb.id);

const pointerId = (value: PointerTarget, label: string): string => {
  const id = normalizePointer(value, label);
  if (id === null) {
    throw new EntityValidationError([
      { entityName: "", message: `${label}: a target id is required` },
    ]);
  }
  return id;
};

const pointerIds = (value: PointerTarget | readonly PointerTarget[], label: string): string[] =>
  (Array.isArray(value) ? value : [value]).map((entry) => pointerId(entry as PointerTarget, label));

/**
 * Collapse create handles nested anywhere in a field value. Only a handle a
 * create minted collapses: a wire value that happens to carry an `id` key is
 * a map field and stays as it is.
 */
const collapseHandles = (value: unknown, seen: Set<object> = new Set()): unknown => {
  if (isCreateHandle(value)) return value.id;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) {
    throw new EntityValidationError([
      { entityName: "", message: "create: cycle detected while resolving a field value" },
    ]);
  }
  seen.add(value);
  const resolved = Array.isArray(value)
    ? value.map((entry) => collapseHandles(entry, seen))
    : Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, collapseHandles(entry, seen)]),
      );
  seen.delete(value);
  return resolved;
};

const declaresField = (def: ReturnType<EntityRegistry["get"]>, key: string): boolean =>
  def !== undefined && Object.prototype.hasOwnProperty.call(def.shape.properties ?? {}, key);

/**
 * Normalize a `groups` option: required, non-empty, de-duplicated. The
 * message matches the client draft surface's, so both refuse identically.
 */
export const normalizeGroupIds = (
  groups: readonly PointerTarget[] | undefined,
  entityName: string,
  operation = "create",
  label = "groups",
): readonly string[] => {
  const required = (): EntityValidationError =>
    new EntityValidationError([
      {
        entityName,
        message: `${operation}: "${label}" is required and must contain at least one group id`,
      },
    ]);
  if (groups === undefined || groups.length === 0) throw required();
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    const id = pointerId(group, `group for "${entityName}"`);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) throw required();
  return ids;
};

/**
 * Resolve a create into the create operation's input: field values with
 * handles collapsed and declared relationships split into pointers (and, for
 * a many-cardinality accessor the entity declares as a field, a canonical FK
 * value).
 *
 * This is the only place the create shape is interpreted, so the runtime and
 * the fixtures cannot disagree about what a create field means.
 */
export const createEntityInput = (
  registry: EntityRegistry,
  verb: CreateVerb,
): CreateEntityInput => {
  const fields: Record<string, unknown> = {};
  const pointers: ResolvedPointer[] = [];
  const def = registry.get(verb.entity);

  for (const [key, value] of Object.entries(verb.fields)) {
    const rel = registry.getRelationship(verb.entity, key);
    if (rel === undefined) {
      fields[key] = collapseHandles(value);
      continue;
    }

    const targets = pointerIds(
      value as PointerTarget | readonly PointerTarget[],
      `pointer for "${verb.entity}.${key}"`,
    );
    if (rel.sourceCardinality === "many") {
      // A declared `as` field carries the canonical FK set on the entity;
      // an undeclared one lives only on the Relationship records.
      if (declaresField(def, key)) fields[key] = targets;
      for (const targetId of targets) pointers.push({ as: key, type: rel.type, targetId });
      continue;
    }
    if (targets.length > 1) {
      throw new EntityValidationError([
        {
          entityName: verb.entity,
          field: key,
          message: `create: one-cardinality relationship "${key}" received ${targets.length} targets`,
        },
      ]);
    }
    const [targetId] = targets;
    if (targetId !== undefined) pointers.push({ as: key, type: rel.type, targetId });
  }

  return {
    entity: verb.entity,
    id: verb.id,
    fields,
    pointers,
    groups: [...verb.groups],
    validate: verb.validate,
  };
};

const unlinkTargetError = (verb: UnrelateVerb): EntityValidationError =>
  new EntityValidationError([
    {
      entityName: verb.entity,
      message:
        `unrelate: no live "${verb.as}" relationship row is visible to this invocation. ` +
        `A one-cardinality edge that predates the call is addressed by its row id: pass ` +
        `{ relationshipId } (ctx.get cannot read relationship rows in v1).`,
    },
  ]);

/**
 * Resolve a verb to the planner call that builds its Updates. Returns
 * `undefined` when there is nothing to emit — a one-cardinality unlink of an
 * edge that is already gone.
 *
 * Throws where the verb cannot be resolved faithfully: an undeclared
 * relationship, a one-cardinality unlink with no visible row id, or a
 * many-cardinality unlink whose current FK set is unknown. Emitting an Update
 * that would lose links is worse than refusing the call.
 */
export const operationCallFor = (
  registry: EntityRegistry,
  verb: WriteVerb,
  resolution: VerbResolution = UNRESOLVED,
): OperationCall | undefined => {
  switch (verb.verb) {
    case "create":
      return call(createEntity, createEntityInput(registry, verb));
    case "update":
      return call(patchEntity, {
        entity: verb.entity,
        id: verb.id,
        payload: verb.patch,
        groups: groupsOf(verb, resolution),
        validate: verb.validate,
      });
    case "delete":
      return call(deleteEntity, {
        entity: verb.entity,
        id: verb.id,
        groups: groupsOf(verb, resolution),
      });
    case "relate": {
      const rel = requireRelationship(registry, verb.entity, verb.as);
      const groups = groupsOf(verb, resolution);
      if (rel.sourceCardinality === "many") {
        const targets = verb.targets ?? (verb.target === undefined ? [] : [verb.target]);
        return call(writeRelationship, {
          entity: verb.entity,
          sourceId: verb.id,
          as: verb.as,
          pointer: {
            targetIds: {
              replace: pointerIds(targets, `target for "${verb.entity}.${verb.as}"`),
            },
          },
          groups,
        });
      }
      if (verb.targets !== undefined) {
        throw new EntityValidationError([
          {
            entityName: verb.entity,
            field: verb.as,
            message: `relate: one-cardinality relationship "${verb.as}" takes one target, not a set`,
          },
        ]);
      }
      return call(writeRelationship, {
        entity: verb.entity,
        sourceId: verb.id,
        as: verb.as,
        pointer: {
          targetId: pointerId(
            verb.target as PointerTarget,
            `target for "${verb.entity}.${verb.as}"`,
          ),
        },
        groups,
      });
    }
    case "unrelate": {
      const rel = requireRelationship(registry, verb.entity, verb.as);
      const groups = groupsOf(verb, resolution);
      if (rel.sourceCardinality === "many") {
        const current = verb.target === undefined ? [] : resolution.fkTargetsOf(verb.id, verb.as);
        if (verb.target !== undefined && current === undefined) {
          throw new EntityValidationError([
            {
              entityName: verb.entity,
              field: verb.as,
              message:
                `unrelate: cannot resolve the current "${verb.as}" FK set for "${verb.id}"; ` +
                `read the row with ctx.get before unlinking one target, or call unrelate without one to clear the set`,
            },
          ]);
        }
        const drop = verb.target === undefined ? undefined : pointerId(verb.target, "target");
        const remaining = (current ?? []).filter((targetId) => targetId !== drop);
        return call(writeRelationship, {
          entity: verb.entity,
          sourceId: verb.id,
          as: verb.as,
          pointer: { targetIds: { replace: remaining } },
          groups,
        });
      }
      if (verb.target !== undefined) {
        throw new EntityValidationError([
          {
            entityName: verb.entity,
            field: verb.as,
            message: `unrelate: a one-cardinality edge is addressed by its relationship row id, not a target id; pass { relationshipId }`,
          },
        ]);
      }
      const resolved =
        verb.relationshipId ??
        resolution.relationshipIdFor(verb.id, verb.as, rel.type ?? verb.entity);
      if (resolved === null) return undefined;
      if (resolved === undefined) throw unlinkTargetError(verb);
      return call(writeRelationship, {
        entity: verb.entity,
        sourceId: verb.id,
        as: verb.as,
        pointer: { targetId: null },
        relationshipSubjectId: resolved,
        groups,
      });
    }
  }
};
