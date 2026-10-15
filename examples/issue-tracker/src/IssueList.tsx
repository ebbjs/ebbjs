/**
 * The workspace issue list. For the actor's default workspace this is
 * empty: the seeded sample issue lives in the shared workspace, which the
 * actor has not joined yet (membership is #441).
 */

import { useClient, useQuery } from "@ebbjs/react";
import type { Schema } from "./schema";

export function IssueList() {
  const client = useClient<Schema>();
  const { data: issues, loading, error } = useQuery(() => client.issue.query());

  return (
    <section className="rounded border border-stone-800 p-4">
      <h2 className="mb-3 font-mono text-xs uppercase tracking-wide text-stone-500">
        issues <span className="text-stone-600">({issues.length})</span>
      </h2>
      {error !== null ? (
        <p className="font-mono text-xs text-red-400">{error.message}</p>
      ) : loading ? (
        <p className="font-mono text-xs text-stone-500">loading…</p>
      ) : issues.length === 0 ? (
        <p className="font-mono text-xs text-stone-500">
          No issues yet. The sample issue lives in the shared workspace, which this actor has not
          joined (see #441).
        </p>
      ) : (
        <ul className="space-y-1">
          {issues.map((issue) => (
            <li
              key={issue.id}
              className="flex items-center gap-3 rounded border border-stone-800 px-3 py-2 font-mono text-xs"
            >
              <span className="flex-1 text-stone-200">{issue.title}</span>
              <span className="rounded bg-stone-800 px-2 py-0.5 text-stone-300">
                {issue.status}
              </span>
              <span className="rounded bg-stone-800 px-2 py-0.5 text-stone-300">
                {issue.priority}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
