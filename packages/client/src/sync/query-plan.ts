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
 * replica's indices; field predicates scan the materialized rows.
 */

import { componentModel, componentName, EBB_COMPONENTS, EBB_MODEL_NAME } from "@ebbjs/core";

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
   * projected-row result adds its selection, its joined targets, and membership
   * — see `selectionReadComponents`.
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
const modelComponents = (model: string): string => `${model}/*`;

/**
 * The components a join onto `target` reads. A platform target names the exact
 * component it projects, so a page joined to `groups` does not re-read on every
 * grant write.
 */
export const joinReadComponents = (join: Join): readonly string[] => {
  if (join.target !== EBB_MODEL_NAME) return [modelComponents(join.target)];
  // The only platform join today is the built-in `groups` membership join,
  // which projects group rows. A relationship declared onto the `ebb` model
  // cannot say which kind it means, so it reads the model whole.
  return join.kind === "membership" ? [EBB_COMPONENTS.group] : [modelComponents(EBB_MODEL_NAME)];
};

/**
 * The components a change must touch to alter the query's matching-id result,
 * derived from the query alone because the plan holds no schema. A candidate
 * chain (`source === ""`) reads no replica row and returns an empty set.
 *
 * A predicate names a source field component; existence names its component;
 * ordering reads its field; an adjacency or membership predicate reads the
 * edge/membership rows. The source model's row set is watched separately (a
 * create or delete names no component); only the components this read names
 * are leased. A value-view chain seeds the exact component it projects.
 */
export const readComponentsFor = (query: Query): readonly string[] => {
  if (!isReplicaBacked(query)) return [];
  const reads = new Set<string>(query.sourceComponents ?? []);
  for (const group of query.groups) {
    for (const predicate of group) {
      if (predicate.kind === "field") reads.add(componentName(query.source, predicate.field));
      else if (predicate.kind === "existence") reads.add(predicate.component);
    }
  }
  if (query.order !== null) reads.add(componentName(query.source, query.order.field));
  // Exact components: an edge read depends on the source's link component only,
  // a membership read on membership rows only.
  if (hasPredicateKind(query, "relationship") || hasJoinKind(query, "relationship")) {
    reads.add(EBB_COMPONENTS.link);
  }
  if (hasPredicateKind(query, "membership") || hasJoinKind(query, "membership")) {
    reads.add(EBB_COMPONENTS.membership);
  }
  return [...reads];
};

/**
 * A read set split for matching a change: the exact components it names, the
 * models it reads whole, and the models whose row set it observes. Compiling
 * once keeps a change a pair of membership tests instead of a rebuilt
 * intersection.
 */
export interface CompiledReadComponents {
  readonly components: ReadonlySet<string>;
  readonly models: ReadonlySet<string>;
  /** Models whose result set a membership change can alter. */
  readonly sources: ReadonlySet<string>;
}

/**
 * Split a read set beside the {@link modelComponents} encoder, so the
 * `<model>/*` suffix is parsed in exactly one place. A component read observes
 * its model's row set, and so does every model named in `sources`.
 */
export const compileReadComponents = (
  components: readonly string[],
  sources: readonly string[] = [],
): CompiledReadComponents => {
  const exact = new Set<string>();
  const models = new Set<string>();
  for (const component of components) {
    if (component.endsWith("/*")) models.add(component.slice(0, -2));
    else exact.add(component);
  }
  const observed = new Set<string>(sources);
  for (const model of models) observed.add(model);
  for (const component of exact) observed.add(componentModel(component));
  return { components: exact, models, sources: observed };
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
