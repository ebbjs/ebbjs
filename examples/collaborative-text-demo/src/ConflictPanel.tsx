/**
 * Conflict panel — collapsible sidebar listing the entity-level
 * conflicts the client surfaced. A conflict is the set of losing
 * buffered Actions detected together for one connected set of subjects;
 * each subject carries the row the client had before the sync, the
 * server's row after it, and the positions that differ. The panel lets
 * the user retry or discard the whole conflict.
 *
 * Grouping is durable: every losing Action in one connected set shares
 * the `conflictId` detection stamped on its outbox row, so the panel
 * reads the same entity-level `Conflict` the rest of the app would.
 */

import { useEffect, useState } from "react";
import type { Conflict } from "@ebbjs/client";
import { createClient } from "@ebbjs/client";

interface Props {
  client: ReturnType<typeof createClient>;
  docId: string;
  groupId: string;
}

/** Render one diff side; an absent side is a removed/added value, not a tombstone. */
const showValue = (value: unknown): string =>
  value === undefined ? "(absent)" : JSON.stringify(value);

export function ConflictPanel({ client, docId, groupId }: Props) {
  const [conflicts, setConflicts] = useState<readonly Conflict[]>([]);

  useEffect(() => {
    let active = true;
    // Seed from the durable store, then follow live changes. Detection
    // writes the conflict payload through the outbox, so `onChange` fires
    // without a poll.
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

  const resolve = (conflictId: string, resolution: "retry" | "discard"): void => {
    void client.conflicts.resolve(conflictId, resolution);
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
        {conflicts.map((conflict) => {
          return (
            <li
              key={conflict.id}
              className="rounded border border-stone-800 bg-stone-900 p-3 text-xs"
            >
              <div className="flex items-baseline justify-between mb-2">
                <span className="font-mono text-amber-400">{conflict.id}</span>
                <span className="text-stone-500">
                  {conflict.remoteWins() ? "server wins" : "your write wins"}
                </span>
              </div>
              <div className="flex flex-col gap-2">
                {conflict.subjectStates.map((state) => (
                  <div key={state.subjectId} className="flex flex-col gap-1">
                    <div className="font-mono text-stone-500 break-words">{state.subjectId}</div>
                    {state.diff.map((diff, index) => (
                      <div key={`${diff.field}:${diff.path.join(".")}:${index}`}>
                        <div className="text-stone-500">
                          {diff.field}
                          {diff.path.length > 0 ? ` → ${diff.path.join(" → ")}` : ""}
                          <span className="ml-1 text-stone-600">{diff.kind}</span>
                        </div>
                        <pre className="bg-stone-950 p-2 rounded text-stone-300 whitespace-pre-wrap break-words">
                          {showValue(diff.before)} → {showValue(diff.after)}
                        </pre>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              <div className="mt-2 flex gap-3">
                <button
                  onClick={() => resolve(conflict.id, "retry")}
                  className="text-emerald-400 hover:text-emerald-200"
                >
                  retry
                </button>
                <button
                  onClick={() => resolve(conflict.id, "discard")}
                  className="text-stone-500 hover:text-stone-200"
                >
                  discard
                </button>
              </div>
              {/* groupId is unused today — kept in the panel signature for
                  future filtering (e.g., one panel per group). */}
              <span className="hidden">{groupId}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
