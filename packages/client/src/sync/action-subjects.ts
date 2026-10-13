/**
 * The distinct entity ids an Action's Updates touch. One helper so the
 * capture, prune, and conflict-resolution paths agree on which subjects
 * a buffered write or a conflict refers to.
 */

import type { Action } from "@ebbjs/core";

export const subjectIds = (action: Action): readonly string[] => {
  const ids = new Set<string>();
  for (const update of action.updates) ids.add(update.subject_id);
  return [...ids];
};
