/**
 * Typed `QueryBuilder<T>` — the chainable filter DSL that
 * `sync/relationship.ts` returns from its forward-many / reverse
 * traversals.
 *
 * Extracted from `sync/relationship.ts` so the chain DSL and the
 * relationship traversal helpers own separate files. Both import
 * each other — `query-builder.ts` has no relationship knowledge,
 * and `relationship.ts` constructs builders via `buildQueryBuilder`.
 *
 * Shape:
 *
 * - `QueryPlan<T>` is the data carrier: candidates, accumulated
 *    filters, optional order, optional limit. The terminal
 *    `apply(plan)` materializes.
 * - `QueryBuilder<T>` extends `QueryPlan<T>` with the chainable
 *    `eq` / `orderBy` / `limit` mutators (each returns a new
 *    builder) and the `toArray()` / `find()` terminals.
 *
 * Design pins (per #158, "Refactors bundled in this PR"):
 *
 * - **`T` is unconstrained.** The plan only reads
 *   `data.fields[field].value`; the constraint adds nothing.
 * - **`toArray()` is the public terminal, `find()` is the
 *   backward-compat alias.** The relationship primitive handle
 *   already used `find()`; the chain DSL's terminal is `toArray()`.
 * - **Phantom `TFields`** and **`FieldValueFor<FieldMarker>`** land
 *   in a follow-up PR (the namespace mount), keeping this refactor
 *   a pure file move.
 */

import type { Entity } from "@ebbjs/core";

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
 * Chainable builder. Carries the chain's data plus the chainable
 * mutators (`eq` / `orderBy` / `limit`) and the `toArray()` /
 * `find()` terminals.
 *
 * The two terminals — `toArray()` and `find()` — are intentionally
 * the same evaluation (`apply(plan)`); `find()` exists as the
 * backward-compat alias used by `relationship.ts`'s primitive
 * handle. The follow-up namespace PR drops `.toArray()` as the
 * public terminal and adds a planned `.first()` / `.count()` per
 * #163.
 */
export interface QueryBuilder<T> extends QueryPlan<T> {
  /** Equality filter on a field of `T`. */
  eq(field: string, value: unknown): QueryBuilder<T>;
  /** Ordering on a field of `T`. */
  orderBy(field: string, direction: "asc" | "desc"): QueryBuilder<T>;
  /** Maximum number of rows. */
  limit(n: number): QueryBuilder<T>;
  /** Materialize the chain against the cached candidates. */
  toArray(): Promise<readonly T[]>;
  /**
   * Alias of `toArray()`, kept because the relationship primitive
   * handle shipped `find()` already. Both terminals share the same
   * `apply(plan)` implementation; rename only matters at the
   * caller site.
   */
  find(): Promise<readonly T[]>;
}

function makeBuilder<T>(
  candidates: readonly T[],
  filters: readonly EqFilter[],
  order: OrderBy | null,
  limitN: number | null,
): QueryBuilder<T> {
  const plan: QueryPlan<T> = {
    candidates,
    filters,
    order,
    limitN,
  };
  return {
    ...plan,
    eq(field, value) {
      return makeBuilder(candidates, [...filters, { field, value }], order, limitN);
    },
    orderBy(field, direction) {
      return makeBuilder(candidates, filters, { field, direction }, limitN);
    },
    limit(n) {
      return makeBuilder(candidates, filters, order, n);
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
 * Build a fresh `QueryBuilder<T>` over the given candidate rows.
 * Each chain method call returns a new builder carrying the new
 * constraint; the original is untouched.
 */
export function buildQueryBuilder<T>(candidates: readonly T[] = []): QueryBuilder<T> {
  return makeBuilder(candidates, [], null, null);
}
