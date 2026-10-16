/**
 * Issue detail view: edit title / status / priority, link or unlink the
 * `assignee` relationship, and delete with a confirmation step.
 *
 * `useEntity` subscribes to the row; `useEntityMutations` supplies
 * `update` / `delete`; `client.issue.link` / `unlink` write the
 * relationship. Every write goes through the Outbox, so the change shows
 * immediately and reconciles when the server acknowledges it.
 *
 * A Relationship write does not emit a change for the source row, so the
 * view bumps `revision` after link / unlink; the re-read is what resolves
 * the assignee through the `issue.assignee` accessor.
 */

import { useEffect, useState } from "react";
import { useClient, useEntity, useEntityMutations, useQuery } from "@ebbjs/react";
import { ISSUE_PRIORITIES, ISSUE_STATUSES, statusLabel } from "./issue-options";
import type { Schema } from "./schema";

export function IssueDetail({
  issueId,
  onClose,
  onDeleted,
}: {
  issueId: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const client = useClient<Schema>();
  const { update, delete: remove } = useEntityMutations(client.issue);
  const { data: profiles } = useQuery(() => client.profile.query());
  const [revision, setRevision] = useState(0);
  const issue = useEntity(() => client.issue.get(issueId), [issueId, revision]);
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTitle(issue?.title ?? "");
  }, [issue?.title]);

  useEffect(() => {
    if (issue === null) {
      setAssigneeId("");
      return;
    }
    let cancelled = false;
    void (async () => {
      const target = await issue.assignee;
      if (!cancelled) setAssigneeId(target == null ? "" : target.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [issue]);

  const fail = (err: unknown): void => setError(err instanceof Error ? err.message : String(err));

  if (issue === null) {
    return (
      <section className="rounded border border-stone-800 p-4">
        <p className="font-mono text-xs text-stone-500">This issue is no longer available.</p>
        <button
          type="button"
          onClick={onClose}
          className="mt-3 rounded border border-stone-700 px-2 py-0.5 font-mono text-xs text-stone-400 hover:border-stone-500"
        >
          close
        </button>
      </section>
    );
  }

  const commitTitle = (): void => {
    const next = title.trim();
    if (next === "" || next === issue.title) {
      setTitle(issue.title);
      return;
    }
    setError(null);
    void update(issue.id, { title: next }).catch(fail);
  };

  const changeStatus = (next: string): void => {
    setError(null);
    void update(issue.id, { status: next }).catch(fail);
  };

  const changePriority = (next: string): void => {
    setError(null);
    void update(issue.id, { priority: next }).catch(fail);
  };

  const changeAssignee = (next: string): void => {
    setError(null);
    const previous = assigneeId;
    setAssigneeId(next);
    const write =
      next === ""
        ? client.issue.unlink(issue.id, "assignee")
        : client.issue.link(issue.id, "assignee", next);
    void write
      .then(() => setRevision((current) => current + 1))
      .catch((err) => {
        setAssigneeId(previous);
        fail(err);
      });
  };

  const confirmDelete = (): void => {
    setError(null);
    void remove(issue.id).then(onDeleted).catch(fail);
  };

  return (
    <section className="rounded border border-stone-800 p-4">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="font-mono text-xs uppercase tracking-wide text-stone-500">issue</h2>
        <span className="font-mono text-[10px] text-stone-600">{issue.id}</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded border border-stone-700 px-2 py-0.5 font-mono text-xs text-stone-400 hover:border-stone-500"
        >
          close
        </button>
      </div>

      <div className="space-y-3">
        <label className="block font-mono text-xs text-stone-400">
          title
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitTitle();
              }
            }}
            className="mt-1 w-full rounded border border-stone-700 bg-stone-900 px-2 py-1 font-mono text-xs text-stone-200 focus:border-emerald-500 focus:outline-none"
          />
        </label>

        <div className="flex flex-wrap gap-3">
          <label className="font-mono text-xs text-stone-400">
            status
            <select
              value={issue.status}
              onChange={(event) => changeStatus(event.target.value)}
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
              value={issue.priority}
              onChange={(event) => changePriority(event.target.value)}
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
              onChange={(event) => changeAssignee(event.target.value)}
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

        <div className="flex items-center gap-2 border-t border-stone-800 pt-3">
          {confirmingDelete ? (
            <>
              <span className="font-mono text-xs text-stone-400">Delete this issue?</span>
              <button
                type="button"
                onClick={confirmDelete}
                className="rounded border border-red-700 px-2 py-0.5 font-mono text-xs text-red-300 hover:border-red-500"
              >
                yes, delete
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="rounded border border-stone-700 px-2 py-0.5 font-mono text-xs text-stone-400 hover:border-stone-500"
              >
                cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="rounded border border-stone-700 px-2 py-0.5 font-mono text-xs text-stone-400 hover:border-red-700 hover:text-red-300"
            >
              delete
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
