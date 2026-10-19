/**
 * Workspace switcher.
 *
 * Lists the workspaces visible to the actor with `useQuery`, joined to the
 * workspace's built-in `groups` rows so each row carries its group ids
 * without a second read. Selecting one swaps the printed group id, proving
 * the `workspace` schema needs no `group_id` field.
 */

import { useState } from "react";
import { useQuery, type QueryRoot } from "@ebbjs/react";
import type { Schema } from "./schema";

export function WorkspaceSwitcher() {
  const { data: workspaces = [], loading } = useQuery((q: QueryRoot<Schema>) =>
    q.workspace.query().with({ groups: true }),
  );
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const selected = workspaces.find((row) => row.slug === selectedSlug) ?? workspaces[0];
  const groupIds = selected?.groups.map((group) => group.id) ?? [];

  if (loading) {
    return <span className="font-mono text-xs text-stone-500">workspaces…</span>;
  }

  return (
    <div className="flex items-center gap-2">
      <label className="font-mono text-xs text-stone-500">workspace:</label>
      <select
        value={selected?.slug ?? ""}
        onChange={(event) => setSelectedSlug(event.target.value)}
        disabled={workspaces.length === 0}
        className="rounded border border-stone-700 bg-stone-900 px-1 py-0.5 font-mono text-xs text-stone-200 focus:border-emerald-500 focus:outline-none"
      >
        {workspaces.length === 0 && <option value="">none</option>}
        {workspaces.map((row) => (
          <option key={row.slug} value={row.slug}>
            {row.name}
          </option>
        ))}
      </select>
      <span className="font-mono text-xs text-stone-500">
        group:{" "}
        <span className="text-emerald-400" data-testid="workspace-group-id">
          {groupIds.join(", ") || "…"}
        </span>
      </span>
    </div>
  );
}
