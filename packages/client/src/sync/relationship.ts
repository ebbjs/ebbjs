/**
 * Runtime handle for a single registered relationship.
 *
 * `client.relationship({source, target, as})` returns one of these.
 * Mirrors the `client.textDocument(docId)` precedent — a regular
 * method on `SyncClient`, not a Proxy-mounted instance property.
 *
 * The handle is namespace-independent: it operates against the
 * client's materialized cache + the existing outbox without
 * requiring a top-level schema.
 */

import type { Entity } from "@ebbjs/core";
import type { TObject, TSchema } from "@sinclair/typebox/type";

import type { EntityRegistry } from "../schema/entity-registry";
import { type LoadEntities, type QueryBuilder, buildLazyQueryBuilder } from "./query-builder";

/**
 * Inputs to `client.relationship({...})`. Mirrors `defineRelationship`
 * but lighter — `sourceCardinality` and `type` come from the
 * registry's stored relationship rather than from this call site, so
 * `as` alone disambiguates between two relationships on the same
 * source/target pair (with different `type` overrides).
 */
export interface RelationshipHandleInput {
  source: { readonly name: string };
  target: { readonly name: string };
  as: string;
}

/**
 * A single pointer value. Accepts either:
 * - a string id
 * - a materialized entity (anything with a string `.id`)
 *
 * Anything else is rejected by `buildRelationshipWrite` at
 * validation time. The wire always carries ids.
 */
export type PointerValue = string | { readonly id: string } | null | undefined;

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
  entityUpdate?: import("@ebbjs/core").Update;
  /** Pointer value for `sourceCardinality: "one"` (default). String id or entity. */
  targetId?: PointerValue;
  /** Pointer value(s) for `sourceCardinality: "many"`. */
  targetIds?: ManyPointerValue;
}

export interface BuildRelationshipWriteResult {
  /**
   * The entity Update. Present for `sourceCardinality: "many"`,
   * absent for `sourceCardinality: "one"`.
   */
  entityUpdate?: import("@ebbjs/core").Update;
  /**
   * Single Update for `sourceCardinality: "one"`; an array
   * (possibly empty) for `sourceCardinality: "many"`.
   */
  relationshipUpdate: import("@ebbjs/core").Update | readonly import("@ebbjs/core").Update[];
}

/**
 * Normalize a pointer value to a string id.
 * Returns `null` for `null`/`undefined` (clear semantics);
 * throws `EntityValidationError` for anything that isn't a string
 * or an entity-shape object with a string `.id`.
 */
export function normalizePointer(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (value.length === 0) {
      throw new Error(`${label}: empty string is not a valid pointer id`);
    }
    return value;
  }
  if (typeof value === "object") {
    const obj = value as { id?: unknown };
    if (typeof obj.id === "string" && obj.id.length > 0) {
      return obj.id;
    }
    throw new Error(`${label}: object pointer must have a non-empty string .id`);
  }
  throw new Error(`${label}: pointer must be a string id, an entity with .id, or null/undefined`);
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

/** Re-exported from `./query-builder` so existing imports of `QueryBuilder` from `../sync/relationship` resolve. */
export type { QueryBuilder } from "./query-builder";

/** Re-exported from `./query-builder` for the same reason. */
export { buildQueryBuilder } from "./query-builder";

/**
 * Walk the local cache to collect all `Relationship` entities whose
 * `data.fields.field` matches the given accessor name and whose
 * `data.fields.type` matches the relationship's `type` string. The
 * reverse accessor and the many-forward accessor both call this.
 */
export function findRelationshipsByField(
  entities: readonly Entity[],
  field: string,
  type: string,
): readonly Entity[] {
  return entities.filter((e) => {
    if (e.type !== "relationship") return false;
    if (e.deleted_hlc !== null) return false;
    const f = e.data?.fields?.["field"];
    const t = e.data?.fields?.["type"];
    return f?.value === field && t?.value === type;
  });
}

/**
 * Find the single target id for a one-cardinality forward
 * relationship. Scans the cache for `Relationship` entities with
 * `source_id === sourceId` and matching `field`/`type`.
 *
 * Returns:
 * - `null` when no edge exists (the link was cleared or never set)
 * - `string` when an edge exists (target may be dangling — callers
 *   decide whether dangling reads as `undefined` via
 *   {@link resolveForwardOne})
 */
function findForwardOneTargetId(
  entities: readonly Entity[],
  sourceId: string,
  field: string,
  type: string,
): string | null {
  const matching = findRelationshipsByField(entities, field, type).filter((rel) => {
    const s = rel.data?.fields?.["source_id"];
    return s?.value === sourceId;
  });
  if (matching.length === 0) return null;
  const targetId = matching[0]?.data?.fields?.["target_id"]?.value;
  return typeof targetId === "string" ? targetId : null;
}

/**
 * Build a forward-singular accessor result. For
 * `sourceCardinality: "one"` the canonical FK lives on a materialized
 * `Relationship` entity (scanned by `source_id + field + type`), not
 * on the source entity's data fields. Users don't have to declare
 * the FK field on the source — `defineRelationship({source, target,
 * as})` alone wires the link.
 *
 * Returns:
 * - `null` when no Relationship record exists for `(sourceId, field,
 *   type)` — the link was cleared or never set
 * - `undefined` when an edge exists in metadata but the target id is
 *   dangling (target missing from the cache)
 * - `Entity` when both the edge and target resolve
 *
 * Source-mismatch (`source.type !== sourceName`) and missing-source
 * also return `undefined` to keep the surface uniform with the other
 * accessors.
 */
export async function forwardOne(
  readLocalEntity: (id: string) => Promise<Entity | null>,
  queryEntitiesByType: (type: string) => Promise<readonly Entity[]>,
  sourceId: string,
  sourceName: string,
  field: string,
  type: string,
): Promise<Entity | null | undefined> {
  const source = await readLocalEntity(sourceId);
  if (source === null) return undefined;
  if (source.type !== sourceName) return undefined;
  const all = await queryEntitiesByType("relationship");
  const targetId = findForwardOneTargetId(all, sourceId, field, type);
  if (targetId === null) return null;
  const target = await readLocalEntity(targetId);
  return target ?? undefined;
}

/**
 * Build a forward-many accessor result. The canonical FK set lives
 * on materialized `Relationship` entities (scanned by `source_id +
 * field + type`), not on the source entity's data fields. The set
 * of matching target ids is the relationship's set of links.
 *
 * `targetShape` drives the projection on `await qb` — the chain is
 * generic over the target entity's field map.
 *
 * Synchronous: the chain defers the storage reads to a `LoadEntities`
 * callback so the builder is thenable without an outer Promise.
 */
export function forwardMany<TFields extends Record<string, TSchema>>(
  readLocalEntity: (id: string) => Promise<Entity | null>,
  queryEntitiesByType: (type: string) => Promise<readonly Entity[]>,
  sourceId: string,
  sourceName: string,
  targetName: string,
  targetShape: TObject<TFields>,
  field: string,
  type: string,
): QueryBuilder<TFields> {
  const loader: LoadEntities = async () => {
    const source = await readLocalEntity(sourceId);
    if (source === null) return [];
    if (source.type !== sourceName) return [];
    const all = await queryEntitiesByType("relationship");
    const ids = findRelationshipsByField(all, field, type)
      .filter((rel) => rel.data?.fields?.["source_id"]?.value === sourceId)
      .map((rel) => rel.data?.fields?.["target_id"]?.value)
      .filter((v): v is string => typeof v === "string");
    const idSet = new Set(ids);
    const allTargets = await queryEntitiesByType(targetName);
    return allTargets.filter((t) => idSet.has(t.id));
  };
  return buildLazyQueryBuilder(loader, targetShape);
}

/**
 * Build a reverse accessor result. We scan the cache for `Relationship`
 * entities with `target_id === targetId` and the matching `field`/`type`,
 * then load each `source_id`.
 *
 * `sourceShape` drives the projection on `await qb` — the chain is
 * generic over the source entity's field map.
 *
 * Synchronous: the chain defers the storage reads to a `LoadEntities`
 * callback so the builder is thenable without an outer Promise.
 */
export function reverse<TFields extends Record<string, TSchema>>(
  readLocalEntity: (id: string) => Promise<Entity | null>,
  queryEntitiesByType: (type: string) => Promise<readonly Entity[]>,
  targetId: string,
  sourceName: string,
  sourceShape: TObject<TFields>,
  field: string,
  type: string,
): QueryBuilder<TFields> {
  const loader: LoadEntities = async () => {
    const all = await queryEntitiesByType("relationship");
    const matching = findRelationshipsByField(all, field, type).filter((rel) => {
      const t = rel.data?.fields?.["target_id"];
      return t?.value === targetId;
    });
    const sourceIds = matching
      .map((rel) => rel.data?.fields?.["source_id"]?.value)
      .filter((v): v is string => typeof v === "string");
    const allSources = await queryEntitiesByType(sourceName);
    const idSet = new Set(sourceIds);
    return allSources.filter((s) => idSet.has(s.id));
  };
  return buildLazyQueryBuilder(loader, sourceShape);
}

/**
 * Resolve the relationship's effective cardinality. The explicit
 * `sourceCardinality` override on the call wins; otherwise we look
 * up the registry.
 */
export function resolveCardinality(
  registry: EntityRegistry,
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

/**
 * Build the wire-level `Relationship` Update for a single link.
 * Returns `method: "delete"` when the target is null; otherwise
 * `method: "put"` with the four standard fields.
 */
export function buildRelationshipUpdate(args: {
  relationshipId: string;
  sourceId: string;
  targetId: string | null;
  field: string;
  type: string;
  updateId: string;
}): import("@ebbjs/core").Update {
  if (args.targetId === null) {
    return {
      id: args.updateId,
      subject_id: args.relationshipId,
      subject_type: "relationship",
      method: "delete",
      data: null,
    };
  }
  return {
    id: args.updateId,
    subject_id: args.relationshipId,
    subject_type: "relationship",
    method: "put",
    data: {
      fields: {
        source_id: { value: args.sourceId, update_id: args.updateId },
        target_id: { value: args.targetId, update_id: args.updateId },
        type: { value: args.type, update_id: args.updateId },
        field: { value: args.field, update_id: args.updateId },
      },
    },
  };
}

/**
 * Build a `put` Update for the source entity carrying the canonical
 * FK set on `data.fields[as]`. Used by the many-cardinality
 * relationship-write path: the entity Update is one half of the
 * wire shape, with N `Relationship` Updates being the other half.
 *
 * `hlc` is the freshly-minted local HLC; `updateId` is the Update's
 * id. Both surface in the field's `update_id` so the wire envelope
 * is self-contained.
 */
export function buildManyEntityUpdate(args: {
  sourceId: string;
  sourceEntityName: string;
  as: string;
  targetIds: readonly string[];
  updateId: string;
  hlc: string;
}): import("@ebbjs/core").Update {
  return {
    id: args.updateId,
    subject_id: args.sourceId,
    subject_type: args.sourceEntityName,
    method: "put",
    data: {
      fields: {
        [args.as]: {
          value: [...args.targetIds],
          update_id: args.updateId,
          hlc: args.hlc,
        },
      },
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
