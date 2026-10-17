/**
 * The workspace issue list. Rows are selectable so the detail view can
 * edit the one the actor picked; the "new issue" control opens the create
 * form. Reads go through `useQuery`, so optimistic creates and deletes
 * land without a reload (the Outbox materializes them locally first).
 *
 * The list is deliberately read-only here: the board, filters, and live
 * concurrent-edit behaviour are #440.
 */

import { useClient, useQuery } from "@ebbjs/react";
import { statusLabel } from "./issue-options";
import type { Schema } from "./schema";

export function IssueList({
  selectedId,
  onSelect,
  onNewIssue,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewIssue: () => void;
}) {
  const client = useClient<Schema>();
  const { data: issues, loading, error } = useQuery(() => client.issue.query());

  return (
    <section className="rounded border border-stone-800 p-4">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="font-mono text-xs uppercase tracking-wide text-stone-500">
          issues <span className="text-stone-600">({issues.length})</span>
        </h2>
        <button
          type="button"
          onClick={onNewIssue}
          className="ml-auto rounded border border-emerald-700 px-2 py-0.5 font-mono text-xs text-emerald-300 hover:border-emerald-500"
        >
          new issue
        </button>
      </div>
      {error !== null ? (
        <p className="font-mono text-xs text-red-400">{error.message}</p>
      ) : loading ? (
        <p className="font-mono text-xs text-stone-500">loading…</p>
      ) : issues.length === 0 ? (
        <p className="font-mono text-xs text-stone-500" data-testid="issue-list-empty">
          No issues yet. Create one to get started.
        </p>
      ) : (
        <ul className="space-y-1">
          {issues.map((issue) => (
            <li key={issue.id}>
              <button
                type="button"
                onClick={() => onSelect(issue.id)}
                aria-pressed={issue.id === selectedId}
                className={`flex w-full items-center gap-3 rounded border px-3 py-2 text-left font-mono text-xs ${
                  issue.id === selectedId
                    ? "border-emerald-700 bg-stone-900"
                    : "border-stone-800 hover:border-stone-700"
                }`}
              >
                <span className="flex-1 truncate text-stone-200">{issue.title}</span>
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
      )}
    </section>
  );
}
