/**
 * The one query behind the issue list and the board.
 *
 * Filters become predicates on the replica query — status and priority as
 * field equality, assignee through the `assignee` relationship — so the
 * result is already narrowed when the board or the list projects it. The
 * chain is ordered by title with the engine's id tiebreaker, which is what
 * makes a grown `limit` a stable next page.
 */

import { useQuery, type QueryRoot } from "@ebbjs/react";
import type { Schema } from "./schema";
import type { IssueFilters } from "./issue-view";

/**
 * Build the issue chain for one filter selection and window size. Exported
 * so the integration tests exercise the same chain the hook renders.
 */
export function buildIssueQuery(q: QueryRoot<Schema>, filters: IssueFilters, limit: number) {
  const base = q.issue.query().with({ assignee: true }).orderBy("title", "asc");
  const byStatus = filters.status === "" ? base : base.where("status", filters.status);
  const byPriority =
    filters.priority === "" ? byStatus : byStatus.where("priority", filters.priority);
  const byAssignee =
    filters.assignee === "" ? byPriority : byPriority.where("assignee", filters.assignee);
  return byAssignee.limit(limit);
}

/** Subscribe a component to the filtered, paged issue rows. */
export function useIssues(filters: IssueFilters, limit: number) {
  return useQuery(
    (q: QueryRoot<Schema>) => buildIssueQuery(q, filters, limit),
    [filters.status, filters.priority, filters.assignee, limit],
  );
}
