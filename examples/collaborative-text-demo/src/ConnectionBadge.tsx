/**
 * Connection-state badge — small indicator in the header that reflects
 * the SyncClient's current connection state.
 */

import { useEffect, useState } from "react";
import type { SyncClient } from "@ebbjs/client";

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

export function ConnectionBadge({ client }: { client: SyncClient }) {
  const [state, setState] = useState(client.state);

  useEffect(() => {
    const unsub = client.onStateChange((next) => setState(next));
    return unsub;
  }, [client]);

  return (
    <div className="flex items-center gap-2 font-mono text-xs">
      <span className={`h-2 w-2 rounded-full ${COLOR[state] ?? "bg-stone-500"}`} />
      <span className="text-stone-300">{LABEL[state] ?? state}</span>
    </div>
  );
}
