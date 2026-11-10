/**
 * Wire builders for relationship writes: the pure half of the client's
 * relationship module. Storage-backed traversal stays in `@ebbjs/client`.
 */

import { componentName, generateId, type FieldValue, type Update } from "@ebbjs/core";

import { EntityValidationError, type ModelRegistry } from "@ebbjs/schema";

import { entityGroupId } from "./membership";
import { normalizePointer, type PointerValue } from "./pointer";

/**
 * The value shape for `sourceCardinality: "many"` updates.
 *   - `{ replace: [...] }` — overwrite the whole set
 *   - `{ add, remove }` — patch the set
 *
 * `null` is rejected for many-cardinality pointers (use `remove` to
 * clear). The two shapes are mutually exclusive at the type level.
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
  /**
   * Source entity's id, the `subject_id` on the source's Update.
   * Required for `sourceCardinality: "one"` — the one-cardinality
   * wire carries the source id on the Relationship Update's
   * `source_id` field rather than via a separate entity Update.
   */
  sourceId?: string;
  /**
   * Source entity's Update. Required for `sourceCardinality: "many"`
   * — the canonical FK set lives on the source's data field, so the
   * entity Update carries `data.fields[as]`.
   */
  entityUpdate?: Update;
  /** Pointer value for `sourceCardinality: "one"` (default). String id or entity. */
  targetId?: PointerValue;
  /** Pointer value(s) for `sourceCardinality: "many"`. */
  targetIds?: ManyPointerValue;
  /**
   * Override the `subject_id` of the Relationship Update on the
   * wire. When set, `buildRelationshipWrite` uses this value instead
   * of minting a fresh id — required when deleting an existing
   * relationship by natural key (the wire Update's `subject_id`
   * must match the existing row's id for the server's authorizer
   * to recover the relationship's group).
   */
  relationshipSubjectId?: string;
  /**
   * Mints the Relationship row and Update ids. Defaults to core's
   * nanoid `generateId`; a caller that needs a deterministic batch
   * supplies its own seam.
   */
  newId?: (prefix: string) => string;
}

export interface BuildRelationshipWriteResult {
  /**
   * The source entity's FK Update. Present for `sourceCardinality: "many"`,
   * absent for `sourceCardinality: "one"`.
   */
  entityUpdate?: Update;
  /**
   * The Relationship row's Updates — one per component, or one `delete`.
   * Empty for `sourceCardinality: "many"` with no `targetIds`.
   */
  relationshipUpdates: readonly Update[];
}

/**
 * Normalize many-pointer values. Returns a flat array of distinct
 * string ids (or throws on bad input). For `{add, remove}` patches,
 * the caller computes the resulting set and passes it as `replace`.
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

/** One `replace` Update for one component of a freshly created row. */
const createComponent = (
  subjectId: string,
  model: string,
  field: string,
  value: unknown,
  updateId: string,
): Update => ({
  id: `${updateId}_${field}`,
  subject_id: subjectId,
  component: componentName(model, field),
  method: "replace",
  data: { value, update_id: `${updateId}_${field}` } as FieldValue,
});

/**
 * Build the wire-level Updates for a single link: one per component of the
 * Relationship row, or a single `delete` when the target is null.
 */
export function buildRelationshipUpdate(args: {
  relationshipId: string;
  sourceId: string;
  targetId: string | null;
  field: string;
  type: string;
  updateId: string;
}): Update[] {
  if (args.targetId === null) {
    return [
      {
        id: args.updateId,
        subject_id: args.relationshipId,
        method: "delete",
        data: null,
      },
    ];
  }
  return [
    createComponent(args.relationshipId, "relationship", "source_id", args.sourceId, args.updateId),
    createComponent(args.relationshipId, "relationship", "target_id", args.targetId, args.updateId),
    createComponent(args.relationshipId, "relationship", "type", args.type, args.updateId),
    createComponent(args.relationshipId, "relationship", "field", args.field, args.updateId),
  ];
}

/**
 * Build the Updates for an `entityGroup` membership row, scoping `entityId` to
 * `groupId`. One row per (entity, group), one Update per component.
 */
export function buildEntityGroupUpdate(args: {
  membershipId: string;
  entityId: string;
  groupId: string;
  updateId: string;
}): Update[] {
  return [
    createComponent(args.membershipId, "entityGroup", "entity_id", args.entityId, args.updateId),
    createComponent(args.membershipId, "entityGroup", "group_id", args.groupId, args.updateId),
  ];
}

/**
 * Build a `delete` Update for an existing `entityGroup` membership
 * row. The wire delete carries only the membership id; the server
 * recovers the entity/group from its by-id cache, so no `data` is
 * sent.
 */
export function buildEntityGroupDelete(args: { membershipId: string; updateId: string }): Update {
  return {
    id: args.updateId,
    subject_id: args.membershipId,
    method: "delete",
    data: null,
  };
}

/**
 * Build one `entityGroup` `put` Update per group. Shared by the
 * `createEntity` and `duplicateEntity` operations so membership
 * emission has one definition.
 */
export function buildEntityGroupUpdates(
  entityId: string,
  groupIds: readonly string[],
  generateUpdateId: () => string,
): Update[] {
  return groupIds.flatMap((groupId) =>
    buildEntityGroupUpdate({
      membershipId: entityGroupId(entityId, groupId),
      entityId,
      groupId,
      updateId: generateUpdateId(),
    }),
  );
}

/**
 * Build the Update for the source entity carrying the canonical FK set on its
 * declared component. Used by the many-cardinality relationship-write path:
 * the entity Update is one half of the wire shape, with N Relationship
 * Updates being the other half.
 *
 * It merges the one component: a replace would discard a concurrent writer's
 * siblings on a keyed component, and any other component of the row is
 * untouched either way.
 *
 * `hlc` is the freshly-minted local HLC; `updateId` is the Update's id. Both
 * surface in the leaf's `update_id` so the wire envelope is self-contained.
 */
export function buildManyEntityUpdate(args: {
  sourceId: string;
  sourceEntityName: string;
  as: string;
  targetIds: readonly string[];
  updateId: string;
  hlc: string;
}): Update {
  return {
    id: args.updateId,
    subject_id: args.sourceId,
    component: componentName(args.sourceEntityName, args.as),
    method: "merge",
    data: {
      value: [...args.targetIds],
      update_id: args.updateId,
      hlc: args.hlc,
    },
  };
}

/**
 * Normalize a many-pointer patch to a deduplicated id list, dropping
 * `null` / `undefined` entries (the caller already validated they're
 * not present). Used by the namespace's many-cardinality entry
 * point before constructing the canonical-FK Update.
 */
export function collectManyTargetIds(patch: ManyPointerValue): readonly string[] {
  const all: readonly PointerValue[] =
    "replace" in patch ? patch.replace : [...patch.add, ...patch.remove];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const v of all) {
    if (v === null || v === undefined) continue;
    const id = typeof v === "string" ? v : v.id;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
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

/** Build the Relationship row's Updates for one many-cardinality target. */
function makeManyRelationshipUpdate(
  sourceId: string,
  as: string,
  wireType: string,
  targetId: string,
  newId: (prefix: string) => string,
): Update[] {
  return buildRelationshipUpdate({
    relationshipId: newId("rel"),
    sourceId,
    targetId,
    field: as,
    type: wireType,
    updateId: newId("u"),
  });
}

/**
 * Resolve the `sourceId` from `BuildRelationshipWriteOptions`. The
 * one-cardinality wire doesn't carry an entity Update, so the caller
 * supplies `sourceId` directly.
 */
function requireSourceId(opts: BuildRelationshipWriteOptions, as: string): string {
  if (opts.sourceId !== undefined && opts.sourceId.length > 0) return opts.sourceId;
  throw new EntityValidationError([
    {
      entityName: opts.source.name,
      message: `buildRelationshipWrite: sourceId is required for one-cardinality relationship "${as}"`,
    },
  ]);
}

/**
 * Resolve the entity Update from `BuildRelationshipWriteOptions`. The
 * many-cardinality wire carries the canonical FK set on the source
 * entity's data field, so the entity Update is required.
 */
function requireEntityUpdate(opts: BuildRelationshipWriteOptions, as: string): Update {
  if (opts.entityUpdate !== undefined) return opts.entityUpdate;
  throw new EntityValidationError([
    {
      entityName: opts.source.name,
      message: `buildRelationshipWrite: entityUpdate is required for many-cardinality relationship "${as}"`,
    },
  ]);
}

/**
 * Build the wire Update(s) for a single relationship write. The sole
 * builder, shared by `SyncClient.buildRelationshipWrite` and the
 * `writeRelationship` operation.
 *
 * One-cardinality: a single Relationship Update addressed by
 * `sourceId` + `targetId` (`null` for a delete). Many-cardinality: one
 * entity Update carrying the canonical FK set plus one Relationship
 * Update per target.
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

  if (cardinality === "one") {
    const sourceId = requireSourceId(opts, as);
    const targetId = normalizePointer(opts.targetId, `targetId for "${as}"`);
    const updateId = newId("u");
    const relationshipId = opts.relationshipSubjectId ?? newId("rel");
    const relationshipUpdates = buildRelationshipUpdate({
      relationshipId,
      sourceId,
      targetId,
      field: as,
      type: wireTypeFor(registry, sourceName, as),
      updateId,
    });
    return { relationshipUpdates };
  }

  const entityUpdate = requireEntityUpdate(opts, as);
  const sourceId = entityUpdate.subject_id;
  const targetIds = opts.targetIds;
  const wireType = wireTypeFor(registry, sourceName, as);
  const updates: Update[] = [];
  if (targetIds === undefined) {
    // No `targetIds` — emit the entity Update with no relationship
    // edges, matching `targetId: null` on the one-cardinality side.
    return { entityUpdate, relationshipUpdates: updates };
  }
  if ("replace" in targetIds) {
    const normalized = normalizeManyPointers(targetIds, `targetIds for "${as}"`);
    for (const targetId of normalized) {
      updates.push(...makeManyRelationshipUpdate(sourceId, as, wireType, targetId, newId));
    }
  } else {
    for (const targetId of targetIds.add) {
      const id = normalizePointer(targetId, `targetIds.add for "${as}"`);
      if (id === null) continue;
      updates.push(...makeManyRelationshipUpdate(sourceId, as, wireType, id, newId));
    }
    for (const targetId of targetIds.remove) {
      const id = normalizePointer(targetId, `targetIds.remove for "${as}"`);
      if (id === null) continue;
      updates.push(...makeManyRelationshipUpdate(sourceId, as, wireType, id, newId));
    }
  }
  return { entityUpdate, relationshipUpdates: updates };
}
