/**
 * Create-issue form. Creates the row and, when an assignee is picked,
 * its `assignee` relationship in one atomic Action via `client.atomic`,
 * so the issue is never briefly visible without its link.
 *
 * The Outbox applies the Action optimistically, so the issue appears in
 * the list before the server acknowledges it.
 */

import { useState } from "react";
import { useClient, useQuery } from "@ebbjs/react";
import { ISSUE_PRIORITIES, ISSUE_STATUSES, statusLabel } from "./issue-options";
import type { Schema } from "./schema";

export function IssueCreateForm({
  groupId,
  onCreated,
  onCancel,
}: {
  groupId: string;
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const client = useClient<Schema>();
  const { data: profiles } = useQuery(() => client.profile.query());
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<string>(ISSUE_STATUSES[0]);
  const [priority, setPriority] = useState<string>("medium");
  const [assigneeId, setAssigneeId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedTitle = title.trim();

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (trimmedTitle === "" || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await client.atomic((drafts) =>
        drafts.issue.create(
          {
            title: trimmedTitle,
            status,
            priority,
            assignee: assigneeId === "" ? null : assigneeId,
          },
          { groups: [groupId] },
        ),
      );
      onCreated(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded border border-stone-800 p-4">
      <h2 className="mb-3 font-mono text-xs uppercase tracking-wide text-stone-500">new issue</h2>
      <form onSubmit={(event) => void submit(event)} className="space-y-3">
        <label className="block font-mono text-xs text-stone-400">
          title
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
            placeholder="What needs doing?"
            className="mt-1 w-full rounded border border-stone-700 bg-stone-900 px-2 py-1 font-mono text-xs text-stone-200 focus:border-emerald-500 focus:outline-none"
          />
        </label>

        <div className="flex flex-wrap gap-3">
          <label className="font-mono text-xs text-stone-400">
            status
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="mt-1 block rounded border border-stone-700 bg-stone-900 px-2 py-1 font-mono text-xs text-stone-200 focus:border-emerald-500 focus:outline-none"
            >
              {ISSUE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {statusLabel(value)}
                </option>
              ))}
            </select>
          </label>

          <label className="font-mono text-xs text-stone-400">
            priority
            <select
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
              className="mt-1 block rounded border border-stone-700 bg-stone-900 px-2 py-1 font-mono text-xs text-stone-200 focus:border-emerald-500 focus:outline-none"
            >
              {ISSUE_PRIORITIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label className="font-mono text-xs text-stone-400">
            assignee
            <select
              value={assigneeId}
              onChange={(event) => setAssigneeId(event.target.value)}
              className="mt-1 block rounded border border-stone-700 bg-stone-900 px-2 py-1 font-mono text-xs text-stone-200 focus:border-emerald-500 focus:outline-none"
            >
              <option value="">unassigned</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.display_name} ({profile.actor_id})
                </option>
              ))}
            </select>
          </label>
        </div>

        {error !== null && <p className="font-mono text-xs text-red-400">{error}</p>}

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={trimmedTitle === "" || submitting}
            className="rounded border border-emerald-700 px-2 py-0.5 font-mono text-xs text-emerald-300 hover:border-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "creating…" : "create"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-stone-700 px-2 py-0.5 font-mono text-xs text-stone-400 hover:border-stone-500"
          >
            cancel
          </button>
        </div>
      </form>
    </section>
  );
}
