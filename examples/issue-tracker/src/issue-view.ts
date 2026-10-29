/**
 * Pure view model shared by the issue list and the status board.
 *
 * The list and the board are two renderings of one `useQuery` result, so
 * everything that decides which rows appear and how they are grouped lives
 * here as data transforms. Keeping the transforms pure means the board's
 * column order and the pagination window can be tested without a server or
 * a browser.
 */

import type { EntityFields, JoinRecord, QueryRow } from "@ebbjs/client";
import type { QueryRows } from "@ebbjs/react";
import { ISSUE_STATUSES, statusLabel } from "./issue-options";
import type { issue, Schema } from "./schema";

/**
 * The issue row the list and board render: the schema's issue fields, the
 * replica query row metadata, and the `assignee` join. Deriving it from the
 * schema means a field or relationship change is a compile error here, not a
 * silently stale view type.
 */
export type IssueRow = QueryRows<
  EntityFields<typeof issue>,
  Pick<JoinRecord<Schema["relationships"], "issue">, "assignee">,
  QueryRow<EntityFields<typeof issue>>
>[number];

/** The filter selections the toolbar exposes. Empty means "any". */
export interface IssueFilters {
  readonly status: string;
  readonly priority: string;
  readonly assignee: string;
}

export const NO_ISSUE_FILTERS: IssueFilters = {
  status: "",
  priority: "",
  assignee: "",
};

/** Whether any filter narrows the query. */
export function hasActiveFilters(filters: IssueFilters): boolean {
  return filters.status !== "" || filters.priority !== "" || filters.assignee !== "";
}

/** Rows a page of the issue list asks the replica for. */
export const ISSUE_PAGE_SIZE = 20;

/**
 * The query's window size after `pages` pages. The grammar has no cursor,
 * so "next page" grows the limit: the earlier window stays a prefix of the
 * new one and a row cannot slip between pages.
 */
export function issuePageLimit(pages: number): number {
  return Math.max(1, Math.floor(pages)) * ISSUE_PAGE_SIZE;
}

/** Whether the current window may be hiding more rows. */
export function hasMoreIssues(rowCount: number, limit: number): boolean {
  return rowCount >= limit;
}

/** One board column. */
export interface IssueGroup<TRow extends { readonly status: string }> {
  readonly status: string;
  readonly label: string;
  readonly rows: readonly TRow[];
}

/**
 * Group rows into status columns. Known statuses keep the picker's order;
 * a status the schema did not anticipate gets a trailing column, so the
 * board never drops a row it cannot name.
 */
export function groupIssuesByStatus<TRow extends { readonly status: string }>(
  rows: readonly TRow[],
): readonly IssueGroup<TRow>[] {
  const known = new Set<string>(ISSUE_STATUSES);
  const extras = [
    ...new Set(rows.map((row) => row.status).filter((status) => !known.has(status))),
  ].sort();

  return [...ISSUE_STATUSES, ...extras].map((status) => ({
    status,
    label: statusLabel(status),
    rows: rows.filter((row) => row.status === status),
  }));
}
