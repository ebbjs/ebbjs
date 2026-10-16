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
import { PRIORITY_OPTIONS, STATUS_OPTIONS, assigneeOptions } from "./issue-options";
import { SelectField } from "./SelectField";
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
  const { data: profiles } = useQuery(
    () => client.profile.query().where("groups", groupId),
    [groupId],
  );
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<string>("todo");
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
          <SelectField
            label="status"
            value={status}
            onChange={setStatus}
            options={STATUS_OPTIONS}
          />
          <SelectField
            label="priority"
            value={priority}
            onChange={setPriority}
            options={PRIORITY_OPTIONS}
          />
          <SelectField
            label="assignee"
            value={assigneeId}
            onChange={setAssigneeId}
            options={assigneeOptions(profiles)}
          />
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
