/**
 * Pure view-model tests for the list/board slice: the board is a
 * projection of the list's rows, and pagination is a growing window over
 * one stable ordering.
 */

import { describe, expect, it } from "vitest";
import {
  ISSUE_PAGE_SIZE,
  NO_ISSUE_FILTERS,
  groupIssuesByStatus,
  hasActiveFilters,
  hasMoreIssues,
  issuePageLimit,
} from "../issue-view";

const row = (id: string, status: string) => ({ id, status, title: id });

describe("groupIssuesByStatus", () => {
  it("keeps the picker's column order and partitions every row exactly once", () => {
    const rows = [row("a", "done"), row("b", "todo"), row("c", "in_progress"), row("d", "todo")];
    const groups = groupIssuesByStatus(rows);

    expect(groups.map((group) => group.status)).toEqual(["todo", "in_progress", "done"]);
    expect(groups.map((group) => group.rows.map((entry) => entry.id))).toEqual([
      ["b", "d"],
      ["c"],
      ["a"],
    ]);
    expect(groups.flatMap((group) => group.rows)).toHaveLength(rows.length);
  });

  it("renders empty columns for statuses no row uses", () => {
    const groups = groupIssuesByStatus([row("a", "todo")]);
    expect(groups.find((group) => group.status === "done")?.rows).toEqual([]);
  });

  it("gives an unexpected status a trailing column instead of dropping the row", () => {
    const groups = groupIssuesByStatus([
      row("a", "todo"),
      row("b", "blocked"),
      row("c", "archive"),
    ]);

    expect(groups.map((group) => group.status)).toEqual([
      "todo",
      "in_progress",
      "done",
      "archive",
      "blocked",
    ]);
    expect(
      groups.find((group) => group.status === "blocked")?.rows.map((entry) => entry.id),
    ).toEqual(["b"]);
  });
});

describe("pagination window", () => {
  it("grows by one page and never shrinks below the first page", () => {
    expect(issuePageLimit(1)).toBe(ISSUE_PAGE_SIZE);
    expect(issuePageLimit(2)).toBe(ISSUE_PAGE_SIZE * 2);
    expect(issuePageLimit(0)).toBe(ISSUE_PAGE_SIZE);
    expect(issuePageLimit(-3)).toBe(ISSUE_PAGE_SIZE);
  });

  it("asks for another page only when the current window is full", () => {
    expect(hasMoreIssues(0, ISSUE_PAGE_SIZE)).toBe(false);
    expect(hasMoreIssues(ISSUE_PAGE_SIZE - 1, ISSUE_PAGE_SIZE)).toBe(false);
    expect(hasMoreIssues(ISSUE_PAGE_SIZE, ISSUE_PAGE_SIZE)).toBe(true);
  });
});

describe("filters", () => {
  it("treats empty selections as no filter", () => {
    expect(hasActiveFilters(NO_ISSUE_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...NO_ISSUE_FILTERS, status: "todo" })).toBe(true);
    expect(hasActiveFilters({ ...NO_ISSUE_FILTERS, priority: "high" })).toBe(true);
    expect(hasActiveFilters({ ...NO_ISSUE_FILTERS, assignee: "prof_alice" })).toBe(true);
  });
});
