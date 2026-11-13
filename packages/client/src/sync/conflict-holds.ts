/**
 * Conflict holds — the positions an open conflict keeps off the wire.
 *
 * A field- or component-scope loss holds the contested component; an
 * entity-scope loss holds the whole subject. The hold is derived from the
 * durable conflicted rows, so it survives a reload with no second store.
 */

import type { Action } from "@ebbjs/core";
import type { ConflictHold } from "@ebbjs/storage/types";

/** Stable key for one held position: the subject, and `*` for the whole subject. */
export const holdKey = (hold: ConflictHold): string =>
  `${hold.subjectId}\u0000${hold.kind === "component" ? hold.component : "*"}`;

/**
 * Whether an Action writes any held position. An Action cannot be submitted
 * in part, so touching one held component holds the whole Action; a
 * `delete` Update detaches every component of its subject.
 */
export const actionTouchesHolds = (action: Action, holds: readonly ConflictHold[]): boolean => {
  if (holds.length === 0) return false;
  for (const update of action.updates) {
    for (const hold of holds) {
      if (hold.subjectId !== update.subject_id) continue;
      if (hold.kind === "subject") return true;
      if (update.method === "delete" || update.component === hold.component) return true;
    }
  }
  return false;
};
