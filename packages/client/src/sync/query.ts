/**
 * The serializable query value (#498).
 *
 * A `Query` is pure data — no closures over storage. It is the planner
 * input, the result-cache key (#512), and the invalidation record: the
 * planner derives the components it reads from it, so the same value that
 * produced a result also says which components must change to invalidate
 * it.
 *
 * Predicates are a disjunction of conjunctions (DNF): `groups` are ORed,
 * the predicates within a group ANDed. `anyOf: null` on a relationship or
 * membership predicate means the predicate names no live edge/group, so
 * it matches nothing — an explicit "no live pointer", never "no filter".
 */

import { EntityValidationError, type Filter } from "@ebbjs/schema";

/** One query predicate, resolved against the schema by the builder. */
export type Predicate =
  | { readonly kind: "field"; readonly field: string; readonly value: unknown }
  | {
      readonly kind: "relationship";
      readonly as: string;
      readonly type: string;
      readonly anyOf: readonly string[] | null;
    }
  | { readonly kind: "membership"; readonly anyOf: readonly string[] | null }
  | {
      /**
       * Component existence: `component` is always `<source>/<field>`, because
       * the builder resolves the field against the source model. `present:
       * true` is `has`, `false` is `hasNot`. Builder-only: no wire `Filter`
       * lowers to it, because the server grows no component index before
       * #799.
       */
      readonly kind: "existence";
      readonly component: string;
      readonly present: boolean;
    };

/** Ordering descriptor. `field` names a data field of the source type. */
export interface QueryOrder {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

/** Which end of a relationship a join reads from the row it widens. */
export type JoinDirection = "forward" | "reverse";

/** How a join projects onto its host row: one target or a list of targets. */
export type JoinCardinality = "one" | "many";

/**
 * One `with(...)` join, lowered to pure data.
 *
 * A relationship join reads the replica's adjacency index under
 * `(as, type)`: forward from the host row's id for a source-side
 * relationship, reverse to it for a target-side one. A membership join
 * reads the `entityGroup` index under the host row's id. Either way the
 * target rows are read by id — a join never scans a target type.
 */
export type Join =
  | {
      readonly kind: "relationship";
      readonly as: string;
      /** Wire relationship type; the adjacency index's type key. */
      readonly type: string;
      /** Entity type name of the joined row. */
      readonly target: string;
      readonly direction: JoinDirection;
      readonly cardinality: JoinCardinality;
    }
  | {
      readonly kind: "membership";
      readonly as: string;
      readonly target: string;
      readonly cardinality: "many";
    };

export interface Query {
  /**
   * The entity type the query reads. A chain over already-materialized
   * candidate rows has no source type, so it carries `""` — the one
   * sentinel in the value.
   */
  readonly source: string;
  /** DNF: groups are ORed, predicates within a group ANDed. */
  readonly groups: readonly (readonly Predicate[])[];
  readonly order: QueryOrder | null;
  readonly limit: number | null;
  /** One-level `with(...)` projections applied after the plan narrows rows. */
  readonly joins: readonly Join[];
}

/** The unfiltered query over a source type. */
export const emptyQuery = (source: string): Query => ({
  source,
  groups: [],
  order: null,
  limit: null,
  joins: [],
});

/**
 * Lower a wire {@link Filter} to the builder's predicate language: one
 * conjunction of field predicates per group, ORed by the planner.
 *
 * A `null` value stays a `null` predicate value — "no live value" — so the
 * executor applies the same rule as an index-backed group. An empty group is
 * an empty conjunction, which is TRUE, and a disjunction with a TRUE term is
 * unfiltered; `null` and `[]` are unfiltered too.
 */
export const filterToGroups = (filter: Filter | null): readonly (readonly Predicate[])[] => {
  const groups = filter ?? [];
  for (const [index, group] of groups.entries()) {
    if (group === null || typeof group !== "object" || Array.isArray(group)) {
      // A valid `Filter` cannot carry one; a caller that skipped
      // `client.queryEntities`' validation gets a clear error, matching
      // the server's `invalid_filter`.
      throw new EntityValidationError([
        { entityName: "(unknown)", message: `filter group ${index} must be an object` },
      ]);
    }
  }
  if (groups.some((group) => Object.keys(group).length === 0)) return [];
  return groups.map((group) =>
    Object.entries(group).map(([field, value]) => ({ kind: "field" as const, field, value })),
  );
};

/**
 * Whether any group holds a predicate of `kind`. One helper for the
 * planner's read types and the builder's change subscriptions, so both
 * read the same predicate vocabulary.
 */
export const hasPredicateKind = (query: Query, kind: Predicate["kind"]): boolean =>
  query.groups.some((group) => group.some((predicate) => predicate.kind === kind));

/**
 * Whether the query's joins read a kind of edge. One helper for the
 * planner's read types and the builder's change subscriptions, so both
 * read the same join vocabulary.
 */
export const hasJoinKind = (query: Query, kind: Join["kind"]): boolean =>
  query.joins.some((join) => join.kind === kind);
