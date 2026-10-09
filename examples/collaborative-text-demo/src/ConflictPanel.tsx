/**
 * Conflict panel — collapsible sidebar listing conflicts recorded by
 * the client's durable conflict store. Each conflict is one losing
 * pending Action plus the slots a peer's write out-dated; the panel
 * lets the user retry or discard it.
 *
 * Conflict detection lives in the outbox (`client.conflicts`), so the
 * panel reads the same vocabulary the rest of the app would: a
 * collaborative-text run is one map key, and a concurrent
 * extend-vs-delete on that run is one slot.
 */

import { useEffect, useState } from "react";
import type { ConflictEntry } from "@ebbjs/client";
import { createClient } from "@ebbjs/client";

interface Props {
  client: ReturnType<typeof createClient>;
  docId: string;
  groupId: string;
}

export function ConflictPanel({ client, docId, groupId }: Props) {
  const [conflicts, setConflicts] = useState<readonly ConflictEntry[]>([]);

  useEffect(() => {
    let active = true;
    // Seed from the durable store, then follow live changes. Detection
    // writes through the manager, so `onChange` fires without a poll.
    void client.conflicts.list().then((entries) => {
      if (active) setConflicts(entries);
    });
    const unsub = client.conflicts.onChange((entries) => {
      setConflicts(entries);
    });
    return () => {
      active = false;
      unsub();
    };
  }, [client, docId]);

  const resolve = (actionId: string, resolution: "retry" | "discard"): void => {
    void client.conflicts.resolve(actionId, resolution);
  };

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-stone-200 font-mono text-sm">Conflicts</h2>
        <span className="text-stone-500 font-mono text-xs">{conflicts.length}</span>
      </div>
      <p className="text-stone-500 text-xs">
        Two or more users edited the same run concurrently. The framework recorded the merge and
        surfaced it here so you can resolve it.
      </p>
      {conflicts.length === 0 && (
        <div className="text-stone-600 text-xs italic">No conflicts yet.</div>
      )}
      <ul className="flex flex-col gap-3">
        {conflicts.map((entry) => (
          <li
            key={entry.action.id}
            className="rounded border border-stone-800 bg-stone-900 p-3 text-xs"
          >
            <div className="flex items-baseline justify-between mb-2">
              <span className="font-mono text-amber-400">{entry.action.id}</span>
              <button
                onClick={() => resolve(entry.action.id, "discard")}
                className="text-stone-500 hover:text-stone-200"
              >
                discard
              </button>
            </div>
            <ul className="flex flex-col gap-2">
              {entry.losses.map((loss, index) => (
                <li key={`${loss.slot.subjectId}:${loss.slot.field}:${index}`}>
                  <div className="text-stone-500">
                    {loss.slot.field}
                    {loss.slot.path.length > 0 ? ` → ${loss.slot.path.join(" → ")}` : ""}
                  </div>
                  <pre className="bg-stone-950 p-2 rounded text-stone-300 whitespace-pre-wrap break-words">
                    {loss.winner.value === null || loss.winner.value === undefined
                      ? "(deleted)"
                      : JSON.stringify(loss.winner.value)}
                  </pre>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex gap-3">
              <button
                onClick={() => resolve(entry.action.id, "retry")}
                className="text-emerald-400 hover:text-emerald-200"
              >
                retry
              </button>
              <button
                onClick={() => resolve(entry.action.id, "discard")}
                className="text-stone-500 hover:text-stone-200"
              >
                dismiss
              </button>
            </div>
            {/* groupId is unused today — kept in the panel signature for
                future filtering (e.g., one panel per group). */}
            <span className="hidden">{groupId}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
