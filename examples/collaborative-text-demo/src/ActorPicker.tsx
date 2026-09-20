/**
 * In-app actor identity selector.
 *
 * Replaces the previous `?actor=` URL-parameter mechanism as the
 * primary way to pick which identity the demo connects under. The URL
 * parameter is still honored as an initial deep-link seed (see
 * `App.readInitialActor`), but the picker overrides it at runtime
 * without modifying the URL — so two-tab demos can keep using
 * `?actor=drew` / `?actor=alice` deep links without each tab having to
 * be reloaded.
 *
 * UI: a dropdown of known actors (drew, alice, bob) plus an
 * inline free-text input for custom identities. Selecting from the
 * dropdown or pressing Enter in the custom field commits the choice
 * and triggers an `onChange`, which `App` translates into a full
 * re-bootstrap.
 */

import { useState, useEffect, useRef } from "react";

export const KNOWN_ACTORS = ["drew", "alice", "bob"] as const;
export type KnownActor = (typeof KNOWN_ACTORS)[number];
/**
 * Actor identity — any non-empty string. Known actors are
 * {@link KnownActor}s; custom actors are arbitrary user-supplied
 * strings (free-text input).
 */
export type ActorId = KnownActor | (string & {});

export function ActorPicker({
  value,
  onChange,
}: {
  value: ActorId;
  onChange: (actorId: ActorId) => void;
}) {
  // Local mirror of `value` for the free-text input so the user can
  // type without committing on every keystroke. Commit happens on
  // Enter or when the dropdown changes.
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep `draft` in sync if `value` changes externally (e.g., URL
  // param swap on a fresh load).
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const isKnown = KNOWN_ACTORS.includes(draft as (typeof KNOWN_ACTORS)[number]);
  const isDirty = draft !== value;

  return (
    <div className="flex items-center gap-2">
      <label className="font-mono text-xs text-stone-500">actor:</label>
      <select
        value={isKnown ? draft : "__custom__"}
        onChange={(e) => {
          const next = e.target.value;
          if (next === "__custom__") {
            // User picked "Custom..." — focus the text input.
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
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && isDirty) {
            e.preventDefault();
            onChange(draft);
          } else if (e.key === "Escape") {
            e.preventDefault();
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
