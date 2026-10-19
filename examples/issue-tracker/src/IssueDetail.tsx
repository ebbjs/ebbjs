/**
 * Issue detail view: edit title / status / priority, link or unlink the
 * `assignee` relationship, and delete with a confirmation step.
 *
 * The row and its assignee come from one `useQuery` with an `assignee` join,
 * so a link / unlink re-runs the query and the projection follows without a
 * manual revision bump. Mutations go straight through the client's issue
 * namespace; each write applies optimistically through the Outbox and
 * reconciles when the server acknowledges it.
 */

import { useEffect, useState } from "react";
import { useClient, useQuery, type QueryRoot } from "@ebbjs/react";
import { PRIORITY_OPTIONS, STATUS_OPTIONS, assigneeOptions } from "./issue-options";
import { SelectField } from "./SelectField";
import type { Schema } from "./schema";

export function IssueDetail({
  issueId,
  groupId,
  onClose,
  onDeleted,
}: {
  issueId: string;
  groupId: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const client = useClient<Schema>();
  const {
    data: issues,
    status,
    error: queryError,
  } = useQuery((q: QueryRoot<Schema>) => q.issue.query().with({ assignee: true }));
  const { data: profiles = [] } = useQuery(
    (q: QueryRoot<Schema>) => q.profile.query().where("groups", groupId),
    [groupId],
  );
  const issue = issues?.find((row) => row.id === issueId) ?? null;
  const assigneeId = issue?.assignee?.id ?? "";
  const [title, setTitle] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  useEffect(() => {
    setTitle(issue?.title ?? "");
  }, [issue?.title]);

  const fail = (err: unknown): void =>
    setWriteError(err instanceof Error ? err.message : String(err));

  if (status === "unloaded") {
    return (
      <section className="rounded border border-stone-800 p-4">
        <p className="font-mono text-xs text-stone-500">loading…</p>
      </section>
    );
  }

  if (issue === null) {
    return (
      <section className="rounded border border-stone-800 p-4">
        <p className="font-mono text-xs text-stone-500">
          {status === "failed"
            ? (queryError?.message ?? "The issue query failed.")
            : "This issue is no longer available."}
        </p>
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
    setWriteError(null);
    void client.issue.update(issue.id, { title: next }).catch(fail);
  };

  const changeStatus = (next: string): void => {
    setWriteError(null);
    void client.issue.update(issue.id, { status: next }).catch(fail);
  };

  const changePriority = (next: string): void => {
    setWriteError(null);
    void client.issue.update(issue.id, { priority: next }).catch(fail);
  };

  const changeAssignee = (next: string): void => {
    setWriteError(null);
    const write =
      next === ""
        ? client.issue.unlink(issue.id, "assignee")
        : client.issue.link(issue.id, "assignee", next);
    void write.catch(fail);
  };

  const confirmDelete = (): void => {
    setWriteError(null);
    void client.issue.delete(issue.id).then(onDeleted).catch(fail);
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
          <SelectField
            label="status"
            value={issue.status}
            onChange={changeStatus}
            options={STATUS_OPTIONS}
          />
          <SelectField
            label="priority"
            value={issue.priority}
            onChange={changePriority}
            options={PRIORITY_OPTIONS}
          />
          <SelectField
            label="assignee"
            value={assigneeId}
            onChange={changeAssignee}
            options={assigneeOptions(profiles)}
          />
        </div>

        {writeError !== null && <p className="font-mono text-xs text-red-400">{writeError}</p>}

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
