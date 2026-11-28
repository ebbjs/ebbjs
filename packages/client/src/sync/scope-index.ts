/**
 * The `scope` index family (#961, #1003).
 *
 * A membership predicate reads one group's scope. The index is keyed by the
 * group id a read names, and a change resolves to the groups its membership
 * delta moved.
 */

import type { ReplicaChange } from "@ebbjs/storage/replica";

import type { IndexDependency } from "./dependency-index";
import { predicatesOf, type IndexFamily } from "./index-family";

/** Scope-aware reads: one dependency per group id whose membership the read follows. */
const SCOPE_INDEX = "scope";

/** The dependency a scope-aware read adds for one group. */
const scopeDependency = (groupId: string): IndexDependency => ({
  index: SCOPE_INDEX,
  key: groupId,
});

/**
 * The groups a change moved. The journal's membership delta names the pair the
 * row filed on each side, so a move touches readers of the group it entered and
 * the one it left, and an eviction touches the one it left.
 *
 * The delta is complete (ADR 0006), so a change whose membership part names no
 * side moved no pair and no scoped read needs it.
 */
const scopeSubjects = (change: ReplicaChange): readonly string[] => {
  const { before, after } = change.delta.membership;
  const groups = [before?.groupId, after?.groupId].filter(
    (groupId): groupId is string => groupId !== undefined,
  );
  return [...new Set(groups)];
};

export const scopeIndexFamily: IndexFamily = {
  names: [SCOPE_INDEX],
  declare: (query) => {
    const indices: IndexDependency[] = [];
    for (const predicate of predicatesOf(query)) {
      if (predicate.kind !== "membership") continue;
      for (const groupId of predicate.anyOf ?? []) indices.push(scopeDependency(groupId));
    }
    return { indices, covered: [] };
  },
  resolver: () => scopeSubjects,
};
