/**
 * The semantic write verbs: one declaration of what `create` / `update` /
 * `delete` / `drop` / `relate` / `unrelate` mean, and the planner calls that
 * build their Updates.
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

import { EntityValidationError, type ModelRegistry } from "@ebbjs/schema";

import {
  call,
  createEntity,
  deleteEntity,
  dropEntity,
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
 * Detach components from a row, one `drop` Update per named field. A drop
 * needs no read — the row survives, so `UNRESOLVED` is a faithful resolution.
 * `unset` in an update patch is a different write: it clears the position and
 * leaves a tombstone; `drop` removes the component.
 */
export interface DropVerb {
  readonly verb: "drop";
  readonly entity: string;
  readonly id: string;
  readonly fields: readonly string[];
  readonly groups?: readonly string[];
}

/**
 * Link a relationship. One-cardinality relationships take a single `target`;
 * a many-cardinality relationship takes a set of targets. The edge lives on the
 * source row, so every target becomes a presence leaf on its `ebb/link`
 * component.
 *
 * A many-cardinality set is an **add** unless `replace` is set: it gives the
 * named targets presence and never tombstones a sibling. A `replace` is the
 * whole set, which is a diff against the live edges — the client's
 * `setLinks({ replace })`.
 */
export interface RelateVerb {
  readonly verb: "relate";
  readonly entity: string;
  readonly id: string;
  readonly as: string;
  readonly target?: PointerTarget;
  readonly targets?: readonly PointerTarget[];
  /**
   * Many-cardinality only: the named targets are the whole set; the verb
   * refuses when the live set is unreadable rather than leaving stale edges.
   * The default is add (presence only, no tombstones).
   */
  readonly replace?: boolean;
  readonly groups?: readonly string[];
}

/**
 * Remove a relationship: `target` names the edge's key, for either
 * cardinality. With no target the write clears the accessor, which needs the
 * live targets — the resolution's `targetsOf` supplies them and the verb
 * refuses when the caller cannot read them.
 */
export interface UnrelateVerb {
  readonly verb: "unrelate";
  readonly entity: string;
  readonly id: string;
  readonly as: string;
  readonly target?: PointerTarget;
  readonly groups?: readonly string[];
}

export type WriteVerb = CreateVerb | UpdateVerb | DeleteVerb | DropVerb | RelateVerb | UnrelateVerb;

/**
 * What a verb needs resolved before it can become a planner call. The
 * functions runtime resolves it from its write buffer and overlay; the
 * client's draft planner from its materialized cache.
 */
export interface VerbResolution {
  /** The acting entity's fan-out groups; `[]` when locally unknown. */
  groupsOf(entityId: string): readonly string[];
  /**
   * The live targets of one `(source, as, type)` edge set, ascending:
   * - an array — the edges the caller can see, possibly none;
   * - `undefined` — the caller cannot see them, so a verb that must diff
   *   against them refuses.
   */
  targetsOf(sourceId: string, as: string, type: string): readonly string[] | undefined;
}

/** A resolution for a batch whose reads are all unknown — no groups, no edges. */
export const UNRESOLVED: VerbResolution = {
  groupsOf: () => [],
  targetsOf: () => undefined,
};

const groupsOf = (
  verb: UpdateVerb | DeleteVerb | DropVerb | RelateVerb | UnrelateVerb,
  res: VerbResolution,
) => verb.groups ?? res.groupsOf(verb.id);

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
 * Resolve a create into the create operation's input: field values with handles
 * collapsed and declared relationships split into pointers.
 *
 * A relationship accessor names an edge and never a field: the edge is a key of
 * the source row's `ebb/link` component, so nothing copies the target set onto
 * a `<source>/<as>` component, even when the model declares a field of the same
 * name.
 *
 * This is the only place the create shape is interpreted, so the runtime and
 * the fixtures cannot disagree about what a create field means.
 */
export const createEntityInput = (registry: ModelRegistry, verb: CreateVerb): CreateEntityInput => {
  const fields: Record<string, unknown> = {};
  const pointers: ResolvedPointer[] = [];

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
      field: verb.as,
      message:
        `unrelate: cannot read the live "${verb.as}" edges of "${verb.id}" from this call. ` +
        `Read the row with ctx.get and unrelate again, or name the target to remove.`,
    },
  ]);

/**
 * A set that must become the whole accessor cannot be written without the live
 * edges: adding presence alone would leave the keys it means to drop behind.
 */
const replaceTargetError = (verb: RelateVerb): EntityValidationError =>
  new EntityValidationError([
    {
      entityName: verb.entity,
      field: verb.as,
      message:
        `relate: cannot read the live "${verb.as}" edges of "${verb.id}", so the set ` +
        `cannot replace them. Sync the source row first, or relate each target ` +
        `individually to add it.`,
    },
  ]);

/** One write's delta: the keys it gives presence to and the keys it tombstones. */
interface EdgeDelta {
  readonly present: readonly string[];
  readonly removed: readonly string[];
  readonly combined: boolean;
}

/** Nothing to write: no key changes, so the verb emits no Update at all. */
const isEmptyDelta = (delta: EdgeDelta): boolean =>
  delta.present.length === 0 && delta.removed.length === 0;

/** Apply a delta only when it changes something; a no-op write emits nothing. */
const edgeCall = (
  verb: RelateVerb | UnrelateVerb,
  delta: EdgeDelta,
  resolution: VerbResolution,
): OperationCall | undefined =>
  isEmptyDelta(delta)
    ? undefined
    : call(writeRelationship, {
        entity: verb.entity,
        sourceId: verb.id,
        as: verb.as,
        present: delta.present,
        removed: delta.removed,
        combined: delta.combined,
        groups: groupsOf(verb, resolution),
      });

/**
 * Resolve a verb to the planner call that builds its Updates. Returns
 * `undefined` when there is nothing to emit — a one-cardinality unlink of an
 * edge that is already gone.
 *
 * Throws where the verb cannot be resolved faithfully: an undeclared
 * relationship, an unlink with no target whose live edges the surface cannot
 * read, or a many-cardinality `relate` that replaces the accessor without
 * being able to read it. Emitting an Update that would drop links the caller
 * never saw is worse than refusing the call.
 */
export const operationCallFor = (
  registry: ModelRegistry,
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
    case "drop":
      return call(dropEntity, {
        entity: verb.entity,
        id: verb.id,
        fields: verb.fields,
        groups: groupsOf(verb, resolution),
      });
    case "relate": {
      const rel = requireRelationship(registry, verb.entity, verb.as);
      const type = rel.type ?? verb.entity;
      const current = resolution.targetsOf(verb.id, verb.as, type);
      const known = current ?? [];
      if (rel.sourceCardinality === "many") {
        const targets = verb.targets ?? (verb.target === undefined ? [] : [verb.target]);
        const next = pointerIds(targets, `target for "${verb.entity}.${verb.as}"`);
        if (verb.replace === true) {
          // The set is the whole accessor, so it is a diff against the live
          // edges. Without them the write would silently leave stale ones.
          if (current === undefined) throw replaceTargetError(verb);
          return edgeCall(
            verb,
            {
              present: next.filter((targetId) => !known.includes(targetId)),
              removed: known.filter((targetId) => !next.includes(targetId)),
              combined: false,
            },
            resolution,
          );
        }
        // An add names the keys it writes: presence only, never a sibling's
        // tombstone.
        return edgeCall(verb, { present: next, removed: [], combined: false }, resolution);
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
      const next = pointerId(
        verb.target as PointerTarget,
        `target for "${verb.entity}.${verb.as}"`,
      );
      // The move is one Update: the previous target's tombstone and the new
      // target's presence are one merged position set.
      return edgeCall(
        verb,
        {
          present: [next],
          removed: known.filter((targetId) => targetId !== next),
          combined: true,
        },
        resolution,
      );
    }
    case "unrelate": {
      const rel = requireRelationship(registry, verb.entity, verb.as);
      const type = rel.type ?? verb.entity;
      if (verb.target !== undefined) {
        // A named target is a key, so the removal needs no read at all.
        return edgeCall(
          verb,
          {
            present: [],
            removed: [pointerId(verb.target, `target for "${verb.entity}.${verb.as}"`)],
            combined: false,
          },
          resolution,
        );
      }
      const current = resolution.targetsOf(verb.id, verb.as, type);
      if (current === undefined) throw unlinkTargetError(verb);
      return edgeCall(verb, { present: [], removed: current, combined: false }, resolution);
    }
  }
};
