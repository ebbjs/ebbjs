/**
 * Typed thenable QueryBuilder.
 *
 * `await qb` resolves to `readonly ProjectedRow<TFields>[]` after
 * projecting each materialized entity to the schema's TypeBox shape.
 * A projected row carries the shape's fields plus the entity's `id` —
 * an addressing key, not envelope access. Raw wire access stays on
 * `.toRaw()` (collections) and the `EntitySnapshot` passed to
 * `subscribe` (single rows).
 * The chain mutators (`where` / `or` / `orderBy` / `limit`) are typed
 * against the field map: a field key narrows to `keyof TFields` and
 * its value to the field's TypeBox static type. A key that names a
 * registered relationship on the entity filters that edge instead —
 * see {@link QueryContext}. The reserved `groups` key filters built-in
 * membership.
 *
 * The chain accumulates a serializable {@link Query} (epic decision 13)
 * exposed through {@link QueryBuilder.toQuery}. Predicates are a
 * disjunction of AND-groups (DNF): `.where` adds a conjunct to the
 * current group, `.or` closes it and starts a new one, so
 * `.where(a).where(b).or(c).where(d)` means
 * `(a AND b) OR (c AND d)`. A leading `.or` starts the first group
 * rather than matching every row.
 *
 * Every terminal plans the query and executes the plan synchronously:
 * a replica-backed chain hydrates the replica and reads its rows and
 * adjacency indices; a chain over an already-materialized candidate
 * list runs against those rows. The builder is async only because
 * hydration and the candidate loader are.
 *
 * The terminal methods materialize the chain:
 * - `await qb` / `.then(...)` — projected rows.
 * - `.first()` — first projected survivor, or `undefined`.
 * - `.count()` — number of survivors.
 * - `.exists()` — whether any row survives.
 * - `[Symbol.asyncIterator]()` — streaming iterator of projected rows.
 * - `.toRaw()` — untyped escape hatch returning `readonly Entity[]`.
 *
 * Every terminal reads live rows: a tombstoned row (`deleted_hlc` set)
 * is never a survivor, whatever the filters. Deleted-row inspection
 * stays on `get(id)` / the storage adapter.
 *
 * The builder is thenable (has a `.then` method), not a Promise, so
 * `await qb` and `qb.then(...)` work via the standard thenable
 * protocol. Each chain method returns a new builder; the original
 * is untouched.
 */

import type { Entity, FieldValue } from "@ebbjs/core";
import { isFieldMap } from "@ebbjs/core";
import type { Replica } from "@ebbjs/storage/replica";
import type { StorageAdapter } from "@ebbjs/storage/types";
import { Value } from "@sinclair/typebox/value";
import type { Static, TObject, TSchema } from "@sinclair/typebox/type";
import type { ShapeFields } from "../schema/entity";
import { EntityValidationError, type EntityRegistry } from "../schema/entity-registry";
import {
  GROUPS_ACCESSOR,
  entityGroupSystemEntity,
  relationshipSystemEntity,
} from "../schema/system-entities";
import { emptyQuery, hasPredicateKind, type Predicate, type Query } from "./query";
import { planQuery } from "./query-plan";
import {
  createReplicaExecutor,
  createRowsExecutor,
  executePlan,
  type PlanExecutor,
} from "./query-execute";

/**
 * Project one wire field value to its application-facing value.
 *
 * - leaf → its `.value`
 * - map → each entry projected, recursively, with tombstoned entries
 *   (`value: null`) omitted so a deleted key disappears from the
 *   projected object while its storage entry is retained.
 *
 * The rule is purely structural: no field-kind dispatch, mirroring the
 * merge rule.
 */
export const projectFieldValue = (field: FieldValue): unknown => {
  if (!isFieldMap(field)) return field.value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(field.map)) {
    const projected = projectFieldValue(entry);
    if (projected === null) continue;
    out[key] = projected;
  }
  return out;
};

/**
 * Map a single materialized entity onto the schema's TypeBox shape.
 * Pure: the entity is read-only; the projected row is a fresh object.
 *
 * Projection states per field:
 * - `data.fields[K]` absent              → `undefined`
 * - leaf `data.fields[K].value = V`      → `V`
 * - leaf `data.fields[K].value = null`   → `null`
 * - map `data.fields[K].map`             → each entry projected,
 *   tombstoned entries omitted
 */
export function projectEntity<TFields extends Record<string, TSchema>>(
  entity: Entity,
  shape: TObject<TFields>,
): Static<TObject<ShapeFields<TFields>>> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape.properties) as (keyof TFields & string)[]) {
    const field = entity.data?.fields?.[key];
    out[key] = field === undefined ? undefined : projectFieldValue(field);
  }
  return out as Static<TObject<ShapeFields<TFields>>>;
}

/**
 * A materialized entity projected to the schema's shape, plus the
 * entity's `id`. The id is the addressing key — `get(row.id)`,
 * `update(row.id, ...)`, a React `key` — not a wire-envelope
 * passthrough: `data` / `type` / HLC stamps stay reachable through
 * `.toRaw()` or the `subscribe` snapshot. The id is `Omit`-ed out of
 * the shape first, so the entity id wins over a field named `id` of
 * any declared type.
 */
export type ProjectedRow<TFields extends Record<string, TSchema>> = Omit<
  Static<TObject<ShapeFields<TFields>>>,
  "id"
> & {
  readonly id: string;
};

/**
 * Project a materialized entity to a {@link ProjectedRow}: the shape's
 * fields plus the entity id. Pure; the id is injected last so it wins
 * over a same-named projected field.
 */
export function projectRow<TFields extends Record<string, TSchema>>(
  entity: Entity,
  shape: TObject<TFields>,
): ProjectedRow<TFields> {
  return { ...projectEntity(entity, shape), id: entity.id };
}

/** Project every row in a list. Pure; each row carries the entity id. */
export function projectRows<TFields extends Record<string, TSchema>>(
  rows: readonly Entity[],
  shape: TObject<TFields>,
): readonly ProjectedRow<TFields>[] {
  return rows.map((row) => projectRow(row, shape));
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
 * Everything a replica-backed chain needs to infer and execute a
 * predicate. Built by the entity namespace, which owns the registry and
 * the client's replica binding. Candidate chains carry no context: there
 * a key that isn't a field is rejected rather than inferred as an edge.
 */
export interface QueryContext {
  readonly entityName: string;
  readonly registry: EntityRegistry;
  readonly storage: StorageAdapter;
  /** The materialized read path the plan executes over. */
  readonly replica: Replica;
  /** Bring the replica up to date before the plan runs. Memoized by the client. */
  hydrate(): Promise<void>;
}

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
   * or an array meaning any-of. Adds to the current AND-group.
   */
  where<K extends keyof TFields & string>(key: K, value: Static<TFields[K]>): QueryBuilder<TFields>;
  /**
   * Relationship-target overload. It stays open over every key because
   * the registry decides field vs. edge at runtime and a relationship
   * wins a same-named field — so any field-named key may be an edge.
   * Typing the exact relationship keys is the #181 follow-up.
   */
  where(key: string, target: PointerValue | readonly PointerValue[]): QueryBuilder<TFields>;
  /**
   * Disjunction. Accepts the same key/value forms as {@link where} and
   * starts a new AND-group: `.where(a).where(b).or(c).where(d)` means
   * `(a AND b) OR (c AND d)`. A leading `.or` with no prior `.where`
   * starts the first group — it does not match every row.
   */
  or<K extends keyof TFields & string>(key: K, value: Static<TFields[K]>): QueryBuilder<TFields>;
  /** Open pointer overload for {@link or}, mirroring {@link where}'s. */
  or(key: string, target: PointerValue | readonly PointerValue[]): QueryBuilder<TFields>;
  /** Ordering on a field of `TFields`. */
  orderBy<K extends keyof TFields & string>(
    field: K,
    direction: "asc" | "desc",
  ): QueryBuilder<TFields>;
  /** Maximum number of rows. */
  limit(n: number): QueryBuilder<TFields>;
  /** First projected survivor, or `undefined` when the chain is empty. */
  first(): Promise<ProjectedRow<TFields> | undefined>;
  /** Count of survivors after the chain runs. */
  count(): Promise<number>;
  /** `true` when at least one row survives the chain. */
  exists(): Promise<boolean>;
  /** Streaming iterator over projected survivors. */
  [Symbol.asyncIterator](): AsyncIterableIterator<ProjectedRow<TFields>>;
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
   * listener would stay silent. A chain with a relationship or
   * membership predicate additionally listens on the `relationship` /
   * `entityGroup` row types, because those writes do not materialize
   * the entity they point at (see the `subscribe` implementation).
   */
  subscribe(listener: () => void): () => void;
  /**
   * The serializable query value the chain has accumulated. Pure data:
   * the planner input and, in #512, the result-cache key.
   */
  toQuery(): Query;
  /** Thenable — `await qb` resolves to the projected rows. */
  then<TResult1 = readonly ProjectedRow<TFields>[], TResult2 = never>(
    onfulfilled?:
      | ((value: readonly ProjectedRow<TFields>[]) => TResult1 | PromiseLike<TResult1>)
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
): QueryBuilder<TFields> {
  const loader: LoadEntities = async () => candidates;
  return buildLazyQueryBuilder(loader, shape);
}

/**
 * Like {@link buildQueryBuilder} but with a lazy candidate loader.
 * The loader is called every time the chain materializes (via
 * `await qb` or `.toRaw()`) so the chain reflects the latest snapshot
 * of the underlying rows.
 */
export function buildLazyQueryBuilder<TFields extends Record<string, TSchema>>(
  loadCandidates: LoadEntities,
  shape: TObject<TFields>,
): QueryBuilder<TFields> {
  const loadExecutor = async (): Promise<PlanExecutor> =>
    createRowsExecutor(await loadCandidates());
  return buildChain(emptyQuery(""), shape, undefined, loadExecutor);
}

/**
 * Build the chain `client.<entity>.query()` returns: predicates resolve
 * against `context`'s registry and every terminal executes the plan
 * synchronously over the client's replica, hydrated first.
 */
export function buildReplicaQueryBuilder<TFields extends Record<string, TSchema>>(
  source: string,
  shape: TObject<TFields>,
  context: QueryContext,
): QueryBuilder<TFields> {
  return buildChain(emptyQuery(source), shape, context, replicaExecutor(context));
}

/** Hydrate the replica, then read the plan's rows and indices from it. */
const replicaExecutor = (context: QueryContext) => async (): Promise<PlanExecutor> => {
  await context.hydrate();
  return createReplicaExecutor(context.replica);
};

/**
 * Execute a chain over the executor its mode supplies. The plan decides
 * whether a predicate pushes down to an index or filters scanned rows;
 * the executor itself never awaits.
 */
const executeQuery = async (
  query: Query,
  loadExecutor: () => Promise<PlanExecutor>,
): Promise<readonly Entity[]> => executePlan(planQuery(query), await loadExecutor());

/**
 * The single chain implementation. Each mutator returns a new builder
 * carrying the next {@link Query}; the original is untouched. Terminals
 * all funnel through {@link executeQuery}, so a replica chain and a
 * candidate chain differ only in where the executor comes from.
 */
function buildChain<TFields extends Record<string, TSchema>>(
  initial: Query,
  shape: TObject<TFields>,
  context: QueryContext | undefined,
  loadExecutor: () => Promise<PlanExecutor>,
): QueryBuilder<TFields> {
  const make = (query: Query): QueryBuilder<TFields> => ({
    where(key: string, target: unknown) {
      const predicate = buildPredicate(key, target, shape, context, "where");
      const current = query.groups[query.groups.length - 1];
      const groups =
        current === undefined
          ? [[predicate]]
          : [...query.groups.slice(0, -1), [...current, predicate]];
      return make({ ...query, groups });
    },
    or(key: string, target: unknown) {
      const predicate = buildPredicate(key, target, shape, context, "or");
      return make({ ...query, groups: [...query.groups, [predicate]] });
    },
    orderBy(field, direction) {
      return make({ ...query, order: { field, direction } });
    },
    limit(n) {
      return make({ ...query, limit: n });
    },
    toQuery: () => query,
    async first() {
      const head = (await executeQuery(query, loadExecutor))[0];
      return head === undefined ? undefined : projectRow(head, shape);
    },
    async count() {
      return (await executeQuery(query, loadExecutor)).length;
    },
    async exists() {
      return (await executeQuery(query, loadExecutor)).length > 0;
    },
    [Symbol.asyncIterator]() {
      const iter = async function* () {
        for (const row of await executeQuery(query, loadExecutor)) {
          yield projectRow(row, shape);
        }
      };
      return iter();
    },
    async toRaw() {
      return executeQuery(query, loadExecutor);
    },
    subscribe(listener) {
      const emitter = context?.storage.changeEmitter;
      if (emitter === undefined || context === undefined) return () => {};
      const unsubscribers = [emitter.onTypeChange(context.entityName, listener)];
      // A `relationship` / `entityGroup` write does not materialize the
      // entity it points at, so a chain with an edge or membership
      // predicate must also wake when one of those rows changes. The
      // rows carry no entity type for membership, and a relationship's
      // `type` may be overridden, so subscribe to the row type rather
      // than guessing the source type. Identical results are suppressed
      // downstream by the consumer's snapshot compare.
      if (hasPredicateKind(query, "relationship")) {
        unsubscribers.push(emitter.onTypeChange(relationshipSystemEntity.name, listener));
      }
      if (hasPredicateKind(query, "membership")) {
        unsubscribers.push(emitter.onTypeChange(entityGroupSystemEntity.name, listener));
      }
      return () => {
        for (const unsub of unsubscribers) unsub();
      };
    },
    // oxlint-disable-next-line no-thenable -- the QueryBuilder is intentionally a thenable; awaiting it projects the chain.
    then(onfulfilled, onrejected) {
      // Forward `onrejected` onto the whole chain, not just the
      // projection step: a rejecting candidate loader or a failed
      // hydration must settle the awaited builder as a rejection rather
      // than leaving it pending.
      return executeQuery(query, loadExecutor)
        .then((rows) => projectRows(rows, shape))
        .then(onfulfilled, onrejected);
    },
  });
  return make(initial);
}

/**
 * Turn one `where` / `or` argument into a predicate. A registered
 * forward relationship on the entity wins over a same-named field; an
 * unknown key throws rather than silently matching nothing.
 */
function buildPredicate<TFields extends Record<string, TSchema>>(
  key: string,
  value: unknown,
  shape: TObject<TFields>,
  context: QueryContext | undefined,
  method: "where" | "or",
): Predicate {
  // `groups` is reserved, so it can never be a declared relationship or
  // a field. With a query context it always means built-in membership;
  // a bare builder carries no registry, so the key falls through to the
  // unknown-field throw below.
  if (key === GROUPS_ACCESSOR && context !== undefined) {
    const label = `${method}("${GROUPS_ACCESSOR}") on "${context.entityName}"`;
    return {
      kind: "membership",
      anyOf: resolveTargetIds(value as PointerValue | readonly PointerValue[], label),
    };
  }
  const rel =
    context === undefined ? undefined : context.registry.getRelationship(context.entityName, key);
  if (rel !== undefined && context !== undefined) {
    const label = `${method}("${key}") on "${context.entityName}"`;
    return {
      kind: "relationship",
      as: key,
      type: rel.type,
      anyOf: resolveTargetIds(value as PointerValue | readonly PointerValue[], label),
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
          message: `${method}("${key}"): array/object values are only valid for a relationship key or a field whose declared type accepts them`,
        },
      ]);
    }
    return { kind: "field", field: key, value };
  }
  const entityName = context?.entityName ?? "(unknown)";
  throw new EntityValidationError([
    {
      entityName,
      field: key,
      message: `${method}("${key}"): not a field on "${entityName}" and not a declared relationship`,
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
