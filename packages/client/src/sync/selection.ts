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
 * result entries.
 */

import { EBB_COMPONENTS } from "@ebbjs/core";
import type { TObject, TSchema } from "@sinclair/typebox/type";

import { EntityValidationError } from "@ebbjs/schema";

import type { IndexDependency } from "./dependency-index";
import {
  existsDependency,
  relationDependency,
  relationIndex,
  scopeDependency,
} from "./index-resolvers";
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
export const selectionBase = (query: Query): readonly string[] => {
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
 * observes, so a row entering or leaving changes the result, and the derived
 * indices its predicates and joins read.
 */
export interface StructuralReads {
  /** The models whose membership the result follows. */
  readonly rows: readonly string[];
  /**
   * The index reads the result declares: `relation:<as>/<type>` per target a
   * relationship predicate or forward join reads, `exists:<component>` per
   * existence predicate, and `scope` per group a membership predicate names.
   */
  readonly indices: readonly IndexDependency[];
  /**
   * Components the indices replace as the dispatcher's match key. The read set
   * still names them — they are what the result leases and re-checks — but
   * dispatch leaves them to a resolver, which is narrower (or, when it cannot
   * resolve a change, exactly as broad).
   */
  readonly covered: readonly string[];
}

/** The structural dependencies of a read; the empty chain reads no replica row. */
const noStructuralReads: StructuralReads = { rows: [], indices: [], covered: [] };

/**
 * The components a relationship read's index covers. An index is only a
 * narrower match key when the read named concrete targets; an `anyOf: null`
 * predicate matches nothing and a target-less join keeps its model component,
 * so neither replaces a component dependency.
 *
 * A forward one-cardinality join may rely on the predicate's keys because every
 * row that survives the group has its one edge under the pinned relation, and
 * that edge points at one of the group's targets. A many-cardinality join can
 * project a target outside the `anyOf` set, and a group that does not pin the
 * relation lets the join see any target, so in both cases the model component
 * stays the dispatch key.
 */
const relationCovers = (
  query: Query,
  keyed: ReadonlyMap<string, { readonly keys: ReadonlySet<string> }>,
): readonly string[] => {
  const covered: string[] = [];
  if (keyed.size === 0) return covered;
  // Every relationship predicate or forward join reads its source's
  // `ebb/link`; the index is keyed on the targets, which is what a link change
  // resolves to (or falls back to).
  covered.push(EBB_COMPONENTS.link);
  for (const join of query.joins) {
    if (join.kind !== "relationship" || join.direction !== "forward") continue;
    if (join.cardinality !== "one") continue;
    // A self-relation's target model is also the source model: covering it
    // would drop the source's own projected components from dispatch.
    if (join.target === query.source) continue;
    if (!keyed.has(relationIndex(join.as, join.type))) continue;
    const pinned = query.groups.every((group) =>
      group.some(
        (predicate) =>
          predicate.kind === "relationship" &&
          predicate.as === join.as &&
          predicate.type === join.type,
      ),
    );
    if (!pinned) continue;
    // A forward join's targets are exactly an `as`/`type` predicate's any-of
    // set, so the index answers a target row's change and the target model's
    // whole-component dependency is no longer needed for dispatch.
    for (const component of joinReadComponents(join)) covered.push(component);
  }
  return covered;
};

/**
 * The structural dependencies of a read. A create or delete names no component,
 * so the source model's row set is a dependency in its own right. A predicate
 * or forward join that reads a derived index names it too, so dispatch can
 * match the index key the change moved instead of the component it is filed
 * under.
 */
export const structuralReads = (query: Query): StructuralReads => {
  if (query.source === "") return noStructuralReads;
  const indices: IndexDependency[] = [];
  const covered: string[] = [];
  /** `relation:<as>/<type>` → the relation and the target ids the read cares about. */
  const relations = new Map<
    string,
    { readonly as: string; readonly type: string; readonly keys: Set<string> }
  >();
  const addRelation = (as: string, type: string, targets: readonly string[]): void => {
    if (targets.length === 0) return;
    const name = relationIndex(as, type);
    const relation = relations.get(name) ?? { as, type, keys: new Set<string>() };
    for (const target of targets) relation.keys.add(target);
    relations.set(name, relation);
  };

  for (const group of query.groups) {
    for (const predicate of group) {
      if (predicate.kind === "relationship") {
        addRelation(predicate.as, predicate.type, predicate.anyOf ?? []);
      } else if (predicate.kind === "membership") {
        for (const groupId of predicate.anyOf ?? []) indices.push(scopeDependency(groupId));
      } else if (predicate.kind === "existence") {
        indices.push(existsDependency(predicate.component));
        covered.push(predicate.component);
      }
    }
  }

  for (const { as, type, keys } of relations.values()) {
    for (const target of keys) indices.push(relationDependency(as, type, target));
  }
  covered.push(...relationCovers(query, relations));

  // One predicate may appear in more than one OR group, and one index may be
  // read by both a predicate and a join; the dispatcher buckets a dependency
  // once, so drop the repeats here rather than re-adding them.
  const seen = new Set<string>();
  const unique = indices.filter(({ index, key }) => {
    const name = `${index}\u0000${key}`;
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  return { rows: [query.source], indices: unique, covered: [...new Set(covered)] };
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

/** The selection's contribution to the result key: absent, empty, and named differ. */
const selectionKey = (selection: QuerySelection | undefined): string =>
  selection === undefined
    ? "none"
    : `sel:${encode(selection.fields)}:${encode(selection.components)}`;

/**
 * The result key: surface plus the canonical lowered query, with the selection
 * appended so two projections of one query never share an entry.
 */
export const queryResultKey = (surface: string, query: Query): string => {
  const { selected: _selected, ...rest } = query;
  return keyOf(surface, encode(rest), selectionKey(query.selected));
};
