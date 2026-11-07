import type { ClientStatus } from "@ebbjs/client";

import { useClient } from "./context";
import { useSyncObservable } from "./use-sync-observable";

/**
 * Subscribe a component to the aggregate sync state: connection phase,
 * `lastSyncedAt`, outbox snapshot, and conflict snapshot.
 *
 * Backed by `client.status`, which the client composes over those four
 * sources and keeps subscribed for its lifetime, so a status bar renders in
 * one hook instead of four. Prefer {@link useOutbox} / {@link useConflicts}
 * where only one slice is needed: the aggregate carries every slice, so any
 * change re-renders its consumer.
 */
export function useEbbStatus(): ClientStatus {
  const client = useClient();
  return useSyncObservable(client.status);
}
