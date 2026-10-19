/**
 * The serializable query value (#498).
 *
 * A `Query` is pure data — no closures over storage. It is the planner
 * input, the result-cache key (#512), and the invalidation record: the
 * planner derives `readTypes` from it, so the same value that produced a
 * result also says which types must change to invalidate it.
 *
 * Predicates are a disjunction of conjunctions (DNF): `groups` are ORed,
 * the predicates within a group ANDed. `anyOf: null` on a relationship or
 * membership predicate means the predicate names no live edge/group, so
 * it matches nothing — an explicit "no live pointer", never "no filter".
 */

/** One query predicate, resolved against the schema by the builder. */
export type Predicate =
  | { readonly kind: "field"; readonly field: string; readonly value: unknown }
  | {
      readonly kind: "relationship";
      readonly as: string;
      readonly type: string;
      readonly anyOf: readonly string[] | null;
    }
  | { readonly kind: "membership"; readonly anyOf: readonly string[] | null };

/** Ordering descriptor. `field` names a data field of the source type. */
export interface QueryOrder {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

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
  /** with(...) joins land in #519; no join can exist yet. */
  readonly joins: readonly [];
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
 * Whether any group holds a predicate of `kind`. One helper for the
 * planner's read types and the builder's change subscriptions, so both
 * read the same predicate vocabulary.
 */
export const hasPredicateKind = (query: Query, kind: Predicate["kind"]): boolean =>
  query.groups.some((group) => group.some((predicate) => predicate.kind === kind));
