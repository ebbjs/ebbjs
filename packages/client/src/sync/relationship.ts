/**
 * Runtime handle for a single registered relationship.
 *
 * `client.relationship({source, target, as})` returns one of these.
 * Mirrors the `client.textDocument(docId)` precedent — a regular
 * method on `SyncClient`, not a Proxy-mounted instance property.
 *
 * The handle is namespace-independent (#158's job): it works without
 * a `defineSchema` (#150) and operates against the client's
 * materialized cache + the existing outbox.
 */

import type { Entity } from "@ebbjs/core";

import type { EntityRegistry } from "../schema/entity-registry";

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
 * validation time, consistent with #143's "validate before encode"
 * stance. The wire always carries ids.
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
   * The entity's own Update — must carry `subject_id` and
   * `subject_type === source.name`. The relationship's pointer value
   * is stripped from this Update (it lives on `targetId`/`targetIds`
   * instead) so the same shape works for `client.write()`.
   */
  entityUpdate: import("@ebbjs/core").Update;
  /** Pointer value for `sourceCardinality: "one"` (default). String id or entity. */
  targetId?: PointerValue;
  /** Pointer value(s) for `sourceCardinality: "many"`. */
  targetIds?: ManyPointerValue;
}

export interface BuildRelationshipWriteResult {
  /** The entity Update, with the relationship field stripped if present. */
  entityUpdate: import("@ebbjs/core").Update;
  /**
   * The relationship Update(s) produced. Single Update for
   * `sourceCardinality: "one"`; an array (possibly empty) for
   * `sourceCardinality: "many"`. The wire accepts a mix of
   * put/patch/delete updates; the developer's write call flattens
   * the result into one Action.
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

/**
 * Filter chain for relationship traversal. The same chain is
 * returned by reverse accessors and by `sourceCardinality: "many"`
 * forward accessors. `find()` materializes against the client's
 * local cache.
 *
 * The chain is immutable: every method returns a new builder with
 * the constraint added. This keeps the handle reusable across calls
 * without surprising state.
 */
export interface QueryBuilder<T> {
  /** Equality filter on a field of `T`. */
  eq(field: string, value: unknown): QueryBuilder<T>;
  /** Ordering on a field of `T`. */
  orderBy(field: string, direction: "asc" | "desc"): QueryBuilder<T>;
  /** Maximum number of rows. */
  limit(n: number): QueryBuilder<T>;
  /** Materialize the chain against the client's local cache. */
  find(): Promise<readonly T[]>;
}

/** Chainable filter descriptor — accumulated by `eq`. */
type EqFilter = { field: string; value: unknown };
type OrderBy = { field: string; direction: "asc" | "desc" };

/**
 * Build a QueryBuilder over a list of candidate entities. The
 * `loadEntities` callback hydrates ids → Entity; the chain applies
 * eq / orderBy / limit on top.
 *
 * Each chain method returns a *new* builder with the new constraint
 * appended — the original is untouched, so the same builder can be
 * reused across callers without surprising state.
 */
export function buildQueryBuilder<T extends Entity>(candidates: readonly T[]): QueryBuilder<T> {
  const make = (
    filters: readonly EqFilter[],
    order: OrderBy | null,
    limitN: number | null,
  ): QueryBuilder<T> => {
    const apply = (rows: readonly T[]): T[] => {
      let out = rows.slice();
      if (filters.length > 0) {
        out = out.filter((row) => filters.every((f) => eqField(row, f.field, f.value)));
      }
      if (order !== null) {
        const { field, direction } = order;
        out.sort((a, b) => cmpField(a, b, field, direction));
      }
      if (limitN !== null && limitN >= 0) {
        out = out.slice(0, limitN);
      }
      return out;
    };
    return {
      eq(field: string, value: unknown): QueryBuilder<T> {
        return make([...filters, { field, value }], order, limitN);
      },
      orderBy(field: string, direction: "asc" | "desc"): QueryBuilder<T> {
        return make(filters, { field, direction }, limitN);
      },
      limit(n: number): QueryBuilder<T> {
        return make(filters, order, n);
      },
      async find(): Promise<readonly T[]> {
        return apply(candidates);
      },
    };
  };
  return make([], null, null);
}

/** Pull `data.fields[field].value` off an Entity, returning `undefined` when absent. */
function fieldValue(entity: Entity, field: string): unknown {
  const fv = entity.data?.fields?.[field];
  if (fv === undefined) return undefined;
  return fv.value;
}

function eqField(entity: Entity, field: string, value: unknown): boolean {
  return fieldValue(entity, field) === value;
}

function cmpField(a: Entity, b: Entity, field: string, direction: "asc" | "desc"): number {
  const av = fieldValue(a, field);
  const bv = fieldValue(b, field);
  if (av === bv) return 0;
  if (av === undefined) return 1;
  if (bv === undefined) return -1;
  if (typeof av === "number" && typeof bv === "number") {
    return direction === "asc" ? av - bv : bv - av;
  }
  const as = String(av);
  const bs = String(bv);
  return direction === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
}

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
 * Build a forward-singular accessor result. For
 * `sourceCardinality: "one"` the source entity holds a single FK
 * (`string | undefined`). We materialize the source and follow the
 * pointer to the target.
 *
 * Returns `undefined` for both "the source has no pointer" and "the
 * target id is unknown"; callers don't distinguish (a `null` FK and a
 * dangling FK are both "no target").
 */
export async function forwardOne(
  readLocalEntity: (id: string) => Promise<Entity | null>,
  sourceId: string,
  sourceName: string,
  field: string,
): Promise<Entity | undefined> {
  const source = await readLocalEntity(sourceId);
  if (source === null) return undefined;
  if (source.type !== sourceName) return undefined;
  const fv = source.data?.fields?.[field];
  if (fv === undefined) return undefined;
  if (fv.value === null || fv.value === undefined) return undefined;
  if (typeof fv.value !== "string") return undefined;
  const target = await readLocalEntity(fv.value);
  return target ?? undefined;
}

/**
 * Build a forward-many accessor result. The source entity's field
 * holds an array of FKs; we materialize the source, collect the ids,
 * load each target, and return a QueryBuilder over the loaded
 * entities.
 */
export async function forwardMany(
  readLocalEntity: (id: string) => Promise<Entity | null>,
  queryEntitiesByType: (type: string) => Promise<readonly Entity[]>,
  sourceId: string,
  sourceName: string,
  targetName: string,
  field: string,
): Promise<QueryBuilder<Entity>> {
  const source = await readLocalEntity(sourceId);
  if (source === null) {
    return buildQueryBuilder<Entity>([]);
  }
  if (source.type !== sourceName) {
    return buildQueryBuilder<Entity>([]);
  }
  const fv = source.data?.fields?.[field];
  if (fv === undefined || fv.value === null || fv.value === undefined) {
    return buildQueryBuilder<Entity>([]);
  }
  if (!Array.isArray(fv.value)) {
    return buildQueryBuilder<Entity>([]);
  }
  const ids = fv.value.filter((v): v is string => typeof v === "string");
  // The source holds the canonical set; we don't need to filter via
  // Relationship entities here (the set IS the relationship list).
  // Load every materialized entity of `targetName` and intersect.
  const allTargets = await queryEntitiesByType(targetName);
  const idSet = new Set(ids);
  return buildQueryBuilder(allTargets.filter((t) => idSet.has(t.id)));
}

/**
 * Build a reverse accessor result. We scan the cache for `Relationship`
 * entities with `target_id === targetId` and the matching `field`/`type`,
 * then load each `source_id`.
 */
export async function reverse(
  readLocalEntity: (id: string) => Promise<Entity | null>,
  queryEntitiesByType: (type: string) => Promise<readonly Entity[]>,
  targetId: string,
  sourceName: string,
  field: string,
  type: string,
): Promise<QueryBuilder<Entity>> {
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
  return buildQueryBuilder(allSources.filter((s) => idSet.has(s.id)));
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
