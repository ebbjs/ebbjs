import type { Action, Entity, Update } from "@ebbjs/core";

import { applyUpdate } from "../internal/materialize";
import { REPLICA_RECORD_FORMAT, isValidReplicaRecord } from "../internal/replica-record";
import type { ReplicaRecord } from "../types/replica-store";

import { contentChanged } from "./content-changed";
import type {
  MaterializationPolicy,
  Replica,
  ReplicaChange,
  ReplicaOptions,
  Revision,
} from "./types";

export const holdAll: MaterializationPolicy = {
  holds: () => true,
};

interface OptimisticWrite {
  readonly actionId: string;
  readonly update: Update;
  readonly hlc: string;
}

/**
 * An Update that arrived before any base row existed. The store reconciles by
 * replaying an entity's whole log in gsn order; an incremental core must keep
 * the Update explicitly so a later `put` can reconcile it (#475).
 */
interface OrphanUpdate {
  readonly update: Update;
  readonly gsn: number;
  readonly hlc: string;
  readonly position: number;
}

/**
 * Mutable in-place core. `entities` is the durable base (what `toRecord`
 * persists), `overlay` composes optimistic writes over it, and `effective`
 * caches the composed view for overlaid ids so a read never recomposes.
 * `typeIndex` indexes the base; `iterate` layers the overlay's type overrides
 * on top of it.
 */
export const createReplica = (options?: ReplicaOptions): Replica => {
  const policy = options?.materialization ?? holdAll;
  const holds = (type: string): boolean => policy.holds(type);

  const entities = new Map<string, Entity>();
  const typeIndex = new Map<string, Set<string>>();
  const overlay = new Map<string, OptimisticWrite[]>();
  const effective = new Map<string, Entity | null>();
  const orphans = new Map<string, OrphanUpdate[]>();
  const journal: ReplicaChange[] = [];

  let revision: Revision = 0;
  let lastPosition = 0;

  const addToType = (type: string, id: string): void => {
    const ids = typeIndex.get(type);
    if (ids === undefined) typeIndex.set(type, new Set([id]));
    else ids.add(id);
  };

  const removeFromType = (type: string, id: string): void => {
    const ids = typeIndex.get(type);
    if (ids === undefined) return;
    ids.delete(id);
    if (ids.size === 0) typeIndex.delete(type);
  };

  const bump = (id: string, type: string, deleted: boolean): void => {
    revision += 1;
    journal.push({ revision, id, type, deleted });
  };

  const viewOf = (id: string): Entity | null =>
    effective.has(id) ? (effective.get(id) ?? null) : (entities.get(id) ?? null);

  const get = (id: string): Entity | undefined => {
    if (effective.has(id)) return effective.get(id) ?? undefined;
    return entities.get(id);
  };

  const iterate = (type: string): readonly Entity[] => {
    const ids = new Set(typeIndex.get(type) ?? []);
    for (const [id, row] of effective) {
      if (row !== null && row.type === type) ids.add(id);
      else ids.delete(id);
    }
    const rows: Entity[] = [];
    for (const id of ids) {
      const row = get(id);
      if (row !== undefined) rows.push(row);
    }
    return rows;
  };

  const foldBase = (update: Update, gsn: number, hlc: string, position: number): void => {
    const id = update.subject_id;
    const previous = entities.get(id) ?? null;
    const next = applyUpdate(previous, update, gsn, hlc);

    if (next === null) {
      const orphan: OrphanUpdate = { update, gsn, hlc, position };
      const pending = orphans.get(id);
      if (pending === undefined) orphans.set(id, [orphan]);
      else pending.push(orphan);
      return;
    }

    if (!holds(next.type)) {
      // A not-held row is unobservable: it retains nothing and journals
      // nothing. Dropping a previously held row is still observable, and
      // `resync` journals that removal from the composed-view comparison.
      if (previous !== null) {
        entities.delete(id);
        removeFromType(previous.type, id);
      }
      if (update.method === "put") orphans.delete(id);
      return;
    }

    entities.set(id, next);
    if (previous !== null && previous.type !== next.type) removeFromType(previous.type, id);
    addToType(next.type, id);

    if (update.method === "put") {
      const pending = orphans.get(id);
      if (pending !== undefined) {
        orphans.delete(id);
        // Replay what the store's gsn-ordered replay would: only Updates newer
        // than the put survive; older ones are subsumed by the full put.
        const survivors = pending
          .filter((orphan) => orphan.gsn > gsn)
          .sort((a, b) => a.gsn - b.gsn);
        let row = next;
        for (const orphan of survivors) {
          row = applyUpdate(row, orphan.update, orphan.gsn, orphan.hlc) ?? row;
        }
        if (row !== next) {
          entities.set(id, row);
          if (next.type !== row.type) {
            removeFromType(next.type, id);
            addToType(row.type, id);
          }
        }
      }
    }
  };

  /**
   * Recompute the composed view after the base or overlay changed, bumping the
   * revision iff a reader can see the difference. `previous` is the composed
   * view captured before the change, which is what makes an echo of an
   * already-visible optimistic write a no-op for the revision.
   */
  const resync = (id: string, previous: Entity | null): void => {
    const base = entities.get(id) ?? null;
    const writes = overlay.get(id);
    let next = base;
    if (writes !== undefined) {
      for (const write of writes) next = applyUpdate(next, write.update, 0, write.hlc);
    }
    const retained = next !== null && holds(next.type) ? next : null;

    if (writes === undefined || writes.length === 0) effective.delete(id);
    else effective.set(id, retained);

    if (retained === null) {
      if (next !== null) bump(id, next.type, next.deleted_hlc !== null);
      else if (previous !== null) bump(id, previous.type, true);
      return;
    }
    if (contentChanged(previous, retained)) bump(id, retained.type, retained.deleted_hlc !== null);
  };

  const rememberView = (before: Map<string, Entity | null>, id: string): void => {
    if (!before.has(id)) before.set(id, viewOf(id));
  };

  /** Drop one action's overlay writes, capturing the pre-change views. */
  const dropOverlay = (actionId: string, before: Map<string, Entity | null>): string[] => {
    const affected: string[] = [];
    for (const [id, writes] of overlay) {
      if (!writes.some((write) => write.actionId === actionId)) continue;
      rememberView(before, id);
      affected.push(id);
    }
    for (const id of affected) {
      const writes = overlay.get(id) ?? [];
      const remaining = writes.filter((write) => write.actionId !== actionId);
      if (remaining.length === 0) overlay.delete(id);
      else overlay.set(id, remaining);
    }
    return affected;
  };

  const ingest = (action: Action, delta: readonly Update[], position: number): Revision => {
    const before = new Map<string, Entity | null>();
    for (const update of delta) rememberView(before, update.subject_id);

    // The echo of an optimistic Action now lives in the base; drop its overlay.
    const echoed = dropOverlay(action.id, before);

    for (const update of delta) foldBase(update, action.gsn, action.hlc, position);
    if (position > lastPosition) lastPosition = position;

    const touched = new Set<string>(delta.map((update) => update.subject_id));
    for (const id of echoed) touched.add(id);
    for (const id of touched) resync(id, before.get(id) ?? null);
    return revision;
  };

  const optimistic = (action: Action): Revision => {
    const before = new Map<string, Entity | null>();
    const touched = new Set<string>();
    for (const update of action.updates) {
      const id = update.subject_id;
      rememberView(before, id);
      touched.add(id);
      const write: OptimisticWrite = { actionId: action.id, update, hlc: action.hlc };
      const writes = overlay.get(id);
      if (writes === undefined) overlay.set(id, [write]);
      else writes.push(write);
    }
    for (const id of touched) resync(id, before.get(id) ?? null);
    return revision;
  };

  const discard = (actionId: string): Revision => {
    const before = new Map<string, Entity | null>();
    const affected = dropOverlay(actionId, before);
    for (const id of affected) resync(id, before.get(id) ?? null);
    return revision;
  };

  const load = (record: ReplicaRecord): Revision => {
    if (!isValidReplicaRecord(record)) return revision;
    entities.clear();
    typeIndex.clear();
    orphans.clear();
    overlay.clear();
    effective.clear();
    journal.length = 0;
    for (const entity of record.entities) {
      entities.set(entity.id, entity);
      addToType(entity.type, entity.id);
    }
    revision = record.revision;
    lastPosition = record.position;
    return revision;
  };

  const toRecord = (): ReplicaRecord => {
    let oldest = Number.POSITIVE_INFINITY;
    for (const pending of orphans.values()) {
      for (const orphan of pending) oldest = Math.min(oldest, orphan.position);
    }
    // A record omits an orphan (there is no base row), so the watermark must
    // not advance past it or hydrate would replay the tail only after the base.
    const position =
      oldest === Number.POSITIVE_INFINITY ? lastPosition : Math.min(lastPosition, oldest - 1);
    return {
      format: REPLICA_RECORD_FORMAT,
      position,
      revision,
      entities: [...entities.values()],
    };
  };

  return {
    get revision() {
      return revision;
    },
    get,
    iterate,
    changesSince: (from: Revision) => journal.filter((change) => change.revision > from),
    ingest,
    optimistic,
    discard,
    load,
    toRecord,
  };
};
