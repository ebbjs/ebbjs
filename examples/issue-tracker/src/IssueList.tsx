/**
 * The workspace issue list. Rows are selectable so the detail view can
 * edit the one the actor picked. Data comes from the panel's single
 * `useQuery`; this component only projects it, so the board can render the
 * same rows without a second read.
 */

import { statusLabel } from "./issue-options";
import type { IssueRow } from "./issue-view";

export function IssueList({
  issues,
  selectedId,
  onSelect,
}: {
  issues: readonly IssueRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="space-y-1" data-testid="issue-list">
      {issues.map((issue) => (
        <li key={issue.id}>
          <button
            type="button"
            onClick={() => onSelect(issue.id)}
            aria-pressed={issue.id === selectedId}
            data-testid={`issue-row-${issue.id}`}
            className={`flex w-full items-center gap-3 rounded border px-3 py-2 text-left font-mono text-xs ${
              issue.id === selectedId
                ? "border-emerald-700 bg-stone-900"
                : "border-stone-800 hover:border-stone-700"
            }`}
          >
            <span className="flex-1 truncate text-stone-200">{issue.title}</span>
            <span className="hidden truncate text-stone-500 sm:inline">
              {issue.assignee?.display_name ?? "unassigned"}
            </span>
            <span className="rounded bg-stone-800 px-2 py-0.5 text-stone-300">
              {statusLabel(issue.status)}
            </span>
            <span className="rounded bg-stone-800 px-2 py-0.5 text-stone-300">
              {issue.priority}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
