/**
 * The engine signal (#512): the replica's post-change notifications, fanned
 * out to derived readers.
 *
 * Every reader tracks its own last revision, so a slow React store cannot
 * make a fast accessor watcher skip a batch. A revision jump with no journal
 * entries is a journal gap — a replica `load` replaces the journal wholesale —
 * and the reader treats it as "everything may have changed".
 */

import type { Entity } from "@ebbjs/core";
import type { Replica, ReplicaChange, Revision } from "@ebbjs/storage/replica";

import { entityGroupSystemEntity, relationshipSystemEntity } from "../schema/system-entities";

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

/** The field a relationship / membership row names as its accessor subject. */
const accessorSubjectField = (type: string): string | null => {
  if (type === relationshipSystemEntity.name) return "source_id";
  if (type === entityGroupSystemEntity.name) return "entity_id";
  return null;
};

/** Read a leaf string field; envelopes are not part of the accessor subject. */
const stringField = (entity: Entity, field: string): string | null => {
  const entry = entity.data?.fields?.[field];
  if (entry === undefined || !("value" in entry)) return null;
  return typeof entry.value === "string" && entry.value.length > 0 ? entry.value : null;
};

const addListener = <T>(map: Map<string, Set<T>>, id: string, listener: T): void => {
  const bucket = map.get(id);
  if (bucket === undefined) map.set(id, new Set([listener]));
  else bucket.add(listener);
};

const removeListener = <T>(map: Map<string, Set<T>>, id: string, listener: T): void => {
  const bucket = map.get(id);
  if (bucket === undefined) return;
  bucket.delete(listener);
  if (bucket.size === 0) map.delete(id);
};

/**
 * Build the row-level watcher over the shared signal. One signal subscription
 * serves every mounted row; a batch reads each touched row once and notifies
 * the row's listeners with the settled entity.
 */
export const createEntityWatcher = (replica: Replica, signal: ReplicaSignal): EntityWatcher => {
  const entityListeners = new Map<string, Set<(entity: Entity | undefined) => void>>();
  const accessorListeners = new Map<string, Set<(entity: Entity | undefined) => void>>();
  let detach: (() => void) | null = null;

  const dispatch = (changes: readonly ReplicaChange[]): void => {
    const touched = new Set<string>();
    for (const change of changes) {
      touched.add(change.id);
      const row = replica.get(change.id);
      if (row === undefined) continue;
      const field = accessorSubjectField(row.type);
      if (field === null) continue;
      const subject = stringField(row, field);
      if (subject === null) continue;
      const subjectRow = replica.get(subject);
      const accessorBucket = Array.from(accessorListeners.get(subject) ?? []);
      for (const listener of accessorBucket) listener(subjectRow);
    }
    for (const id of touched) {
      const listeners = entityListeners.get(id);
      if (listeners === undefined) continue;
      const row = replica.get(id);
      const bucket = Array.from(listeners);
      for (const listener of bucket) listener(row);
    }
  };

  const subscribe = (): void => {
    detach ??= signal.subscribe((changes) => dispatch(changes));
  };

  const release = (): void => {
    if (entityListeners.size > 0 || accessorListeners.size > 0) return;
    detach?.();
    detach = null;
  };

  return {
    entity(id, listener) {
      addListener(entityListeners, id, listener);
      subscribe();
      return () => {
        removeListener(entityListeners, id, listener);
        release();
      };
    },
    accessors(id, listener) {
      addListener(accessorListeners, id, listener);
      subscribe();
      return () => {
        removeListener(accessorListeners, id, listener);
        release();
      };
    },
  };
};
