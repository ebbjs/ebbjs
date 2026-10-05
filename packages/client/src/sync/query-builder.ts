/**
 * Typed thenable QueryBuilder.
 *
 * `await qb` resolves to `readonly Static<TObject<ShapeFields<TFields>>>[]` after
 * projecting each materialized entity to the schema's TypeBox shape.
 * The chain mutators (`where` / `orderBy` / `limit`) are typed against
 * the field map: a field key narrows to `keyof TFields` and its value
 * to the field's TypeBox static type. A key that names a registered
 * relationship on the entity filters that edge instead — see
 * {@link QueryContext}. The reserved `groups` key filters built-in
 * membership by scanning `entityGroup` rows (no storage membership
 * index yet — #267). Relationship and membership predicates read
 * storage, so the filter pass is asynchronous; every terminal already
 * is.
 *
 * The terminal methods materialize the chain:
 * - `await qb` / `.then(...)` — projected rows.
 * - `.first()` — first projected survivor, or `undefined`.
 * - `.count()` — number of survivors.
 * - `.exists()` — whether any row survives.
 * - `[Symbol.asyncIterator]()` — streaming iterator of projected rows.
 * - `.toRaw()` — untyped escape hatch returning `readonly Entity[]`.
 *
 * The builder is thenable (has a `.then` method), not a Promise, so
 * `await qb` and `qb.then(...)` work via the standard thenable
 * protocol. Each chain method returns a new builder; the original
 * is untouched.
 */

import type { Entity } from "@ebbjs/core";
import type { StorageAdapter } from "@ebbjs/storage/types";
import { Value } from "@sinclair/typebox/value";
import type { Static, TObject, TSchema } from "@sinclair/typebox/type";
import type { ShapeFields } from "../schema/entity";
import { EntityValidationError, type EntityRegistry } from "../schema/entity-registry";
import { GROUPS_ACCESSOR } from "../schema/system-entities";
import { liveMembership } from "./entity-group";

/**
 * Map a single materialized entity onto the schema's TypeBox shape.
 * Pure: the entity is read-only; the projected row is a fresh object.
 *
 * Three projection states per field:
 * - `data.fields[K].value = V` (set)     → `V`
 * - `data.fields[K].value = null`        → `null`
 * - `data.fields[K]` absent              → `undefined`
 */
export function projectEntity<TFields extends Record<string, TSchema>>(
  entity: Entity,
  shape: TObject<TFields>,
): Static<TObject<ShapeFields<TFields>>> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape.properties) as (keyof TFields & string)[]) {
    const field = entity.data?.fields?.[key];
    out[key] = field === undefined ? undefined : field.value;
  }
  return out as Static<TObject<ShapeFields<TFields>>>;
}

/** Project every row in a list. Pure. */
export function projectRows<TFields extends Record<string, TSchema>>(
  rows: readonly Entity[],
  shape: TObject<TFields>,
): readonly Static<TObject<ShapeFields<TFields>>>[] {
  return rows.map((row) => projectEntity(row, shape));
}

/**
 * A single pointer value accepted by a relationship predicate:
 * - a string id
 * - a handle with a string `.id` (a materialized entity, say)
 * - `null` / `undefined` — no live edge (see {@link resolveTargetIds})
 *
 * Defined here so this module need not import `./relationship`
 * (which imports this module) to name the type; `./relationship`
 * re-exports it for existing callers.
 */
export type PointerValue = string | { readonly id: string } | null | undefined;

/**
 * Normalize a pointer value to a string id. `null` / `undefined`
 * normalize to `null`; anything that is neither a string nor an
 * object with a non-empty string `.id` throws. Shared by the
 * relationship-write path and the relationship predicate.
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
 * Everything `where` needs to infer and execute a relationship
 * predicate. Threaded from the entity namespace, which owns the
 * storage adapter and the client's registry. Bare builders built from
 * a row list carry no context; there, a key that isn't a field is
 * rejected rather than inferred as an edge.
 */
export interface QueryContext {
  readonly entityName: string;
  readonly registry: EntityRegistry;
  readonly storage: StorageAdapter;
}

/** Filter over a data field. Value equality is strict. */
type FieldFilter = { readonly kind: "field"; readonly key: string; readonly value: unknown };

/**
 * Filter over a relationship edge. `targetIds` is the resolved any-of
 * set, or `null` when the pointer names no live edge — that matches
 * nothing. `context` is captured when the filter is built: the
 * registry resolved the edge at build time, and only `.storage` is
 * read at apply time.
 */
type RelationshipFilter = {
  readonly kind: "relationship";
  readonly as: string;
  readonly type: string;
  readonly targetIds: readonly string[] | null;
  readonly context: QueryContext;
};

/**
 * Filter over built-in group membership. `targetIds` is the resolved
 * any-of group-id set, or `null` when the pointer names no group —
 * that matches nothing. `context` carries the adapter the
 * `entityGroup` scan needs, captured when the filter is built.
 */
type MembershipFilter = {
  readonly kind: "membership";
  readonly targetIds: readonly string[] | null;
  readonly context: QueryContext;
};

type Filter = FieldFilter | RelationshipFilter | MembershipFilter;

/** Ordering descriptor accumulated by `orderBy`. */
type OrderBy = { field: string; direction: "asc" | "desc" };

/** Loader for the candidate entity list. Resolved lazily on each materialization. */
export type LoadEntities = () => Promise<readonly Entity[]>;

/**
 * Typed thenable chain over a list of candidate entities. The same
 * chain is consumed by `client.<entity>.query()` and by the
 * relationship accessors on a projected row — one chain, one
 * projection.
 */
export interface QueryBuilder<TFields extends Record<string, TSchema>> {
  /**
   * Equality predicate. A registered relationship key filters that
   * edge — relationship wins over a same-named field, matching the row
   * accessors. The reserved `groups` key filters built-in membership.
   * Any other key filters the data field. Field values narrow to the
   * field's static type; relationship targets accept an id, a handle,
   * or an array meaning any-of. Chained calls are ANDed.
   */
  where<K extends keyof TFields & string>(key: K, value: Static<TFields[K]>): QueryBuilder<TFields>;
  /**
   * Relationship-target overload. It stays open over every key because
   * the registry decides field vs. edge at runtime and a relationship
   * wins a same-named field — so any field-named key may be an edge.
   * Typing the exact relationship keys is the #181 follow-up.
   */
  where(key: string, target: PointerValue | readonly PointerValue[]): QueryBuilder<TFields>;
  /** Ordering on a field of `TFields`. */
  orderBy<K extends keyof TFields & string>(
    field: K,
    direction: "asc" | "desc",
  ): QueryBuilder<TFields>;
  /** Maximum number of rows. */
  limit(n: number): QueryBuilder<TFields>;
  /** First projected survivor, or `undefined` when the chain is empty. */
  first(): Promise<Static<TObject<ShapeFields<TFields>>> | undefined>;
  /** Count of survivors after the chain runs. */
  count(): Promise<number>;
  /** `true` when at least one row survives the chain. */
  exists(): Promise<boolean>;
  /** Streaming iterator over projected survivors. */
  [Symbol.asyncIterator](): AsyncIterableIterator<Static<TObject<ShapeFields<TFields>>>>;
  /** Materialize the untyped entities, skipping the projection. */
  toRaw(): Promise<readonly Entity[]>;
  /**
   * Reactive trigger scoped to the chain's source entity type: fires
   * whenever any entity of that type materializes. Terminal methods
   * read the latest snapshot, so a listener re-materializes to observe
   * the new result. No-op when the builder carries no query context or
   * the adapter ships no change emitter.
   *
   * Deliberately coarser than `EntityNamespace.subscribe`: a source
   * entity field change fires even when the chain's filters would
   * exclude it, leaving the consumer to suppress spurious work by
   * comparing snapshots. That is what lets a matching row whose
   * non-filtered field changed wake the chain — the membership-only
   * listener would stay silent. Relationship and membership filters
   * are a known limitation: a change to a bare `relationship` row (or
   * an `entityGroup` row) does not fire this source-type trigger.
   */
  subscribe(listener: () => void): () => void;
  /** Thenable — `await qb` resolves to the projected rows. */
  then<TResult1 = readonly Static<TObject<ShapeFields<TFields>>>[], TResult2 = never>(
    onfulfilled?:
      | ((
          value: readonly Static<TObject<ShapeFields<TFields>>>[],
        ) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2>;
}

/**
 * Build a QueryBuilder over a list of candidate entities. The chain
 * applies `where` / `orderBy` / `limit` on top; awaiting the builder
 * projects every survivor to the schema's TypeBox shape.
 *
 * Each chain method returns a new builder with the new constraint
 * appended — the original is untouched, so the same builder can be
 * reused across callers without surprising state.
 */
export function buildQueryBuilder<TFields extends Record<string, TSchema>>(
  candidates: readonly Entity[],
  shape: TObject<TFields>,
  context?: QueryContext,
): QueryBuilder<TFields> {
  const loader: LoadEntities = async () => candidates;
  return buildLazyQueryBuilder(loader, shape, context);
}

/**
 * Like {@link buildQueryBuilder} but with a lazy candidate loader.
 * The loader is called every time the chain materializes (via
 * `await qb` or `.toRaw()`) so the chain reflects the latest
 * snapshot of the underlying store.
 */
export function buildLazyQueryBuilder<TFields extends Record<string, TSchema>>(
  loadCandidates: LoadEntities,
  shape: TObject<TFields>,
  context?: QueryContext,
): QueryBuilder<TFields> {
  const make = (
    filters: readonly Filter[],
    order: OrderBy | null,
    limitN: number | null,
  ): QueryBuilder<TFields> => {
    const apply = async (rows: readonly Entity[]): Promise<Entity[]> => {
      let out = await applyFilters(rows, filters);
      if (order !== null) {
        const { field, direction } = order;
        out.sort((a, b) => cmpField(a, b, field, direction));
      }
      if (limitN !== null && limitN >= 0) {
        out = out.slice(0, limitN);
      }
      return out;
    };
    const builder: QueryBuilder<TFields> = {
      where(key: string, target: unknown) {
        return make([...filters, buildFilter(key, target, shape, context)], order, limitN);
      },
      orderBy(field, direction) {
        return make(filters, { field, direction }, limitN);
      },
      limit(n) {
        return make(filters, order, n);
      },
      async first() {
        const candidates = await loadCandidates();
        const survivors = await apply(candidates);
        const head = survivors[0];
        return head === undefined ? undefined : projectEntity(head, shape);
      },
      async count() {
        const candidates = await loadCandidates();
        return (await apply(candidates)).length;
      },
      async exists() {
        const candidates = await loadCandidates();
        return (await apply(candidates)).length > 0;
      },
      [Symbol.asyncIterator]() {
        const iter = async function* () {
          const candidates = await loadCandidates();
          for (const row of await apply(candidates)) {
            yield projectEntity(row, shape);
          }
        };
        return iter();
      },
      async toRaw() {
        const candidates = await loadCandidates();
        return apply(candidates);
      },
      subscribe(listener) {
        const emitter = context?.storage.changeEmitter;
        if (emitter === undefined || context === undefined) return () => {};
        return emitter.onTypeChange(context.entityName, () => listener());
      },
      // oxlint-disable-next-line no-thenable -- the QueryBuilder is intentionally a thenable; awaiting it projects the chain.
      then(onfulfilled, onrejected) {
        // Forward `onrejected` onto the whole lazy chain, not just the
        // projection step: a rejecting candidate loader must settle the
        // awaited builder as a rejection rather than leaving it pending.
        return loadCandidates()
          .then(async (candidates) => projectRows(await apply(candidates), shape))
          .then(onfulfilled, onrejected);
      },
    };
    return builder;
  };
  return make([], null, null);
}

/**
 * Turn one `where` argument into a filter. A registered forward
 * relationship on the entity wins over a same-named field; an unknown
 * key throws rather than silently matching nothing.
 */
function buildFilter<TFields extends Record<string, TSchema>>(
  key: string,
  value: unknown,
  shape: TObject<TFields>,
  context: QueryContext | undefined,
): Filter {
  // `groups` is reserved, so it can never be a declared relationship or
  // a field. With a query context it always means built-in membership,
  // which needs a storage adapter to scan `entityGroup`; a bare builder
  // carries no adapter, so the key falls through to the unknown-field
  // throw below.
  if (key === GROUPS_ACCESSOR && context !== undefined) {
    const label = `where("${GROUPS_ACCESSOR}") on "${context.entityName}"`;
    return {
      kind: "membership",
      targetIds: resolveTargetIds(value as PointerValue | readonly PointerValue[], label),
      context,
    };
  }
  const rel =
    context === undefined ? undefined : context.registry.getRelationship(context.entityName, key);
  if (rel !== undefined && context !== undefined) {
    const label = `where("${key}") on "${context.entityName}"`;
    return {
      kind: "relationship",
      as: key,
      type: rel.type,
      targetIds: resolveTargetIds(value as PointerValue | readonly PointerValue[], label),
      context,
    };
  }
  if (Object.prototype.hasOwnProperty.call(shape.properties, key)) {
    const entityName = context?.entityName ?? "(unknown)";
    // A non-null object or array may have missed the registry and landed
    // here as a field predicate. Accept it only when the field's declared
    // type admits it (array/object-typed fields stay filterable); otherwise
    // reject rather than compare a scalar to an object/array and match nothing.
    if (value !== null && typeof value === "object" && !Value.Check(shape.properties[key], value)) {
      throw new EntityValidationError([
        {
          entityName,
          field: key,
          message: `where("${key}"): array/object values are only valid for a relationship key or a field whose declared type accepts them`,
        },
      ]);
    }
    return { kind: "field", key, value };
  }
  const entityName = context?.entityName ?? "(unknown)";
  throw new EntityValidationError([
    {
      entityName,
      field: key,
      message: `where("${key}"): not a field on "${entityName}" and not a declared relationship`,
    },
  ]);
}

/**
 * Resolve a relationship predicate's pointer(s) to a deduplicated
 * any-of id set. An empty set (an empty array, or every entry
 * null/undefined) becomes `null`: the pointer names no live edge, so
 * the predicate matches nothing.
 */
function resolveTargetIds(
  value: PointerValue | readonly PointerValue[],
  label: string,
): readonly string[] | null {
  const list = Array.isArray(value) ? (value as readonly PointerValue[]) : [value as PointerValue];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const id = normalizePointer(entry, label);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.length === 0 ? null : ids;
}

/** Apply every filter in order; the pass is async because membership and relationship filters read storage. */
async function applyFilters(
  rows: readonly Entity[],
  filters: readonly Filter[],
): Promise<Entity[]> {
  let out = rows.slice();
  for (const filter of filters) {
    if (filter.kind === "field") {
      out = out.filter((row) => eqField(row, filter.key, filter.value));
      continue;
    }
    if (filter.kind === "membership") {
      const ids = await membershipIdSet(filter);
      out = out.filter((row) => ids.has(row.id));
      continue;
    }
    const ids = await relationshipIdSet(filter);
    out = out.filter((row) => ids.has(row.id));
  }
  return out;
}

/**
 * Union the index hits across a relationship filter's targets. The
 * index returns source ids for `(as, type, targetId)`, so any-of is a
 * union and chained filters intersect by filtering the row list in
 * turn.
 */
async function relationshipIdSet(filter: RelationshipFilter): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  if (filter.targetIds === null) return ids;
  const perTarget = await Promise.all(
    filter.targetIds.map((targetId) =>
      filter.context.storage.entities.queryByRelationship({
        as: filter.as,
        type: filter.type,
        targetId,
      }),
    ),
  );
  for (const sourceIds of perTarget) {
    for (const id of sourceIds) ids.add(id);
  }
  return ids;
}

/**
 * Resolve a membership filter to the set of member entity ids. Storage
 * has no membership index yet (#267), so this scans every live
 * `entityGroup` row and keeps those whose `group_id` the predicate
 * names. A tombstoned row is not a membership.
 */
async function membershipIdSet(filter: MembershipFilter): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  if (filter.targetIds === null) return ids;
  const groupIds = new Set(filter.targetIds);
  const rows = await filter.context.storage.entities.query("entityGroup");
  for (const row of rows) {
    const membership = liveMembership(row);
    if (membership === null) continue;
    if (!groupIds.has(membership.groupId)) continue;
    ids.add(membership.entityId);
  }
  return ids;
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
