/**
 * Conflict panel — collapsible sidebar listing conflicts recorded by
 * the TextDocument. Each conflict is shown with the pre- and post-merge
 * text snippets and a "dismiss" button that clears the entry.
 */

import { useEffect, useState } from "react";
import type { Conflict } from "@ebbjs/client";
import { createClient } from "@ebbjs/client";

interface Props {
  client: ReturnType<typeof createClient>;
  docId: string;
  groupId: string;
}

export function ConflictPanel({ client, docId, groupId }: Props) {
  const [conflicts, setConflicts] = useState<readonly Conflict[]>([]);

  useEffect(() => {
    const doc = client.textDocument(docId);
    const unsub = doc.onConflict((c) => {
      setConflicts((prev) => [c, ...prev].slice(0, 50));
    });
    // Hydrate from any pre-existing conflicts (e.g., from catch-up).
    setConflicts(doc.conflicts());
    return unsub;
  }, [client, docId]);

  const handleDismiss = (id: string) => {
    setConflicts((prev) => prev.filter((c) => c.id !== id));
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
        {conflicts.map((c) => (
          <li key={c.id} className="rounded border border-stone-800 bg-stone-900 p-3 text-xs">
            <div className="flex items-baseline justify-between mb-2">
              <span className="font-mono text-amber-400">
                {new Date(c.detectedAt).toLocaleTimeString()}
              </span>
              <button
                onClick={() => handleDismiss(c.id)}
                className="text-stone-500 hover:text-stone-200"
              >
                dismiss
              </button>
            </div>
            <div className="text-stone-500 mb-1">Pre-merge:</div>
            <pre className="bg-stone-950 p-2 rounded text-stone-300 whitespace-pre-wrap break-words">
              {c.preMerge.text || "(empty)"}
            </pre>
            <div className="text-stone-500 mt-2 mb-1">Post-merge:</div>
            <pre className="bg-stone-950 p-2 rounded text-stone-300 whitespace-pre-wrap break-words">
              {c.postMerge.text || "(empty)"}
            </pre>
            <div className="text-stone-500 mt-2">
              {c.contributingActions.length} contributing action(s)
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
