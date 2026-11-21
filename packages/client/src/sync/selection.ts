/**
 * Component selection on reads (#940).
 *
 * One declaration decides three things: the fields a read projects, the
 * components it leases, and the components whose changes invalidate its result.
 * `select` names model fields only; the components are `ebb/link`,
 * `ebb/membership`, the joined targets, and the predicate/order fields the
 * planner adds — never selected by the caller.
 *
 * The selection is carried on the {@link Query} value (as
 * {@link QuerySelection}) so the query that produced a result also says what
 * must change to invalidate it, and two selections of one query stay distinct
 * cache entries.
 */

import { EBB_COMPONENTS } from "@ebbjs/core";
import type { TObject, TSchema } from "@sinclair/typebox/type";

import { EntityValidationError } from "@ebbjs/schema";

import { keyOf } from "./keys";
import type { Query } from "./query";
import { joinReadComponents, readComponentsFor } from "./query-plan";

/** The field keys a read selects: `{ title: true }`. */
export type Selection<TFields extends Record<string, unknown> = Record<string, unknown>> = {
  readonly [K in keyof TFields]?: true;
};

/**
 * What a read selected, lowered to pure data. `fields` is kept as declared so
 * the projection has the caller's order; `components` is what the read leases
 * and invalidates on. Both are empty for `.select({})`, which returns only the
 * structural keys.
 */
export interface QuerySelection {
  readonly fields: readonly string[];
  readonly components: readonly string[];
}

/** A field's component, resolved by the caller's registry or view. */
export type ComponentFor = (field: string) => string | null;

/** Lower a validated field list to the query value. */
export const querySelection = (
  fields: readonly string[],
  componentFor: ComponentFor,
): QuerySelection => {
  const components: string[] = [];
  for (const field of fields) {
    const component = componentFor(field);
    if (component !== null && component.length > 0 && !components.includes(component)) {
      components.push(component);
    }
  }
  return { fields, components };
};

/**
 * Validate a raw `select(...)` argument against a row's shape and return its
 * field keys. Unknown keys and non-`true` values are errors, not silent
 * omissions: a selection is a contract about what the read returns.
 */
export const selectionFieldKeys = <TFields extends Record<string, TSchema>>(
  selection: unknown,
  shape: TObject<TFields>,
  entityName: string,
): readonly string[] => {
  if (selection === null || typeof selection !== "object" || Array.isArray(selection)) {
    throw new EntityValidationError([
      {
        entityName,
        message: "select(): expected an object of field keys, e.g. `{ title: true }`",
      },
    ]);
  }
  const fields: string[] = [];
  for (const [field, value] of Object.entries(selection)) {
    if (!Object.prototype.hasOwnProperty.call(shape.properties, field)) {
      throw new EntityValidationError([
        {
          entityName,
          field,
          message: `select("${field}"): not a field on "${entityName}"`,
        },
      ]);
    }
    if (value !== true) {
      throw new EntityValidationError([
        {
          entityName,
          field,
          message: `select("${field}"): select a field with \`true\``,
        },
      ]);
    }
    fields.push(field);
  }
  return fields;
};

/**
 * The components a read's selection leases before any predicate, order, or
 * join is added. A read with no selection reads its source whole; a value view
 * seeds the component it projects; `.select({})` names none, so it projects
 * and leases nothing — the same rule the builder's page acquisition applies.
 */
const selectionBase = (query: Query): readonly string[] => {
  if (query.selected !== undefined) return query.selected.components;
  return query.sourceComponents ?? [`${query.source}/*`];
};

/**
 * The components a projected-row result reads: the selection, every component
 * its predicates and ordering name, its joins' targets, and membership for the
 * `groupIds` every query row carries.
 */
export const selectionReadComponents = (query: Query): readonly string[] => {
  if (query.source === "") return [];
  const reads = new Set<string>(selectionBase(query));
  for (const component of readComponentsFor(query)) reads.add(component);
  for (const join of query.joins) {
    for (const component of joinReadComponents(join)) reads.add(component);
  }
  reads.add(EBB_COMPONENTS.membership);
  return [...reads];
};

/**
 * What a read depends on beyond component values: the models whose row set it
 * observes (a row entering or leaving changes the result) and the replica
 * indices its predicates and joins read.
 */
export interface StructuralReads {
  /** The models whose membership the result follows. */
  readonly rows: readonly string[];
  /**
   * Index reads: `relation:<as>/<type>`, `membership`, `exists:<component>`.
   *
   * Exported and tested, but not wired into change dispatch: the query cache
   * registers only `rows` plus the component read set, and no resolver is
   * registered for these names. An adjacency, membership, or existence
   * predicate therefore re-runs on any change to that component anywhere, not
   * only on the index key it reads (#946).
   */
  readonly indices: readonly string[];
}

/**
 * The structural dependencies of a read. A create or delete names no component,
 * so the source model's row set is a dependency in its own right; a predicate
 * or join that reads an index is named for the same reason, although only
 * {@link StructuralReads.rows} reaches the dispatcher today (#946).
 */
export const structuralReads = (query: Query): StructuralReads => {
  if (query.source === "") return { rows: [], indices: [] };
  const indices = new Set<string>();
  for (const group of query.groups) {
    for (const predicate of group) {
      if (predicate.kind === "relationship") {
        indices.add(`relation:${predicate.as}/${predicate.type}`);
      } else if (predicate.kind === "membership") {
        indices.add("membership");
      } else if (predicate.kind === "existence") {
        indices.add(`exists:${predicate.component}`);
      }
    }
  }
  for (const join of query.joins) {
    indices.add(join.kind === "membership" ? "membership" : `relation:${join.as}/${join.type}`);
  }
  return { rows: [query.source], indices: [...indices] };
};

/** The field keys a selection projects, or `null` for the whole row. */
export const selectionProjection = (
  selection: QuerySelection | undefined,
): readonly string[] | null => (selection === undefined ? null : selection.fields);

/** Resolve one projected field's value. */
export type FieldProjector = (field: string) => unknown;

/**
 * The projection: exactly the selected fields, or every shape field when the
 * read selects nothing. The caller supplies the resolver so defaults and
 * migrations stay in one place.
 */
export const projectSelectedFields = (
  fields: readonly string[] | null,
  shapeFields: readonly string[],
  project: FieldProjector,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const field of fields ?? shapeFields) out[field] = project(field);
  return out;
};

/** Type-tagged, key-sorted encoding; `JSON.stringify` would collide `-0`, `NaN`, and `undefined`. */
const encode = (value: unknown): string => {
  if (value === undefined) return "u";
  if (value === null) return "n";
  if (typeof value === "number") return `d:${Object.is(value, -0) ? "-0" : String(value)}`;
  if (typeof value === "string") return `s:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return value ? "t" : "f";
  if (value instanceof Date) return `D:${value.getTime()}`;
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key])}`).join(",")}}`;
  }
  // Functions and symbols cannot appear in a lowered query; a stable tag
  // keeps the key total rather than throwing.
  return `x:${String(value)}`;
};

/** The selection's contribution to the cache key: absent, empty, and named differ. */
const selectionKey = (selection: QuerySelection | undefined): string =>
  selection === undefined
    ? "none"
    : `sel:${encode(selection.fields)}:${encode(selection.components)}`;

/**
 * The cache key: surface plus the canonical lowered query, with the selection
 * appended so two projections of one query never share an entry.
 */
export const queryCacheKey = (surface: string, query: Query): string => {
  const { selected: _selected, ...rest } = query;
  return keyOf(surface, encode(rest), selectionKey(query.selected));
};
