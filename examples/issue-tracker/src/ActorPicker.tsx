/**
 * In-app actor identity selector. `onChange` triggers a full re-bootstrap
 * under the new identity.
 */

import { useEffect, useRef, useState } from "react";

export const KNOWN_ACTORS = ["alice", "bob", "drew"] as const;
export type KnownActor = (typeof KNOWN_ACTORS)[number];
export type ActorId = KnownActor | (string & {});

export function ActorPicker({
  value,
  onChange,
}: {
  value: ActorId;
  onChange: (actorId: ActorId) => void;
}) {
  // Local mirror of `value` so typing doesn't commit on every keystroke;
  // commit happens on Enter or when the dropdown changes.
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const isKnown = KNOWN_ACTORS.includes(draft as KnownActor);
  const isDirty = draft !== value;

  return (
    <div className="flex items-center gap-2">
      <label className="font-mono text-xs text-stone-500">actor:</label>
      <select
        value={isKnown ? draft : "__custom__"}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "__custom__") {
            inputRef.current?.focus();
            return;
          }
          setDraft(next);
          if (next !== value) onChange(next);
        }}
        className="rounded border border-stone-700 bg-stone-900 px-1 py-0.5 font-mono text-xs text-stone-200 focus:border-emerald-500 focus:outline-none"
      >
        {KNOWN_ACTORS.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
        <option value="__custom__">Custom…</option>
      </select>
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && isDirty) {
            event.preventDefault();
            onChange(draft);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(value);
          }
        }}
        placeholder="custom id"
        className="w-32 rounded border border-stone-700 bg-stone-900 px-2 py-0.5 font-mono text-xs text-emerald-400 focus:border-emerald-500 focus:outline-none"
      />
      {isDirty && (
        <button
          type="button"
          onClick={() => onChange(draft)}
          className="rounded border border-emerald-700 px-2 py-0.5 font-mono text-xs text-emerald-300 hover:border-emerald-500"
        >
          apply
        </button>
      )}
    </div>
  );
}
