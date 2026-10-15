/**
 * Test helpers for asserting on the Updates an Action carries.
 *
 * Action-level tests otherwise hand-roll the same two moves: finding
 * the Update that targets a subject, and peeling
 * `data.fields[k].value` (recursively, for map fields) into a plain
 * object. These helpers do both, reusing the client's projection rule
 * so a test's expectation matches what the materializer stores.
 *
 * No test runner is imported: the helpers throw plain `Error`s on a
 * violated expectation, so any consumer's test file can import them.
 */
import type { Action, Update } from "@ebbjs/core";
import { projectFieldValue, projectFields } from "../sync/query-builder";

export { projectFieldValue };

/** Every Update in the Action whose `subject_type` matches, in order. */
export const updatesOfType = (action: Action, subjectType: string): readonly Update[] =>
  action.updates.filter((update) => update.subject_type === subjectType);

/**
 * The single Update targeting `subjectId`. Throws when the Action holds
 * zero or several, since a caller asserting fields means "the" Update.
 */
export const onlyUpdate = (action: Action, subjectId: string): Update => {
  const matches = action.updates.filter((update) => update.subject_id === subjectId);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one Update for subject "${subjectId}", found ${matches.length}`,
    );
  }
  return matches[0];
};

/** Project an Update's `data.fields` to unwrapped values; `{}` when it has none. */
export const projectUpdate = (update: Update): Record<string, unknown> => {
  const data = update.data;
  return data === null ? {} : projectFields(data.fields);
};

/** Project the fields of the single Update targeting `subjectId`. */
export const fieldsOf = (action: Action, subjectId: string): Record<string, unknown> =>
  projectUpdate(onlyUpdate(action, subjectId));
