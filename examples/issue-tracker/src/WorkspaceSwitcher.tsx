/**
 * Workspace switcher.
 *
 * Lists the workspaces visible to the actor with `useQuery`. Selecting
 * one resolves the row's group through the built-in accessor —
 * `client.workspace.get(id)` then `row.groups.toRaw()` — and prints the
 * group id, proving the `workspace` schema needs no `group_id` field.
 * The entity id comes from the seed's deterministic scheme via
 * `workspaceEntityId`; #447 will surface group ids on query rows and
 * remove the lookup.
 */

import { useEffect, useState } from "react";
import { useClient, useQuery } from "@ebbjs/react";
import type { Schema } from "./schema";
import { workspaceEntityId } from "./seed";

export function WorkspaceSwitcher() {
  const client = useClient<Schema>();
  const { data: workspaces = [], loading } = useQuery(() => client.workspace.query());
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const selected = workspaces.find((row) => row.slug === selectedSlug) ?? workspaces[0];
  const [groupIds, setGroupIds] = useState<readonly string[]>([]);

  useEffect(() => {
    if (selected === undefined) {
      setGroupIds([]);
      return;
    }
    const entityId = workspaceEntityId(selected.slug);
    let cancelled = false;
    void (async () => {
      const row = await client.workspace.get(entityId);
      const groups = row === null ? [] : await row.groups.toRaw();
      if (!cancelled) setGroupIds(groups.map((group) => group.id));
    })();
    return () => {
      cancelled = true;
    };
  }, [client, selected]);

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
