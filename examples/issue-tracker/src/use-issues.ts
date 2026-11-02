/**
 * The one query behind the issue list and the board. Filters become replica
 * predicates, and the title ordering (with the engine's id tiebreaker) is what
 * makes a grown `limit` a stable next page.
 */

import { useQuery, type IssueReadRoot } from "./use-ebb";
import type { IssueFilters } from "./issue-view";

/**
 * The issues query for one filter selection and window size. The hook runs it
 * against the provider's client and a test against its own, so both share one
 * chain instead of keeping two copies in sync.
 */
export function issueQuery(filters: IssueFilters, limit: number) {
  return (q: IssueReadRoot) => {
    const base = q.issue.query().with({ assignee: true }).orderBy("title", "asc");
    const byStatus = filters.status === "" ? base : base.where("status", filters.status);
    const byPriority =
      filters.priority === "" ? byStatus : byStatus.where("priority", filters.priority);
    const byAssignee =
      filters.assignee === "" ? byPriority : byPriority.where("assignee", filters.assignee);
    return byAssignee.limit(limit);
  };
}

/** Subscribe a component to the filtered, paged issue rows. */
export function useIssues(filters: IssueFilters, limit: number) {
  return useQuery(issueQuery(filters, limit), [
    filters.status,
    filters.priority,
    filters.assignee,
    limit,
  ]);
}
