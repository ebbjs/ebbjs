/**
 * Wire builders for relationship writes: the pure half of the client's
 * relationship module. Storage-backed traversal stays in `@ebbjs/client`.
 *
 * A link is a keyed component of its **source row**: `ebb/link` holds
 * `{<as>: {<type>: {<target_id>: true}}}`, so the three nesting levels are the
 * edge's key and the leaf is presence. Every builder here merges keys on the
 * source and no builder creates a row. One Update writes one edge — a presence
 * leaf to add it, a tombstone (`value: null`) to remove it — except a
 * one-cardinality move, which is one Update carrying the old key's tombstone
 * and the new key's presence.
 *
 * Emitters for the three platform **rows** (group, grant, membership) live in
 * `system-rows.ts`.
 */

import { ebbComponent, generateId, type FieldValue, type Update } from "@ebbjs/core";
import { EntityValidationError, type ModelRegistry } from "@ebbjs/schema";

import { membershipRowId } from "./membership";
import { normalizePointer, type PointerValue } from "./pointer";
import { membershipRowUpdates, systemRowDelete, type SystemRowIds } from "./system-rows";

/**
 * The value shape for `sourceCardinality: "many"` updates.
 *   - `{ replace: [...] }` — make the set exactly this
 *   - `{ add, remove }` — patch the set
 *
 * `null` is rejected for many-cardinality pointers (use `remove` to
 * clear). The two shapes are mutually exclusive at the type level. A `replace`
 * is an instruction to the planner, which resolves it to per-key presence
 * leaves and tombstones against the live set; it never reaches the wire as an
 * array-valued leaf.
 */
export type ManyPointerValue =
  | { readonly replace: readonly PointerValue[] }
  | { readonly add: readonly PointerValue[]; readonly remove: readonly PointerValue[] };

export interface BuildRelationshipWriteOptions {
  source: { readonly name: string };
  target: { readonly name: string };
  as: string;
  /** Optional override; defaults to the registry-stored relationship's `sourceCardinality`. */
  sourceCardinality?: "one" | "many";
  /** The source entity's id: the `subject_id` of every Update and the edge's owner. */
  sourceId: string;
  /**
   * The one-cardinality target: an id or entity shape, or `null` to remove the
   * live edge. `undefined` writes nothing.
   */
  targetId?: PointerValue;
  /** Pointer value(s) for `sourceCardinality: "many"`. */
  targetIds?: ManyPointerValue;
  /**
   * The live targets of this accessor, when the caller can read them. A
   * `replace` and a one-cardinality move are diffs against them: without them
   * the builder cannot tombstone the keys the write drops.
   */
  currentTargets?: readonly string[];
  /** The local clock every leaf is stamped with. */
  hlc: () => string;
  /**
   * Mints the Update ids. Defaults to core's nanoid `generateId`; a caller that
   * needs a deterministic batch supplies its own seam.
   */
  newId?: (prefix: string) => string;
}

export interface BuildRelationshipWriteResult {
  /** The `ebb/link` Updates on the source — one per edge written. */
  relationshipUpdates: readonly Update[];
}

/** The ids one edge write consumes: a fresh Update id each, and the local clock. */
export interface LinkWriteIds {
  updateId(): string;
  hlc(): string;
}

/** The three-level value one Update carries: accessor, type label, then target leaves. */
const linkComponentValue = (
  as: string,
  type: string,
  leaves: Record<string, FieldValue>,
): FieldValue => ({
  map: { [as]: { map: { [type]: { map: leaves } } } },
});

/**
 * One `ebb/link` Update on the source: a `merge` of the presence keys and the
 * tombstone keys it carries. Removing one edge is a merge whose value
 * tombstones that key, so `drop` keeps its `(entity, component)` granularity.
 *
 * A key named in both lists is removed: the tombstone is the newer intent.
 */
export const linkEdgeUpdate = (args: {
  sourceId: string;
  as: string;
  type: string;
  present: readonly string[];
  removed: readonly string[];
  ids: LinkWriteIds;
}): Update => {
  const updateId = args.ids.updateId();
  const hlc = args.ids.hlc();
  const removed = new Set(args.removed);
  const leaves: Record<string, FieldValue> = {};
  for (const targetId of args.present) {
    if (removed.has(targetId)) continue;
    leaves[targetId] = { value: true, update_id: updateId, hlc };
  }
  for (const targetId of removed) {
    leaves[targetId] = { value: null, update_id: updateId, hlc };
  }
  return {
    id: updateId,
    subject_id: args.sourceId,
    component: ebbComponent("link"),
    method: "merge",
    data: linkComponentValue(args.as, args.type, leaves),
  };
};

/**
 * Compile one edge delta into Updates. Each key gets its own Update — one
 * Update, one edge — unless `combined` is set, which is the one-cardinality
 * move: the previous target's tombstone and the new target's presence are one
 * merged position set.
 */
export const linkEdgeUpdates = (args: {
  sourceId: string;
  as: string;
  type: string;
  present: readonly string[];
  removed: readonly string[];
  combined?: boolean;
  ids: LinkWriteIds;
}): Update[] => {
  if (args.combined) {
    if (args.present.length === 0 && args.removed.length === 0) return [];
    return [linkEdgeUpdate(args)];
  }
  return [
    ...args.present.map((targetId) =>
      linkEdgeUpdate({ ...args, present: [targetId], removed: [] }),
    ),
    ...args.removed.map((targetId) =>
      linkEdgeUpdate({ ...args, present: [], removed: [targetId] }),
    ),
  ];
};

/**
 * Normalize many-pointer values. Returns a flat array of distinct
 * string ids (or throws on bad input).
 */
export function normalizeManyPointers(value: ManyPointerValue, label: string): readonly string[] {
  const all: unknown[] = "replace" in value ? [...value.replace] : [...value.add, ...value.remove];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const v of all) {
    const id = normalizePointer(v, label);
    if (id === null) {
      throw new Error(`${label}: null entries are not allowed in a many-pointer set`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** Re-exported here so relationship callers need one module for pointers. */
export { normalizePointer } from "./pointer";
export type { PointerValue } from "./pointer";

/**
 * Resolve the relationship's effective cardinality. The explicit
 * `sourceCardinality` override on the call wins; otherwise we look
 * up the registry.
 */
export function resolveCardinality(
  registry: ModelRegistry,
  sourceName: string,
  as: string,
  explicit: "one" | "many" | undefined,
): "one" | "many" {
  if (explicit !== undefined) return explicit;
  const rel = registry.getRelationship(sourceName, as);
  if (rel !== undefined) return rel.sourceCardinality;
  // No registry entry; default to "one" (matches the builder default).
  return "one";
}

/** The Updates for an `ebb/membership` row filing `entityId` into `groupId`. */
export function buildMembershipUpdate(
  args: { membershipId: string; entityId: string; groupId: string },
  ids: SystemRowIds,
): Update[] {
  return membershipRowUpdates(
    { membershipId: args.membershipId, entityId: args.entityId, groupId: args.groupId },
    ids,
  );
}

/**
 * Build a `delete` Update for an existing membership row. The wire delete
 * carries only the membership id; the server recovers the entity/group from
 * its by-id cache, so no `data` is sent.
 */
export function buildMembershipDelete(args: { membershipId: string; updateId: string }): Update {
  return systemRowDelete(args.membershipId, { updateId: () => args.updateId });
}

/**
 * Build one membership `put` Update per group. Shared by the `createEntity`
 * and `duplicateEntity` operations so membership emission has one definition.
 */
export function buildMembershipUpdates(
  entityId: string,
  groupIds: readonly string[],
  ids: SystemRowIds,
): Update[] {
  return groupIds.flatMap((groupId) =>
    membershipRowUpdates(
      { membershipId: membershipRowId(entityId, groupId), entityId, groupId },
      ids,
    ),
  );
}

/**
 * Surface unknown source/target entity names as a typed
 * `EntityValidationError`. When no entities are registered at all
 * (validation is a no-op across the SDK) the call is skipped — the
 * server is the authority in that case.
 */
function checkEntityRegistered(
  registry: ModelRegistry,
  name: string,
  role: "source" | "target",
): void {
  if (registry.isEmpty()) return;
  if (registry.has(name)) return;
  throw new EntityValidationError([
    {
      entityName: name,
      message: `buildRelationshipWrite: ${role} entity "${name}" is not registered in the ModelRegistry`,
    },
  ]);
}

/**
 * Resolve the wire-level `type` string for a relationship: prefer the
 * registry's stored `type` override; fall back to the source entity
 * name. Matches `defineRelationship`'s default.
 */
function wireTypeFor(registry: ModelRegistry, sourceName: string, as: string): string {
  const rel = registry.getRelationship(sourceName, as);
  return rel?.type ?? sourceName;
}

const refreshError = (as: string, sourceId: string): EntityValidationError =>
  new EntityValidationError([
    {
      entityName: "",
      message:
        `buildRelationshipWrite: "${as}" on "${sourceId}" needs its live targets to diff a set ` +
        `against; pass currentTargets, read from the replica that owns the write`,
    },
  ]);

/** The edge delta a caller's pointer value names, against the live set it supplies. */
const oneDelta = (
  opts: BuildRelationshipWriteOptions,
  targetId: string | null,
): { present: readonly string[]; removed: readonly string[] } => {
  const current = opts.currentTargets;
  if (targetId === null) {
    if (current === undefined) throw refreshError(opts.as, opts.sourceId);
    return { present: [], removed: current };
  }
  return {
    present: [targetId],
    removed: (current ?? []).filter((live) => live !== targetId),
  };
};

const manyDelta = (
  opts: BuildRelationshipWriteOptions,
  targetIds: ManyPointerValue,
): { present: readonly string[]; removed: readonly string[] } => {
  if ("replace" in targetIds) {
    const next = normalizeManyPointers(targetIds, `targetIds for "${opts.as}"`);
    const current = opts.currentTargets;
    if (current === undefined) throw refreshError(opts.as, opts.sourceId);
    const keep = new Set(next);
    return {
      present: next.filter((targetId) => !current.includes(targetId)),
      removed: current.filter((targetId) => !keep.has(targetId)),
    };
  }
  return {
    present: targetIds.add
      .map((target) => normalizePointer(target, `targetIds.add for "${opts.as}"`))
      .filter((id): id is string => id !== null),
    removed: targetIds.remove
      .map((target) => normalizePointer(target, `targetIds.remove for "${opts.as}"`))
      .filter((id): id is string => id !== null),
  };
};

/**
 * Build the wire Update(s) for a single relationship write. The sole builder,
 * shared by `SyncClient.buildRelationshipWrite` and the `writeRelationship`
 * operation.
 *
 * Every Update is an `ebb/link` merge on the source: a presence leaf per target
 * the write adds, a tombstone per target it drops, and one Update for a
 * one-cardinality move. A null / empty write emits nothing.
 *
 * Pointer values may be a string id or an entity-shape object
 * (anything with a string `.id`); both normalize to the id. Anything
 * else is rejected with `EntityValidationError`.
 */
export function buildRelationshipWrite(
  registry: ModelRegistry,
  opts: BuildRelationshipWriteOptions,
): BuildRelationshipWriteResult {
  const { source, as } = opts;
  const sourceName = source.name;
  const newId = opts.newId ?? generateId;

  checkEntityRegistered(registry, sourceName, "source");
  const cardinality = resolveCardinality(registry, sourceName, as, opts.sourceCardinality);
  const type = wireTypeFor(registry, sourceName, as);
  const ids: LinkWriteIds = { updateId: () => newId("u"), hlc: opts.hlc };

  if (cardinality === "one") {
    if (opts.targetIds !== undefined) {
      throw new EntityValidationError([
        {
          entityName: sourceName,
          message: `buildRelationshipWrite: one-cardinality relationship "${as}" takes one target, not a set`,
        },
      ]);
    }
    if (opts.targetId === undefined) return { relationshipUpdates: [] };
    const targetId = normalizePointer(opts.targetId, `targetId for "${as}"`);
    const delta = oneDelta(opts, targetId);
    return {
      relationshipUpdates: linkEdgeUpdates({
        sourceId: opts.sourceId,
        as,
        type,
        ...delta,
        combined: true,
        ids,
      }),
    };
  }

  if (opts.targetIds === undefined) {
    if (opts.targetId === undefined) return { relationshipUpdates: [] };
    const targetId = normalizePointer(opts.targetId, `targetId for "${as}"`);
    if (targetId === null) {
      throw new EntityValidationError([
        {
          entityName: sourceName,
          message: `buildRelationshipWrite: many-cardinality relationship "${as}" removes one target at a time; name the target`,
        },
      ]);
    }
    return {
      relationshipUpdates: linkEdgeUpdates({
        sourceId: opts.sourceId,
        as,
        type,
        present: [targetId],
        removed: [],
        ids,
      }),
    };
  }

  return {
    relationshipUpdates: linkEdgeUpdates({
      sourceId: opts.sourceId,
      as,
      type,
      ...manyDelta(opts, opts.targetIds),
      ids,
    }),
  };
}
