import type { ConflictSnapshot } from "@ebbjs/client";

import { useClient } from "./context";
import { useSyncObservable } from "./use-sync-observable";

/**
 * Subscribe a component to the conflicts awaiting an application decision:
 * the depth and the projected conflicts, oldest detection first.
 *
 * Backed by `client.sync.conflicts`, which republishes whenever the outbox's
 * counts change — a detection, a resolution, and the initial durable load all
 * arrive that way — so a held edit renders without a refetch. An unrelated
 * write can republish an equal snapshot, so a consumer may re-render without
 * its data changing. Read-only by design: resolving stays on `client.conflicts`
 * (`list()` then `sendLocalActions(id)` or `clearLocalActions(id)`), keeping
 * the decision and its durable write outside React's render pass.
 */
export function useConflicts(): ConflictSnapshot {
  const client = useClient();
  return useSyncObservable(client.sync.conflicts);
}
