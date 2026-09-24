/**
 * Typed `QueryBuilder<T>` — the chainable filter DSL the namespace
 * mounts onto `client.<entity>.find()` (and that the relationship
 * primitive handles return for forward-many / reverse traversals).
 *
 * Extracted from `sync/relationship.ts` so the chain DSL and the
 * relationship traversal helpers own separate files. Both import
 * each other — `query-builder.ts` has no relationship knowledge,
 * and `relationship.ts` constructs builders via `buildQueryBuilder`.
 *
 * Shape:
 *
 * - `QueryPlan<T>` is the data carrier: candidates, accumulated
 *    filters, optional order, optional limit. Terminals call
 *    `apply(plan)` to materialize.
 * - `QueryBuilder<T>` extends `QueryPlan<T>` with the chainable
 *    `eq` / `orderBy` / `limit` mutators (each returns a new
 *    builder) and the `toArray()` / `find()` terminals.
 *
 * Design pins (per #158, "Refactors bundled in this PR"):
 *
 * - **`TFields` is phantom over the entity-bound shape.** The
 *   factory accepts the runtime `candidates` list and the caller
 *   (typically the namespace mount site) supplies the schema's
 *   `TFields` at construction time so `eq` / `orderBy` narrow the
 *   field name to `keyof TFields` without adding a runtime
 *   argument on every call site. See "NamespacedQueryBuilder"
 *   below for the cast shape.
 * - **No `T extends Entity` constraint.** The plan only reads
 *   `data.fields[field].value`; the constraint added nothing.
 *   Any record shape with the same `entity.data?.fields?<field>`-
 *   access pattern can be used.
 * - **`toArray()` is the public terminal, `find()` is the
 *   backward-compat alias.** The namespace mounts `toArray()`;
 *   the relationship primitive already used `find()` and keeps it.
 */

import type { Entity } from "@ebbjs/core";

import type { FieldMarker, FieldValueFor } from "../schema/entity";

/**
 * Single equality constraint on the chain. Multiplexing through a
 * `readonly EqFilter[]` keeps the `QueryPlan` flat and lets `apply`
 * evaluate everything in one pass via `Array.filter(...).every(...)`.
 */
export interface EqFilter {
  field: string;
  value: unknown;
}

/** Single ordering constraint. `null` on the plan means "no order". */
export interface OrderBy {
  field: string;
  direction: "asc" | "desc";
}

/**
 * Snapshot of the chain's state at one point in time. Terminals
 * (and any future `.first()` / `.count()` per #163) read this
 * shape directly; chain mutators return a new builder with the
 * same shape plus the new constraint, so the original builder is
 * always reusable.
 *
 * `QueryBuilder<TFields>` extends this and adds the mutators +
 * terminals; splitting the data from the behavior is what keeps
 * `#163` a small follow-up instead of a refactor.
 */
export interface QueryPlan<T> {
  readonly candidates: readonly T[];
  readonly filters: readonly EqFilter[];
  readonly order: OrderBy | null;
  readonly limitN: number | null;
}

/**
 * Read a field's typed value out of an entity-shaped row. Returns
 * `undefined` when the row has no data map, no `fields` envelope,
 * or the field isn't carried. Mirrors `entity-fields.getFieldValue`
 * but kept private here so the chain DSL stays self-contained —
 * splitting the file further would create an import cycle.
 */
function fieldValue(row: Entity, field: string): unknown {
  const fv = row.data?.fields?.[field];
  if (fv === undefined) return undefined;
  return fv.value;
}

/**
 * Test `row[field] === value` for one equality filter. `undefined`
 * matches only `undefined` — the caller can express "field is
 * unset" by `eq("field", undefined)` exactly the same way the
 * wire does, and equality semantics match `===`.
 */
function eqField(row: Entity, field: string, value: unknown): boolean {
  return fieldValue(row, field) === value;
}

/**
 * Comparator for one ordering constraint. Numeric fields sort
 * numerically; everything else coerces via `String(...)` and
 * sorts via `localeCompare`. Undefined values sort last in both
 * directions (matches SQL `NULLS LAST` for ascending, `NULLS
 * FIRST` for descending — useful when ordering completion state).
 */
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
 * Materialize a plan against the local cache. Filters, then sorts,
 * then limits — the same order the chain DSL implies. Pure over
 * `plan.candidates`; no I/O, so terminal implementations don't
 * need to re-thread the chain's state through themselves.
 *
 * Returns a new array; the input is not mutated.
 */
export function apply<T>(plan: QueryPlan<T>): readonly T[] {
  let out: T[] = [...plan.candidates];
  if (plan.filters.length > 0) {
    out = out.filter((row) => plan.filters.every((f) => eqField(row as Entity, f.field, f.value)));
  }
  if (plan.order !== null) {
    const { field, direction } = plan.order;
    out.sort((a, b) => cmpField(a as Entity, b as Entity, field, direction));
  }
  if (plan.limitN !== null && plan.limitN >= 0) {
    out = out.slice(0, plan.limitN);
  }
  return out;
}

/**
 * Typed chainable builder. Carries `TFields` as a phantom so callers
 * see `eq(field: keyof TFields, value: FieldValueFor<TFields[K]>)`
 * without paying for it at runtime. The chain mutators return a new
 * builder with the constraint appended — the original is untouched,
 * so the same builder can be reused across callers without
 * surprising state.
 *
 * The two terminals — `toArray()` and `find()` — are intentionally
 * the same evaluation (`apply(plan)`); `find()` exists as the
 * backward-compat alias used by `relationship.ts`'s primitive
 * handle. Issue #163 will add `.first()` / `.count()` / iteration;
 * each one is a small wrapper over `apply(plan)`.
 */
export interface QueryBuilder<
  TFields extends Record<string, FieldMarker>,
> extends QueryPlan<unknown> {
  /** Equality filter on a declared field. Typed against `TFields`. */
  eq<K extends keyof TFields & string>(
    field: K,
    value: FieldValueFor<TFields[K]>,
  ): QueryBuilder<TFields>;
  /** Ordering on a declared field. Typed against `TFields`. */
  orderBy<K extends keyof TFields & string>(
    field: K,
    direction: "asc" | "desc",
  ): QueryBuilder<TFields>;
  /** Maximum number of rows. */
  limit(n: number): QueryBuilder<TFields>;
  /** Materialize the chain against the cached candidates. */
  toArray(): Promise<readonly unknown[]>;
  /**
   * Alias of `toArray()`, kept because the relationship primitive
   * handle shipped `find()` already. Both terminals share the same
   * `apply(plan)` implementation; rename only matters at the
   * caller site.
   */
  find(): Promise<readonly unknown[]>;
}

/**
 * Internally we keep `candidates` as `readonly unknown[]` because
 * `QueryPlan<T>` parameterizes on the row type — for the
 * relationship primitive handles the row type is `Entity`, for the
 * namespaced `client.<entity>.find()` it's the user's typed record
 * shape. The handle read sites cast to the concrete type when they
 * consume the terminal. The unconstrained `unknown` keeps the type
 * algebra closed under mutation.
 */
function makeBuilder<TFields extends Record<string, FieldMarker>>(
  candidates: readonly unknown[],
  filters: readonly EqFilter[],
  order: OrderBy | null,
  limitN: number | null,
): QueryBuilder<TFields> {
  const plan: QueryPlan<unknown> = {
    candidates,
    filters,
    order,
    limitN,
  };
  return {
    ...plan,
    eq(field, value) {
      return makeBuilder<TFields>(candidates, [...filters, { field, value }], order, limitN);
    },
    orderBy(field, direction) {
      return makeBuilder<TFields>(candidates, filters, { field, direction }, limitN);
    },
    limit(n) {
      return makeBuilder<TFields>(candidates, filters, order, n);
    },
    async toArray() {
      return apply(plan);
    },
    async find() {
      return apply(plan);
    },
  };
}

/**
 * Build a fresh typed `QueryBuilder<TFields>` over the given
 * candidate rows. The factory is generic on `TFields` (the schema's
 * declared field map) and accepts an unconstrained `candidates`
 * array; the static type erases the row shape inside the chain,
 * callers cast on the terminal result.
 *
 * Typical call site — the namespace mount in `sync/namespace.ts`:
 *
 * ```ts
 * const qb = buildQueryBuilder<typeof schema.entities.todo.fields>([]);
 * await qb.eq("completed", false).orderBy("createdAt", "desc").toArray();
 * ```
 *
 * The phantom `TFields` carries the typing for `eq` / `orderBy`
 * without a runtime argument, per design pin #4.
 */
export function buildQueryBuilder<TFields extends Record<string, FieldMarker>>(
  candidates: readonly unknown[] = [],
): QueryBuilder<TFields> {
  return makeBuilder<TFields>(candidates, [], null, null);
}

/**
 * Convenience: a `QueryBuilder<T>` alias parameterized on the
 * schema-shaped field map. Mirrors what callers see at the
 * namespace mount: `client.todo.find()` returns a
 * `NamespacedQueryBuilder<typeof schema.entities.todo.fields>`.
 * The runtime value is a plain `QueryBuilder<TFields>` — no
 * difference, this is purely a name alias so the mount sites read
 * consistently.
 */
export type NamespacedQueryBuilder<TFields extends Record<string, FieldMarker>> =
  QueryBuilder<TFields>;

/**
 * The QueryBuilder shape carried by primitive handles that don't
 * have a schema in scope (`client.relationship({...})` returns one
 * of these). The phantom `TFields` is empty so `eq` / `orderBy`
 * are statically unreachable on the primitive — the primitive
 * already filters by relationship key at the traversal level.
 */
export type PrimitiveQueryBuilder = QueryBuilder<Record<never, never>>;
