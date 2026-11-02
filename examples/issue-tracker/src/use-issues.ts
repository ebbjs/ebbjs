/**
 * The one query behind the issue list and the board.
 *
 * Filters become predicates on the replica query — status and priority as
 * field equality, assignee through the `assignee` relationship — so the
 * result is already narrowed when the board or the list projects it. The
 * chain is ordered by title with the engine's id tiebreaker, which is what
 * makes a grown `limit` a stable next page.
 */

import { useQuery, type IssueReadRoot } from "./use-ebb";
import type { IssueFilters } from "./issue-view";

/**
 * The issues query for one filter selection and window size, as a function of
 * a read root. The hook runs it against the provider's client; a test runs it
 * against a client it built, so the query a test asserts and the query the UI
 * renders are the same value rather than two copies.
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
