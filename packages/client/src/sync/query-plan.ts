/**
 * Planner for the serializable query value (#498).
 *
 * Turns a {@link Query} into an executable op pipeline: one scan of the
 * source type, one select per DNF group, one order, and an optional
 * limit. The plan also carries the component reads #512 intersects with the
 * replica's revision journal, per result surface.
 *
 * Pure by construction: no registry, no storage, no replica. Indexed
 * predicates (existence, adjacency, membership) are placed ahead of field
 * filters within a select so the pipeline documents the pushdown into the
 * replica's indices; field predicates scan the materialized rows (epic
 * decision 12).
 */

import { componentName, EBB_COMPONENTS, EBB_MODEL_NAME } from "@ebbjs/core";

import type { Join, Predicate, Query } from "./query";
import { hasJoinKind, hasPredicateKind } from "./query";

/** A predicate as the executor sees it: index read or row filter. */
export type PlanPredicate =
  | {
      readonly kind: "adjacency";
      readonly as: string;
      readonly type: string;
      readonly anyOf: readonly string[] | null;
    }
  | { readonly kind: "membership"; readonly anyOf: readonly string[] | null }
  | { readonly kind: "existence"; readonly component: string; readonly present: boolean }
  | { readonly kind: "filter"; readonly field: string; readonly value: unknown };

export type PlanOp =
  | { readonly kind: "scan"; readonly type: string }
  | { readonly kind: "select"; readonly predicates: readonly PlanPredicate[] }
  | { readonly kind: "order"; readonly field: string | null; readonly direction: "asc" | "desc" }
  | { readonly kind: "limit"; readonly limit: number };

export interface Plan {
  readonly ops: readonly PlanOp[];
  /** One-level projections the builder applies after the narrowing ops. */
  readonly joins: readonly Join[];
  /**
   * The components the plan's operations read: the fields its predicates and
   * ordering name, the components its existence tests name, and the row models
   * its edge, membership, and join indices read. A `collection` result keeps
   * only the matching ids, so this set is its whole invalidation record; a
   * `rows` result also projects whole rows and reads more — see
   * {@link rowReadComponentsFor}.
   */
  readonly readComponents: readonly string[];
}

const toPlanPredicate = (predicate: Predicate): PlanPredicate => {
  switch (predicate.kind) {
    case "field":
      return { kind: "filter", field: predicate.field, value: predicate.value };
    case "relationship":
      return {
        kind: "adjacency",
        as: predicate.as,
        type: predicate.type,
        anyOf: predicate.anyOf,
      };
    case "membership":
      return { kind: "membership", anyOf: predicate.anyOf };
    case "existence":
      return { kind: "existence", component: predicate.component, present: predicate.present };
  }
};

const isIndexed = (predicate: PlanPredicate): boolean => predicate.kind !== "filter";

/**
 * Indexed predicates first, filters after; relative order is stable so a
 * plan reads back the query's predicate order within each class.
 */
const orderPredicates = (predicates: readonly PlanPredicate[]): readonly PlanPredicate[] => [
  ...predicates.filter(isIndexed),
  ...predicates.filter((predicate) => !isIndexed(predicate)),
];

/** A replica-backed chain names a source; a candidate chain carries the empty sentinel. */
const isReplicaBacked = (query: Query): boolean => query.source !== "";

/**
 * The read that matches every component of `model`. A query that cannot name
 * the components it depends on reads a model whole rather than dropping the
 * dependency; a change that names no component invalidates it.
 */
export const modelComponents = (model: string): string => `${model}/*`;

/**
 * The components a join onto `target` reads. A platform target names the exact
 * component it projects, so a page joined to `groups` does not re-read on every
 * grant write.
 */
const joinReadComponents = (join: Join): readonly string[] => {
  if (join.target !== EBB_MODEL_NAME) return [modelComponents(join.target)];
  // The only platform join today is the built-in `groups` membership join,
  // which projects group rows. A relationship declared onto the `ebb` model
  // cannot say which kind it means, so it reads the model whole.
  return join.kind === "membership" ? [EBB_COMPONENTS.group] : [modelComponents(EBB_MODEL_NAME)];
};

/**
 * A branch that constrains a component of the source row: a non-null equality
 * (it requires the row to carry the field) or a positive existence test. A
 * `hasNot`, a null equality, a membership, or an adjacency constrains no source
 * component, so a row can enter such a branch through a component the plan does
 * not read.
 */
const namesSourceComponent = (predicate: Predicate): boolean => {
  switch (predicate.kind) {
    case "field":
      return predicate.value !== null && predicate.value !== undefined;
    case "existence":
      return predicate.present;
    default:
      return false;
  }
};

/**
 * Whether every disjunction branch requires a source component, so a row can
 * only enter the result through a component the plan reads. A query with no
 * branches is a full scan, which names none.
 */
const everyBranchNamesComponent = (query: Query): boolean =>
  query.groups.length > 0 && query.groups.every((group) => group.some(namesSourceComponent));

/** The source components the predicates and ordering name. */
const sourceComponentsFor = (query: Query): readonly string[] => {
  const source = new Set<string>();
  for (const group of query.groups) {
    for (const predicate of group) {
      if (predicate.kind === "field") source.add(componentName(query.source, predicate.field));
      else if (predicate.kind === "existence") source.add(predicate.component);
    }
  }
  if (query.order !== null) source.add(componentName(query.source, query.order.field));
  return [...source];
};

/**
 * The components a change must touch to alter the query's matching-id result,
 * derived from the query alone because the plan holds no schema. A candidate
 * chain (`source === ""`) reads no replica row and returns an empty set.
 *
 * A predicate names a source field component; existence names its component;
 * ordering reads its field; an adjacency or membership predicate reads the
 * edge/membership rows. The source itself is read whole — `<source>/*` — unless
 * every branch names a source component, because only then does a row's arrival
 * depend on a component the plan watches. A chain over a value view names its
 * exact components instead (see `Query.sourceComponents`).
 */
export const readComponentsFor = (query: Query): readonly string[] => {
  if (!isReplicaBacked(query)) return [];
  const reads = new Set<string>(
    query.sourceComponents ??
      (everyBranchNamesComponent(query)
        ? sourceComponentsFor(query)
        : [modelComponents(query.source)]),
  );
  // Exact components: an edge read depends on link rows only, a membership read
  // on membership rows only.
  if (hasPredicateKind(query, "relationship") || hasJoinKind(query, "relationship")) {
    reads.add(EBB_COMPONENTS.link);
  }
  if (hasPredicateKind(query, "membership") || hasJoinKind(query, "membership")) {
    reads.add(EBB_COMPONENTS.membership);
  }
  return [...reads];
};

/**
 * A read set split for matching a change: the exact components it names and the
 * models it reads whole. Compiling once keeps a change a pair of membership tests
 * instead of a rebuilt intersection.
 */
export interface CompiledReadComponents {
  readonly components: ReadonlySet<string>;
  readonly models: ReadonlySet<string>;
}

/**
 * Split a read set beside the {@link modelComponents} encoder, so the
 * `<model>/*` suffix is parsed in exactly one place.
 */
export const compileReadComponents = (components: readonly string[]): CompiledReadComponents => {
  const exact = new Set<string>();
  const models = new Set<string>();
  for (const component of components) {
    if (component.endsWith("/*")) models.add(component.slice(0, -2));
    else exact.add(component);
  }
  return { components: exact, models };
};

/**
 * The components a `rows` result depends on: the plan's own reads plus every
 * component of the source and of each joined model, because a projected row
 * carries the whole shape, and membership for the `groupIds` it carries. Kept
 * out of {@link Plan} so the execution path never computes it.
 */
export const rowReadComponentsFor = (query: Query): readonly string[] => {
  if (!isReplicaBacked(query)) return [];
  const reads = new Set(readComponentsFor(query));
  if (query.sourceComponents === undefined) reads.add(modelComponents(query.source));
  for (const join of query.joins)
    for (const component of joinReadComponents(join)) reads.add(component);
  // Every projected row carries the group ids it is a live member of, so a
  // membership write changes a row even when nothing else about it did.
  reads.add(EBB_COMPONENTS.membership);
  return [...reads];
};

export function planQuery(query: Query): Plan {
  const ops: PlanOp[] = [{ kind: "scan", type: query.source }];
  for (const group of query.groups) {
    if (group.length === 0) continue;
    ops.push({ kind: "select", predicates: orderPredicates(group.map(toPlanPredicate)) });
  }
  ops.push({
    kind: "order",
    field: query.order?.field ?? null,
    direction: query.order?.direction ?? "asc",
  });
  if (query.limit !== null && query.limit >= 0) {
    ops.push({ kind: "limit", limit: query.limit });
  }
  return { ops, joins: query.joins, readComponents: readComponentsFor(query) };
}
