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

/** The `(as, type)` pair an index name encodes, or `null` for another name. */
const relationPair = (index: string): { readonly as: string; readonly type: string } | null => {
  if (!index.startsWith(RELATION_PREFIX)) return null;
  const parts = index.slice(RELATION_PREFIX.length).split("/");
  if (parts.length !== 2) return null;
  const [as, type] = parts;
  if (as === undefined || type === undefined || as.length === 0 || type.length === 0) {
    return null;
  }
  return { as, type };
};

/** Every target any relation pair on this change moved, plus the changed row. */
const everyMovedTarget = (change: ReplicaChange): readonly string[] => {
  const targets: string[] = [change.id];
  for (const part of change.delta.edges) targets.push(...part.added, ...part.removed);
  return [...new Set(targets)];
};

/**
 * The keys a change moved under one relation index. A content change that names
 * no `ebb/link` is the changed row itself: a reader keyed on that row follows
 * its projected values.
 *
 * A link write or a membership change reads the journal's edge delta, which
 * names both the targets added and the ones dropped for every `(as, type)` on
 * the row. Only the pair the index encodes answers; the delta carries the
 * row's whole relation set, so another pair's targets must not leak in. The
 * changed row stays in the answer because a reader keyed on it follows its
 * projected values too, and dropping it would turn a narrowed touch into a
 * miss.
 *
 * The delta is complete (ADR 0006), so a pair it names nothing under moved no
 * target and the row alone is exact. A name this family cannot parse is one a
 * consumer supplied by hand: every target the delta names is the answer, since
 * any of them could be the pair it meant. Validating a `(as, type)` against the
 * schema is #1028.
 */
const relationSubjects = (change: ReplicaChange, index: string): readonly string[] => {
  const pair = relationPair(index);
  if (pair === null) return everyMovedTarget(change);
  if (change.kind === "content" && !change.components.includes(EBB_COMPONENTS.link)) {
    return [change.id];
  }
  const moved = change.delta.edges.find((part) => part.as === pair.as && part.type === pair.type);
  if (moved === undefined) return [change.id];
  return [...new Set([change.id, ...moved.added, ...moved.removed])];
};

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
 * A relationship join projects a matched source row's edges, so a link write on
 * that row can move the projection even when the predicate's own targets did
 * not move. The index keys the predicate's targets, not every source row, so
 * it can only replace `ebb/link` for a read that reads edges through a
 * predicate alone; a joining read keeps the component dependency.
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
  if (!query.joins.some((join) => join.kind === "relationship")) {
    covered.push(EBB_COMPONENTS.link);
  }
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
