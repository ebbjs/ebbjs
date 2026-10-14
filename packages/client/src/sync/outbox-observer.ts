/**
 * OutboxObserver — the read-only, subscribable view of the write
 * buffer's depth and the flush scheduler's most recent latency.
 *
 * The Outbox owns entry lifecycle and the FlushScheduler owns timing;
 * neither should grow a "how a UI reads me" concern. This module is the
 * composition seam: it subscribes to both change streams and folds them
 * into one snapshot, exposed as `client.sync.outbox` (#369).
 *
 * The snapshot is cached and its identity is stable between changes, so
 * `get()` is safe to hand to React's `useSyncExternalStore` — a fresh
 * object on every read would re-render forever.
 */

import type { Outbox, OutboxCounts } from "./outbox";
import { createObservable, type ReadonlyObservable } from "./observable";

/**
 * The current read-only view of the write buffer and flush timing.
 * `OutboxCounts` supplies the per-status depths.
 */
export interface OutboxSnapshot extends OutboxCounts {
  /** Wall time of the most recent resolved flush, or `null` before one. */
  readonly flushLatency: number | null;
  /** Cumulative durable store faults the buffer has reported. */
  readonly storeFaults: number;
}

/** Fired with the new snapshot whenever depth or latency changes. */
export type OutboxSnapshotListener = (snapshot: OutboxSnapshot) => void;

/** The read-only observable exposed as `client.sync.outbox`. */
export type OutboxObserver = ReadonlyObservable<OutboxSnapshot>;

/** Collaborators the observer composes. Both are read-only seams. */
export interface OutboxObserverDependencies {
  /** Depth source: the write buffer's counts and change stream. */
  outbox: Pick<Outbox, "counts" | "onChange" | "storeFaults" | "onStoreFault">;
  /** Latency source: the scheduler's most recent flush time. */
  flushLatency: () => number | null;
  /** The latency source's change stream. */
  onFlushLatency: (listener: (latency: number) => void) => () => void;
}

/**
 * Compose an {@link OutboxObserver} over its depth and latency sources.
 * The observer re-reads both sources on any change and keeps both
 * subscriptions for its lifetime — the client owns it for the client's
 * lifetime — so it never polls. A flush is reported up to twice: the
 * Outbox fires when its counts transition, then the scheduler fires when
 * it stamps the latency (unknown until the flush resolves). `get()`
 * reflects the latest of both at each point.
 */
export function createOutboxObserver(deps: OutboxObserverDependencies): OutboxObserver {
  const readSnapshot = (): OutboxSnapshot => {
    const counts: OutboxCounts = deps.outbox.counts();
    return {
      ...counts,
      flushLatency: deps.flushLatency(),
      storeFaults: deps.outbox.storeFaults(),
    };
  };

  const observable = createObservable<OutboxSnapshot>(readSnapshot());

  // Re-read both sources on any change. A flush reports its counts first
  // (the Outbox transition) and its latency second (the scheduler stamps
  // it once the flush resolves); a source event that leaves the snapshot
  // unchanged is dropped, so `get()` identity is stable between changes.
  const refresh = (): void => {
    const next = readSnapshot();
    const current = observable.get();
    if (
      next.pending === current.pending &&
      next.acknowledged === current.acknowledged &&
      next.error === current.error &&
      next.conflicted === current.conflicted &&
      next.flushLatency === current.flushLatency &&
      next.storeFaults === current.storeFaults
    ) {
      return;
    }
    observable.set(next);
  };

  deps.outbox.onChange(refresh);
  deps.outbox.onStoreFault(refresh);
  deps.onFlushLatency(refresh);

  return observable;
}
