import type { Entity } from "@ebbjs/core";
import type { EntityChangeEmitter } from "../types/entity-change-emitter";
import { accessorAffectedEntityId } from "./reverse-index";

/**
 * One keyed listener registry. The three emitter channels differ only in
 * their listener signature, so they share this registry instead of
 * repeating the get-or-create / add / delete / fan-out shape.
 */
const createFanOut = <T>(label: string) => {
  const buckets = new Map<string, Set<T>>();

  return {
    subscribe(key: string, listener: T): () => void {
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = new Set();
        buckets.set(key, bucket);
      }
      bucket.add(listener);
      return () => {
        bucket?.delete(listener);
      };
    },
    fire(key: string, notify: (listener: T) => void): void {
      const bucket = buckets.get(key);
      if (bucket === undefined) return;
      for (const listener of bucket) {
        try {
          notify(listener);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[EntityChangeEmitter] ${label} handler threw:`, err);
        }
      }
    },
    clear(): void {
      buckets.clear();
    },
  };
};

/**
 * EntityChangeEmitter factory — the observer fan-out shared by the
 * memory and IndexedDB adapters so subscribe semantics stay
 * uniform across backends. Returns the public emitter plus an
 * internal `emit` the entity store calls on materialize/set; the
 * `emit` is deliberately not on the emitter interface so external
 * code can't fan out without going through the store.
 */
export const createEntityChangeEmitter = (): {
  emitter: EntityChangeEmitter;
  emit: (id: string, entity: Entity) => void;
} => {
  const entityListeners = createFanOut<(entity: Entity | null) => void>("onEntityChange");
  const typeListeners = createFanOut<(entity: Entity) => void>("onTypeChange");
  const accessorListeners = createFanOut<() => void>("onAccessorChange");

  const emit = (id: string, entity: Entity): void => {
    entityListeners.fire(id, (cb) => cb(entity));
    typeListeners.fire(entity.type, (cb) => cb(entity));
    // A relationship / membership row changes the accessors of another
    // entity without touching that entity's own fields: wake its
    // accessor subscribers. The row-type fire above (`relationship` /
    // `entityGroup`) is what wakes relationship- and membership-filtered
    // queries; the affected entity's own type is not guessed here because
    // membership rows don't name it and a relationship `type` is
    // overridable.
    const affectedId = accessorAffectedEntityId(entity);
    if (affectedId !== null) accessorListeners.fire(affectedId, (cb) => cb());
  };

  const emitter: EntityChangeEmitter = {
    onEntityChange: (id, listener) => entityListeners.subscribe(id, listener),
    onTypeChange: (type, listener) => typeListeners.subscribe(type, listener),
    onAccessorChange: (id, listener) => accessorListeners.subscribe(id, listener),
    reset(): void {
      entityListeners.clear();
      typeListeners.clear();
      accessorListeners.clear();
    },
  };

  return { emitter, emit };
};
