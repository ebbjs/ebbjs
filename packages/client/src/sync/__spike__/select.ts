/**
 * SPIKE S4 (#779): a selected-component set on the query value.
 *
 * One declaration, three derived things:
 *
 * - the **projection** (which fields the result carries),
 * - the **lease set** (which component values the subscription must hold),
 * - the **invalidation key** (which component changes can affect the result).
 *
 * It does *not* cover every dependency a query has. Filtering and ordering
 * read fields the result does not project, joins read target rows, and
 * membership (a row entering or leaving the source set) is an existence
 * dependency, not a component value. Those are named separately below — that
 * separation is the point of the spike.
 *
 * Throwaway. Not imported by production code.
 */

import { componentName, EBB_COMPONENTS, EBB_MODEL_NAME } from "@ebbjs/core";

import type { Query } from "../query";
import {
  compileReadComponents,
  planQuery,
  rowReadComponentsFor,
  type CompiledReadComponents,
} from "../query-plan";
import { keyOf } from "../keys";

/** Component names (`note/content`) the caller selects, in declaration order. */
export type ComponentSelection = readonly string[];

/** A query that carries its selection, as the scratch branch adds it. */
export interface SelectedQuery extends Query {
  readonly selected?: ComponentSelection;
}

/**
 * A row dependency that is not a component value: the source model's
 * membership (a row entering/leaving the scan) and each index a predicate or
 * join reads.
 */
export interface StructuralReads {
  /** The source model's row-existence set. */
  readonly rows: readonly string[];
  /** Indices: `relation:<as>/<type>`, `membership`, `exists:<component>`. */
  readonly indices: readonly string[];
}

export const select = (query: Query, selected: ComponentSelection): SelectedQuery => ({
  ...query,
  selected,
});

/**
 * The components a selected `rows` result must hold. `planQuery(...).readComponents`
 * still supplies predicate and ordering reads, because a filter reads a field
 * it does not project. Joins add their targets' reads, as they do today.
 */
export const selectionReadComponents = (query: SelectedQuery): readonly string[] => {
  if (query.source === "") return [];
  const reads = new Set<string>(query.selected ?? []);
  for (const component of planQuery(query).readComponents) {
    // The whole-model fallback is what selection replaces: a row's content is
    // now the selected set, not every component it happens to carry.
    if (!component.endsWith("/*")) reads.add(component);
  }
  // A row carries the groups it is a member of, and a projection may include
  // them; membership rows are not components of the source.
  reads.add(EBB_COMPONENTS.membership);
  for (const join of query.joins) {
    if (join.target !== EBB_MODEL_NAME)
      for (const component of joinReads(join.target)) reads.add(component);
    else if (join.kind === "membership") reads.add(EBB_COMPONENTS.membership);
  }
  return [...reads];
};

/** Same shape as today's join reads, kept local so the spike does not fork it. */
const joinReads = (target: string): readonly string[] => [`${target}/*`];

/** The components the result projects, as field names. */
export const selectionProjection = (selected: ComponentSelection): readonly string[] =>
  selected.map((component) => component.slice(component.indexOf("/") + 1));

/**
 * Reads a subscription needs beyond component values. Every query with a
 * filter or an order needs its index even when nothing is selected, and every
 * query needs the source model's membership.
 */
export const structuralReads = (query: SelectedQuery): StructuralReads => {
  const indices: string[] = [];
  for (const group of query.groups) {
    for (const predicate of group) {
      if (predicate.kind === "relationship")
        indices.push(`relation:${predicate.as}/${predicate.type}`);
      else if (predicate.kind === "membership") indices.push("membership");
      else if (predicate.kind === "existence") indices.push(`exists:${predicate.component}`);
    }
  }
  for (const join of query.joins) {
    indices.push(join.kind === "membership" ? "membership" : `relation:${join.as}/${join.type}`);
  }
  return { rows: query.source === "" ? [] : [`${query.source}`], indices: [...new Set(indices)] };
};

/** Split a selected read set for change matching, as the cache does today. */
export const compileSelection = (query: SelectedQuery): CompiledReadComponents =>
  compileReadComponents(selectionReadComponents(query));

/** The cache key grows the selection, so two projections do not collide. */
export const selectedQueryKey = (query: SelectedQuery): string =>
  keyOf("rows", JSON.stringify(query), JSON.stringify(query.selected ?? null));

/** What today's cache reads for the same rows result. */
export const todayReadComponents = (query: Query): readonly string[] => rowReadComponentsFor(query);

/** The components a selection saves relative to today's whole-model read. */
export const selectionSavings = (
  query: SelectedQuery,
  componentsOfSource: readonly string[],
): { readonly today: number; readonly selected: number } => {
  const today = new Set(todayReadComponents(query));
  const selected = new Set(selectionReadComponents(query));
  // Expand the model wildcard to the declared components it covers.
  let todayCount = 0;
  for (const read of today) {
    if (read.endsWith("/*")) {
      const model = read.slice(0, -2);
      todayCount += componentsOfSource.filter((component) =>
        component.startsWith(`${model}/`),
      ).length;
    } else todayCount += 1;
  }
  return { today: todayCount, selected: selected.size };
};

/** The predicate component a field predicate reads. */
export const predicateComponent = (source: string, field: string): string =>
  componentName(source, field);
