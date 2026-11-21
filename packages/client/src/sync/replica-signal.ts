/**
 * The engine signal (#512): the replica's post-change notifications, fanned
 * out to derived readers.
 *
 * Every reader tracks its own last revision, so a slow React store cannot
 * make a fast accessor watcher skip a batch. A revision jump with no journal
 * entries is a journal gap — a replica `load` replaces the journal wholesale —
 * and the reader treats it as "everything may have changed".
 *
 * Dispatch for query and row subscriptions lives in the registry (#937); this
 * module keeps the raw fan-out for callers that only want the batches, and the
 * row-subscription facade the row namespace mounts on the registry.
 */

import type { Entity } from "@ebbjs/core";
import type { Replica, ReplicaChange, Revision } from "@ebbjs/storage/replica";

import type { SubscriptionRegistry } from "./subscriptions";

/** One derived reader's view of the replica's change stream. */
export interface ReplicaSignal {
  /** Changes since this subscriber's previous callback, plus the new revision. */
  subscribe(listener: (changes: readonly ReplicaChange[], revision: Revision) => void): () => void;
}

/**
 * Fan the replica's post-change notification out to derived readers, each
 * tracking its own last revision. The replica fires once per mutating call
 * with the view settled, so a batch is read here, never mid-fold.
 */
export const createReplicaSignal = (replica: Replica): ReplicaSignal => ({
  subscribe(listener) {
    let last = replica.revision;
    return replica.subscribe(() => {
      const revision = replica.revision;
      if (revision === last) return;
      const changes = replica.changesSince(last);
      last = revision;
      listener(changes, revision);
    });
  },
});

/** Per-id observers for the row-level reactive surface (`get(id)`). */
export interface EntityWatcher {
  /** The row at `id` after a change, or `undefined` when it left the replica. */
  entity(id: string, listener: (entity: Entity | undefined) => void): () => void;
  /** Fires with the settled row when an edge/group row changes its accessors. */
  accessors(id: string, listener: (entity: Entity | undefined) => void): () => void;
}

/**
 * The row-level watcher over the shared registry. One registry row entry per
 * watched id: a `row.subscribe` and a `subscribeAccessors` on the same row
 * share it, so the row's components are claimed once, and the entry's own
 * dependency set is what keeps them resident until the last listener leaves.
 */
export const createEntityWatcher = (
  replica: Replica,
  subscriptions: SubscriptionRegistry,
): EntityWatcher => {
  const watch = (id: string, listener: (entity: Entity | undefined) => void): (() => void) => {
    const subscription = subscriptions.open({ kind: "row", row: id });
    const detach = subscription.onChange(() => listener(replica.get(id)));
    return () => {
      detach();
      subscription.release();
    };
  };
  return {
    entity: (id, listener) => watch(id, listener),
    accessors: (id, listener) => watch(id, listener),
  };
};
