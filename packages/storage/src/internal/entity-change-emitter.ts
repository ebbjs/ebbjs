import type { Entity } from "@ebbjs/core";
import type { EntityChangeEmitter } from "../types/entity-change-emitter";
import { accessorAffectedBy } from "./reverse-index";

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
  const byId = new Map<string, Set<(entity: Entity | null) => void>>();
  const byType = new Map<string, Set<(entity: Entity) => void>>();
  const byAccessorId = new Map<string, Set<() => void>>();

  const fireId = (id: string, entity: Entity | null): void => {
    const listeners = byId.get(id);
    if (listeners === undefined) return;
    for (const cb of listeners) {
      try {
        cb(entity);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[EntityChangeEmitter] onEntityChange handler threw:", err);
      }
    }
  };

  const fireTypeName = (type: string, entity: Entity): void => {
    const listeners = byType.get(type);
    if (listeners === undefined) return;
    for (const cb of listeners) {
      try {
        cb(entity);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[EntityChangeEmitter] onTypeChange handler threw:", err);
      }
    }
  };

  const fireAccessor = (id: string): void => {
    const listeners = byAccessorId.get(id);
    if (listeners === undefined) return;
    for (const cb of listeners) {
      try {
        cb();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[EntityChangeEmitter] onAccessorChange handler threw:", err);
      }
    }
  };

  const emit = (id: string, entity: Entity): void => {
    fireId(id, entity);
    fireTypeName(entity.type, entity);
    // A relationship / membership row changes the accessors of another
    // entity without touching that entity's own fields: wake its
    // accessor subscribers and re-fire its type so relationship /
    // membership-filtered queries re-materialize.
    const affected = accessorAffectedBy(entity);
    if (affected !== null) {
      fireAccessor(affected.entityId);
      if (affected.entityType !== null) fireTypeName(affected.entityType, entity);
    }
  };

  const emitter: EntityChangeEmitter = {
    onEntityChange(id, listener) {
      let bucket = byId.get(id);
      if (bucket === undefined) {
        bucket = new Set();
        byId.set(id, bucket);
      }
      bucket.add(listener);
      return () => {
        bucket?.delete(listener);
      };
    },
    onTypeChange(type, listener) {
      let bucket = byType.get(type);
      if (bucket === undefined) {
        bucket = new Set();
        byType.set(type, bucket);
      }
      bucket.add(listener);
      return () => {
        bucket?.delete(listener);
      };
    },
    onAccessorChange(id, listener) {
      let bucket = byAccessorId.get(id);
      if (bucket === undefined) {
        bucket = new Set();
        byAccessorId.set(id, bucket);
      }
      bucket.add(listener);
      return () => {
        bucket?.delete(listener);
      };
    },
    reset() {
      byId.clear();
      byType.clear();
      byAccessorId.clear();
    },
  };

  return { emitter, emit };
};
