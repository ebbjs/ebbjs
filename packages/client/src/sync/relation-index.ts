/**
 * The `relation:<as>/<type>` index family (#961, #1003).
 *
 * A relationship predicate or forward join reads the adjacency index by the
 * target row id it cares about. The family declares those dependencies and
 * resolves a change back to the target it moved; the coverage rule — which
 * model components the index can replace as dispatch's match key — lives here
 * beside the index it protects.
 */

import { EBB_COMPONENTS } from "@ebbjs/core";
import type { ReplicaChange } from "@ebbjs/storage/replica";

import type { IndexDependency } from "./dependency-index";
import { namespaceName, predicatesOf, type IndexFamily } from "./index-family";
import { joinReadComponents } from "./query-plan";
import type { Query } from "./query";

const RELATION_PREFIX = "relation:";

/** The registration name serving every `relation:` index. */
const RELATION_NAMESPACE = namespaceName(RELATION_PREFIX);

/** `relation:<as>/<type>`, keyed by the target row id a read cares about. */
export const relationIndex = (as: string, type: string): string =>
  `${RELATION_PREFIX}${as}/${type}`;

/** The dependency a relationship predicate or join adds for one target. */
const relationDependency = (as: string, type: string, targetId: string): IndexDependency => ({
  index: relationIndex(as, type),
  key: targetId,
});

/**
 * A link write never names the targets it *dropped*: the journal carries the
 * components a write touched, and the row index holds only the edges that
 * exist after it. A read keyed on a removed target would therefore be missed
 * if the resolver guessed, so a link write answers `null` and dispatch falls
 * back to every reader of the relation — the breadth the `ebb/link` component
 * dependency had before this index existed.
 *
 * Every other change is precise. A membership change names the row, so a read
 * that joins it as a target follows it; a read that sources the relation from
 * that row follows the read's own `sources` model set. A content change to a
 * row is that row's id, which is the key of any read that follows it as a
 * joined target.
 */
const relationSubjects = (change: ReplicaChange): readonly string[] | null =>
  change.kind === "content" && change.components.includes(EBB_COMPONENTS.link) ? null : [change.id];

/** The relation a read declared, and the target ids it cares about. */
interface KeyedRelation {
  readonly as: string;
  readonly type: string;
  readonly keys: Set<string>;
}

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
  keyed: ReadonlyMap<string, KeyedRelation>,
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

/** `relation:<as>/<type>` → the targets the read's predicates name under it. */
const keyedRelations = (query: Query): ReadonlyMap<string, KeyedRelation> => {
  const relations = new Map<string, KeyedRelation>();
  for (const predicate of predicatesOf(query)) {
    if (predicate.kind !== "relationship") continue;
    const targets = predicate.anyOf ?? [];
    if (targets.length === 0) continue;
    const name = relationIndex(predicate.as, predicate.type);
    const relation = relations.get(name) ?? {
      as: predicate.as,
      type: predicate.type,
      keys: new Set<string>(),
    };
    for (const target of targets) relation.keys.add(target);
    relations.set(name, relation);
  }
  return relations;
};

export const relationIndexFamily: IndexFamily = {
  names: [RELATION_NAMESPACE],
  declare: (query) => {
    const relations = keyedRelations(query);
    const indices: IndexDependency[] = [];
    for (const { as, type, keys } of relations.values()) {
      for (const target of keys) indices.push(relationDependency(as, type, target));
    }
    return { indices, covered: relationCovers(query, relations) };
  },
  resolver: () => relationSubjects,
};
