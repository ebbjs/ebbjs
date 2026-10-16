/**
 * The fixed vocabulary the demo's status and priority controls offer.
 * Values are plain strings on the `issue` row; the pickers render these
 * lists and the seed uses the same literals.
 */

export const ISSUE_STATUSES = ["todo", "in_progress", "done"] as const;
export const ISSUE_PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

/** Human label for a stored status value. */
export function statusLabel(status: string): string {
  return status.replace("_", " ");
}
