/**
 * ClientStatus — the aggregate read-only view of the client's sync state
 * (#371), mounted as `client.status`.
 *
 * It composes the connection phase, the sibling `client.sync.outbox` and
 * `client.sync.conflicts` observables, and a `lastSyncedAt` wall-clock
 * timestamp, so a framework binding subscribes once instead of wiring
 * four sources. `get()` reads O(1) scalars and references the children's
 * cached snapshots; the composition holds one subscription per child for
 * the client's lifetime, so a consumer subscribing and unsubscribing
 * only touches the aggregate's own listener set.
 *
 * `lastSyncedAt` is stamped by {@link ClientStatusController.markSynced}
 * when a remote Action lands or a catch-up reaches the head; it is kept
 * off the read-only surface so a consumer cannot forge a sync time.
 */

import type { ConnectionState, ConnectionStateMachine } from "./connection-state";
import type { OutboxSnapshot } from "./outbox-observer";
import type { ConflictSnapshot } from "./conflicts";
import { createObservable, type ReadonlyObservable } from "./observable";

/**
 * The aggregate `client.status` snapshot. `lastSyncedAt` is the epoch-ms
 * wall time of the last applied remote Action or completed catch-up, or
 * `null` before the client has synced anything.
 */
export interface ClientStatus {
  readonly connection: ConnectionState;
  readonly lastSyncedAt: number | null;
  readonly outbox: OutboxSnapshot;
  readonly conflicts: ConflictSnapshot;
}

/** The read-only children the aggregate composes. */
export interface StatusDependencies {
  connection: ConnectionStateMachine;
  outbox: ReadonlyObservable<OutboxSnapshot>;
  conflicts: ReadonlyObservable<ConflictSnapshot>;
  /** Wall clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** The aggregate observable plus the client-only write side. */
export interface ClientStatusController {
  readonly status: ReadonlyObservable<ClientStatus>;
  /**
   * Record that the client synced: a remote Action landed or a catch-up
   * completed. No-op when the timestamp would not advance.
   */
  markSynced(at?: number): void;
}

/**
 * Build the aggregate over its live children. Subscriptions to the
 * children are held for the lifetime of the controller, which the client
 * owns for the lifetime of the client.
 */
export function createClientStatus(deps: StatusDependencies): ClientStatusController {
  const now = deps.now ?? Date.now;
  const lastSyncedAt = createObservable<number | null>(null);

  const read = (): ClientStatus => ({
    connection: deps.connection.state,
    lastSyncedAt: lastSyncedAt.get(),
    outbox: deps.outbox.get(),
    conflicts: deps.conflicts.get(),
  });

  const status = createObservable<ClientStatus>(read());

  /**
   * Re-read the children and publish only a real change. The children
   * keep a stable identity between changes, so reference equality drops
   * the connection machine's deferred replay of the current state and
   * keeps `get()` identity stable for `useSyncExternalStore`.
   */
  const refresh = (): void => {
    const next = read();
    const current = status.get();
    if (
      current.connection === next.connection &&
      current.lastSyncedAt === next.lastSyncedAt &&
      current.outbox === next.outbox &&
      current.conflicts === next.conflicts
    ) {
      return;
    }
    status.set(next);
  };

  deps.connection.onChange(refresh);
  deps.outbox.subscribe(refresh);
  deps.conflicts.subscribe(refresh);
  lastSyncedAt.subscribe(refresh);

  return {
    status,
    markSynced: (at = now()) => {
      const current = lastSyncedAt.get();
      if (current !== null && at <= current) return;
      lastSyncedAt.set(at);
    },
  };
}
