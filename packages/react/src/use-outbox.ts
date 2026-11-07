import type { OutboxSnapshot } from "@ebbjs/client";

import { useClient } from "./context";
import { useSyncObservable } from "./use-sync-observable";

/**
 * Subscribe a component to the write buffer: pending / acknowledged / error /
 * conflicted depth, the last flush latency, and the cumulative store faults.
 *
 * Backed by `client.sync.outbox`, which the client composes over the buffer
 * and the flush scheduler, so a flush reports its depth change and then its
 * latency without the component polling. This is the only signal that a
 * write is still local — render "Saving…" from `pending > 0` and "12 writes
 * queued, offline" from a nonzero depth while the connection is down.
 */
export function useOutbox(): OutboxSnapshot {
  const client = useClient();
  return useSyncObservable(client.sync.outbox);
}
