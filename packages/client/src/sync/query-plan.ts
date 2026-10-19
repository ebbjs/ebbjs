/**
 * Planner for the serializable query value (#498).
 *
 * Turns a {@link Query} into an executable op pipeline: one scan of the
 * source type, one select per DNF group, one order, and an optional
 * limit. The plan also carries `readTypes`, the invalidation record #512
 * intersects with the replica's revision journal.
 *
 * Pure by construction: no registry, no storage, no replica. Indexed
 * predicates (adjacency, membership) are placed ahead of field filters
 * within a select so the pipeline documents the pushdown into the
 * replica's indices; field predicates scan the materialized rows (epic
 * decision 12).
 */

import { entityGroupSystemEntity } from "../schema/system-entities";

import type { Predicate, Query } from "./query";

/** A predicate as the executor sees it: index read or row filter. */
export type PlanPredicate =
  | {
      readonly kind: "adjacency";
      readonly as: string;
      readonly type: string;
      readonly anyOf: readonly string[] | null;
    }
  | { readonly kind: "membership"; readonly anyOf: readonly string[] | null }
  | { readonly kind: "filter"; readonly field: string; readonly value: unknown };

export type PlanOp =
  | { readonly kind: "scan"; readonly type: string }
  | { readonly kind: "select"; readonly predicates: readonly PlanPredicate[] }
  | { readonly kind: "order"; readonly field: string | null; readonly direction: "asc" | "desc" }
  | { readonly kind: "limit"; readonly limit: number };

export interface Plan {
  readonly ops: readonly PlanOp[];
  readonly readTypes: readonly string[];
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

/**
 * Source first, then each relationship predicate's `type` (the index key
 * the adjacency read uses, normally the source type) and the membership
 * row type, deduplicated — the coarse invalidation set #512 intersects
 * with the replica's journal.
 */
const readTypesFor = (query: Query): readonly string[] => {
  const types = new Set<string>([query.source]);
  const predicates = query.groups.flat();
  for (const predicate of predicates) {
    if (predicate.kind === "relationship") types.add(predicate.type);
  }
  if (predicates.some((predicate) => predicate.kind === "membership")) {
    types.add(entityGroupSystemEntity.name);
  }
  return [...types];
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
  return { ops, readTypes: readTypesFor(query) };
}
