/**
 * The `scope` index family (#961, #1003).
 *
 * A membership predicate reads one group's scope. The index is keyed by the
 * group id a read names, and a change resolves to the group whose membership
 * it moved — or to `null` when the journal cannot say which group was left.
 */

import { EBB_COMPONENTS, systemValueString, type Entity } from "@ebbjs/core";
import type { Replica } from "@ebbjs/storage/replica";

import type { IndexDependency, IndexResolver } from "./dependency-index";
import { predicatesOf, type IndexFamily } from "./index-family";

/** Scope-aware reads: one dependency per group id whose membership the read follows. */
const SCOPE_INDEX = "scope";

/** The dependency a scope-aware read adds for one group. */
const scopeDependency = (groupId: string): IndexDependency => ({
  index: SCOPE_INDEX,
  key: groupId,
});

/** The group a changed row is filed under, read from its `ebb/membership` value. */
const membershipGroupId = (row: Entity): string | null =>
  systemValueString(row, "membership", "group_id");

/**
 * The group whose membership a change moved. An entering or refiled row names
 * its current group, so a scoped read of another group is left alone. A row
 * that left, or a membership value write, may have left a group the journal
 * does not name — and an evicted row is gone — so those answer `null` and
 * dispatch falls back to every scoped read.
 */
const scopeSubjects =
  (replica: Replica): IndexResolver =>
  (change) => {
    if (change.kind === "content" && !change.components.includes(EBB_COMPONENTS.membership)) {
      return [];
    }
    if (change.kind === "content") return null;
    const changed = replica.get(change.id);
    if (changed === undefined) return null;
    const groupId = membershipGroupId(changed);
    if (groupId === null || groupId.length === 0) {
      return change.membership === "left" ? null : [];
    }
    return [groupId];
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
  resolver: (replica) => scopeSubjects(replica),
};
