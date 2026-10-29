/**
 * The fixed vocabulary the demo's status and priority controls offer.
 * Values are plain strings on the `issue` row; the pickers render these
 * lists and the seed uses the same literals.
 */

import type { SelectOption } from "./SelectField";

export const ISSUE_STATUSES = ["todo", "in_progress", "done"] as const;
export const ISSUE_PRIORITIES = ["low", "medium", "high", "urgent"] as const;

/** Human label for a stored status value. */
export function statusLabel(status: string): string {
  return status.replace("_", " ");
}

export const STATUS_OPTIONS: readonly SelectOption[] = ISSUE_STATUSES.map((value) => ({
  value,
  label: statusLabel(value),
}));

export const PRIORITY_OPTIONS: readonly SelectOption[] = ISSUE_PRIORITIES.map((value) => ({
  value,
  label: value,
}));

/** How a profile is named in every assignee control. */
export function profileLabel(profile: { display_name: string; actor_id: string }): string {
  return `${profile.display_name} (${profile.actor_id})`;
}

/** Assignee options: the profiles visible in the issue's workspace. */
export function assigneeOptions(
  profiles: readonly { id: string; display_name: string; actor_id: string }[],
): readonly SelectOption[] {
  return [
    { value: "", label: "unassigned" },
    ...profiles.map((profile) => ({ value: profile.id, label: profileLabel(profile) })),
  ];
}

/** Filter options prepend the "any" choice to a picker's vocabulary. */
function withAny(label: string, options: readonly SelectOption[]): readonly SelectOption[] {
  return [{ value: "", label }, ...options];
}

export const STATUS_FILTER_OPTIONS = withAny("any status", STATUS_OPTIONS);
export const PRIORITY_FILTER_OPTIONS = withAny("any priority", PRIORITY_OPTIONS);

/** Assignee filter options: the profiles the actor can see. */
export function assigneeFilterOptions(
  profiles: readonly { id: string; display_name: string; actor_id: string }[],
): readonly SelectOption[] {
  return withAny(
    "anyone",
    profiles.map((profile) => ({ value: profile.id, label: profileLabel(profile) })),
  );
}
