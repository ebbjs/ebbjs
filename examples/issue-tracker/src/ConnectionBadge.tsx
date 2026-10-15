/**
 * Connection-state badge. Reads `useConnection()` from the surrounding
 * `EbbProvider`, so it re-renders on state transitions only.
 */

import { useConnection } from "@ebbjs/react";

const COLOR: Record<string, string> = {
  connecting: "bg-amber-500",
  live: "bg-emerald-500",
  reconnecting: "bg-amber-500",
  offline: "bg-red-500",
};

const LABEL: Record<string, string> = {
  connecting: "connecting",
  live: "live",
  reconnecting: "reconnecting",
  offline: "offline",
};

export function ConnectionBadge() {
  const state = useConnection();

  return (
    <div className="flex items-center gap-2 font-mono text-xs">
      <span className={`h-2 w-2 rounded-full ${COLOR[state] ?? "bg-stone-500"}`} />
      <span className="text-stone-300">{LABEL[state] ?? state}</span>
    </div>
  );
}
