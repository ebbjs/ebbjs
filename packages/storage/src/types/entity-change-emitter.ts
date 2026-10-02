import type { Entity } from "@ebbjs/core";

/**
 * EntityChangeEmitter — observers fired by the storage adapter after
 * an entity is materialized, set, or otherwise arrives at the cache.
 *
 * The emitter lives alongside `EntityStore` rather than on it: the
 * store is a passive read/write API, and the observer surface is a
 * separate concern that not every adapter has to ship. Adapters that
 * don't implement the emitter can simply omit the field on the
 * composed `StorageAdapter`; consumer code that wants reactivity
 * must fall back to polling.
 *
 * ## Semantics
 * - `onEntityChange(id, listener)` — listener fires whenever the
 *   materialized entity at `id` changes (put, patch, materialize-on-
 *   dirty, or set). When the entity is deleted (a delete-Update
 *   materializes the entity with `deleted_hlc` set), the listener
 *   receives `null`. The listener never fires for a get() against
 *   an id that's not dirty (no materialization happens).
 * - `onTypeChange(type, listener)` — listener fires once per affected
 *   entity of `type` after a materialization sweep (query() or any
 *   batched dirty flush). The id is captured from the materialized
 *   entity.
 * - `reset()` — clears every listener; called by `EntityStore.reset()`
 *   so a teardown of the store also tears down subscribers.
 *
 * Listeners are isolated: a throwing listener does not prevent sibling
 * listeners from firing.
 */
export interface EntityChangeEmitter {
  /**
   * Subscribe to changes on a single entity id. Fires after the
   * entity is materialized (or with `null` if the entity was
   * deleted). The listener is not called for non-dirty reads.
   * Returns an unsubscribe function.
   */
  onEntityChange(id: string, listener: (entity: Entity | null) => void): () => void;

  /**
   * Subscribe to changes on any entity of a given type. Fires for
   * every entity of `type` that materializes (put/patch/delete),
   * once per id, after the materialization completes. Returns an
   * unsubscribe function.
   */
  onTypeChange(type: string, listener: (entity: Entity) => void): () => void;

  /** Clear every listener. */
  reset(): void;
}
