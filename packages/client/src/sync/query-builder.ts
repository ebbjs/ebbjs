/**
 * Typed thenable QueryBuilder.
 *
 * `await qb` resolves to `readonly Static<TObject<ShapeFields<TFields>>>[]` after
 * projecting each materialized entity to the schema's TypeBox shape.
 * The chain mutators (`eq` / `orderBy` / `limit`) are typed against
 * the field map: `field` narrows to `keyof TFields` and `value`
 * narrows to the field's TypeBox static type.
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
import type { Static, TObject, TSchema } from "@sinclair/typebox/type";
import type { ShapeFields } from "../schema/entity";

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

/** A single equality filter. Narrowed to the field's static value type. */
type EqFilter<TFields extends Record<string, TSchema>> = {
  [K in keyof TFields]: { field: K & string; value: Static<TFields[K]> };
}[keyof TFields];

/** Ordering descriptor accumulated by `orderBy`. */
type OrderBy = { field: string; direction: "asc" | "desc" };

/** Loader for the candidate entity list. Resolved lazily on each materialization. */
export type LoadEntities = () => Promise<readonly Entity[]>;

/**
 * Typed thenable chain over a list of candidate entities. The same
 * chain is consumed by `client.<entity>.query()` and by the
 * relationship handle's `reverse` / `forward` accessors — one chain,
 * one projection.
 */
export interface QueryBuilder<TFields extends Record<string, TSchema>> {
  /** Equality filter on a field of `TFields`. Value type narrows per field. */
  eq<K extends keyof TFields & string>(field: K, value: Static<TFields[K]>): QueryBuilder<TFields>;
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
 * applies `eq` / `orderBy` / `limit` on top; awaiting the builder
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
 * `await qb` or `.toRaw()`) so the chain reflects the latest
 * snapshot of the underlying store.
 */
export function buildLazyQueryBuilder<TFields extends Record<string, TSchema>>(
  loadCandidates: LoadEntities,
  shape: TObject<TFields>,
): QueryBuilder<TFields> {
  const make = (
    filters: readonly EqFilter<TFields>[],
    order: OrderBy | null,
    limitN: number | null,
  ): QueryBuilder<TFields> => {
    const apply = (rows: readonly Entity[]): Entity[] => {
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
    const builder: QueryBuilder<TFields> = {
      eq(field, value) {
        return make([...filters, { field, value } as EqFilter<TFields>], order, limitN);
      },
      orderBy(field, direction) {
        return make(filters, { field, direction }, limitN);
      },
      limit(n) {
        return make(filters, order, n);
      },
      async first() {
        const candidates = await loadCandidates();
        const survivors = apply(candidates);
        const head = survivors[0];
        return head === undefined ? undefined : projectEntity(head, shape);
      },
      async count() {
        const candidates = await loadCandidates();
        return apply(candidates).length;
      },
      async exists() {
        const candidates = await loadCandidates();
        return apply(candidates).length > 0;
      },
      [Symbol.asyncIterator]() {
        const iter = async function* () {
          const candidates = await loadCandidates();
          for (const row of apply(candidates)) {
            yield projectEntity(row, shape);
          }
        };
        return iter();
      },
      async toRaw() {
        const candidates = await loadCandidates();
        return apply(candidates);
      },
      // oxlint-disable-next-line no-thenable -- the QueryBuilder is intentionally a thenable; awaiting it projects the chain.
      then(onfulfilled, onrejected) {
        return loadCandidates().then((candidates) => {
          const projected = projectRows(apply(candidates), shape);
          return Promise.resolve(projected).then(onfulfilled, onrejected);
        });
      },
    };
    return builder;
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
