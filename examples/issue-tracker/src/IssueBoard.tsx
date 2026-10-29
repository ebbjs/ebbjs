/**
 * The status board: one column per status over the list's rows. Grouping
 * is a pure projection of the same `useQuery` result, so a live edit moves
 * a card between columns without a second read or a reload.
 */

import { groupIssuesByStatus, type IssueRowView } from "./issue-view";

export function IssueBoard({
  issues,
  selectedId,
  onSelect,
}: {
  issues: readonly IssueRowView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const groups = groupIssuesByStatus(issues);

  return (
    <div className="grid gap-3 md:grid-cols-3" data-testid="issue-board">
      {groups.map((group) => (
        <section
          key={group.status}
          data-testid={`board-column-${group.status}`}
          className="min-w-0 rounded border border-stone-800 bg-stone-950/40 p-2"
        >
          <h3 className="mb-2 flex items-center gap-2 px-1 font-mono text-[10px] uppercase tracking-wide text-stone-500">
            {group.label}
            <span className="text-stone-600">{group.rows.length}</span>
          </h3>
          {group.rows.length === 0 ? (
            <p className="px-1 pb-1 font-mono text-[10px] text-stone-600">empty</p>
          ) : (
            <ul className="space-y-1">
              {group.rows.map((issue) => (
                <li key={issue.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(issue.id)}
                    aria-pressed={issue.id === selectedId}
                    data-testid={`board-card-${issue.id}`}
                    className={`w-full rounded border px-2 py-1.5 text-left font-mono text-xs ${
                      issue.id === selectedId
                        ? "border-emerald-700 bg-stone-900"
                        : "border-stone-800 bg-stone-900/50 hover:border-stone-700"
                    }`}
                  >
                    <span className="block truncate text-stone-200">{issue.title}</span>
                    <span className="mt-1 flex items-center gap-2 text-[10px] text-stone-500">
                      <span>{issue.priority}</span>
                      <span className="truncate">
                        {issue.assignee?.display_name ?? "unassigned"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
