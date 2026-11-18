/**
 * The engine signal (#512): the replica's post-change notifications, fanned
 * out to derived readers.
 *
 * Every reader tracks its own last revision, so a slow React store cannot
 * make a fast accessor watcher skip a batch. A revision jump with no journal
 * entries is a journal gap — a replica `load` replaces the journal wholesale —
 * and the reader treats it as "everything may have changed".
 */

import { carriesComponent, carriesLink, systemValueString, type Entity } from "@ebbjs/core";
import type { Replica, ReplicaChange, Revision } from "@ebbjs/storage/replica";

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
 * The id an accessor change belongs to. A link is a key of its source row, so a
 * row carrying `ebb/link` is its own subject; a membership row names the member
 * entity it files.
 */
const accessorSubjectId = (entity: Entity): string | null => {
  if (carriesLink(entity)) return entity.id;
  if (!carriesComponent(entity, "membership")) return null;
  const id = systemValueString(entity, "membership", "entity_id");
  return id !== null && id.length > 0 ? id : null;
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
    // The ids a batch settles: every changed row, plus the accessor subject a
    // platform row names. A link's subject is the row that changed, so the two
    // sets overlap and one listener is notified once per id.
    const subjects = new Set<string>();
    for (const change of changes) {
      subjects.add(change.id);
      const row = replica.get(change.id);
      if (row === undefined) continue;
      const subject = accessorSubjectId(row);
      if (subject !== null) subjects.add(subject);
    }
    for (const id of subjects) {
      const listeners = new Set([
        ...(accessorListeners.get(id) ?? []),
        ...(entityListeners.get(id) ?? []),
      ]);
      if (listeners.size === 0) continue;
      const row = replica.get(id);
      for (const listener of listeners) listener(row);
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
