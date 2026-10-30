/**
 * The issues surface: filters, a list/board toggle, and one paged query
 * shared by both views.
 *
 * `useIssues` is the only read. Flipping to the board does not re-query,
 * and a remote edit flows through the same query store into whichever view
 * is on screen. "Show more" grows the query's `limit`; the grammar has no
 * cursor, so a grown window stays a prefix of the previous page and rows
 * cannot duplicate or vanish at the boundary.
 */

import { useState } from "react";
import { IssueBoard } from "./IssueBoard";
import { IssueFiltersBar } from "./IssueFiltersBar";
import { IssueList } from "./IssueList";
import {
  hasActiveFilters,
  hasMoreIssues,
  issuePageLimit,
  NO_ISSUE_FILTERS,
  type IssueFilters,
} from "./issue-view";
import { useIssues } from "./use-issues";
import { useVisibleProfiles } from "./use-visible-profiles";

type IssueView = "list" | "board";

export function IssuesPanel({
  selectedId,
  onSelect,
  onNewIssue,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewIssue: () => void;
}) {
  const [filters, setFilters] = useState<IssueFilters>(NO_ISSUE_FILTERS);
  const [view, setView] = useState<IssueView>("list");
  const [pages, setPages] = useState(1);
  const limit = issuePageLimit(pages);
  const { data: issues = [], status, loading, error } = useIssues(filters, limit);
  const profiles = useVisibleProfiles();

  const applyFilters = (next: IssueFilters): void => {
    setFilters(next);
    setPages(1);
  };

  const showMore = (): void => {
    setPages((current) => current + 1);
  };

  return (
    <section className="rounded border border-stone-800 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-xs uppercase tracking-wide text-stone-500">
          issues <span className="text-stone-600">({issues.length})</span>
        </h2>
        <span
          className={`font-mono text-[10px] ${
            status === "stale" ? "text-amber-400" : "text-emerald-500"
          }`}
          data-testid="issue-query-status"
          data-status={status}
        >
          {status === "stale" ? "syncing…" : "live"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setView("list")}
            aria-pressed={view === "list"}
            className={`rounded border px-2 py-0.5 font-mono text-xs ${
              view === "list"
                ? "border-stone-500 text-stone-200"
                : "border-stone-800 text-stone-500 hover:border-stone-700"
            }`}
          >
            list
          </button>
          <button
            type="button"
            onClick={() => setView("board")}
            aria-pressed={view === "board"}
            className={`rounded border px-2 py-0.5 font-mono text-xs ${
              view === "board"
                ? "border-stone-500 text-stone-200"
                : "border-stone-800 text-stone-500 hover:border-stone-700"
            }`}
          >
            board
          </button>
          <button
            type="button"
            onClick={onNewIssue}
            className="ml-2 rounded border border-emerald-700 px-2 py-0.5 font-mono text-xs text-emerald-300 hover:border-emerald-500"
          >
            new issue
          </button>
        </div>
      </div>

      <IssueFiltersBar filters={filters} profiles={profiles} onChange={applyFilters} />

      {error !== null ? (
        <p className="font-mono text-xs text-red-400">{error.message}</p>
      ) : loading ? (
        <p className="font-mono text-xs text-stone-500">loading…</p>
      ) : issues.length === 0 ? (
        <p className="font-mono text-xs text-stone-500" data-testid="issue-list-empty">
          {hasActiveFilters(filters)
            ? "No issues match these filters."
            : "No issues visible. Create one, or join the shared workspace to see its issues."}
        </p>
      ) : view === "board" ? (
        <IssueBoard issues={issues} selectedId={selectedId} onSelect={onSelect} />
      ) : (
        <IssueList issues={issues} selectedId={selectedId} onSelect={onSelect} />
      )}

      {hasMoreIssues(issues.length, limit) && (
        <button
          type="button"
          onClick={showMore}
          className="mt-3 w-full rounded border border-stone-800 px-2 py-1 font-mono text-xs text-stone-400 hover:border-stone-600"
        >
          show more
        </button>
      )}
    </section>
  );
}
