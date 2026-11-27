/**
 * The `scope` index family (#961, #1003).
 *
 * A membership predicate reads one group's scope. The index is keyed by the
 * group id a read names, and a change resolves to the groups its membership
 * delta moved — or to `null` when a membership change carries no delta and the
 * journal cannot say which group it left.
 *
 * The group is the read's whole membership dependency: no component names it,
 * so the key is one `isRelevant` and the patch gate re-check themselves before
 * trusting a retained result (#1011).
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
 * A delta omits a part nothing moved in, so a change carrying no membership
 * part moved no pair and no scoped read needs it. A membership change with no
 * delta at all could have left a group the journal does not name, and answers
 * `null` so dispatch falls back to every scoped read.
 */
const scopeSubjects = (change: ReplicaChange): readonly string[] | null => {
  const membership = change.delta?.membership;
  if (membership === undefined) {
    return change.kind === "content" || change.delta !== undefined ? [] : null;
  }
  const groups = [membership.before?.groupId, membership.after?.groupId].filter(
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
    return { indices, covered: [], recheck: indices };
  },
  resolver: () => scopeSubjects,
};
