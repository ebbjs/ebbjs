/**
 * THROWAWAY ARCHITECTURE PROTOTYPE — the read-model / durability seam (ebbjs#496).
 *
 * This is a logic/architecture prototype, not a UI one. It is the concrete
 * resident read model the local query engine (#495) will be built on, plus the
 * durable port behind it. It is deliberately under-polished and lives on a
 * throwaway branch; main keeps only the decision recorded on #496.
 *
 * Design position this file embodies and tests:
 *   - The query engine is the deep module; the read model is a CONCRETE CORE,
 *     not a pluggable port.
 *   - The pluggable seam is behind it, at durability:
 *     ActionLog / SnapshotStore / CursorStore / OutboxStore.
 *   - The read model subsumes EntityStore + DirtyTracker. Hydrate = load the
 *     latest snapshot + replay the log tail. Nothing materializes per entity
 *     on a read.
 *
 * Chosen shape: (B) mutable store + monotonic version + change journal, with
 * (A)'s immutable versioned handle as the public read token and (C)'s index
 * registry left as an internal extension point. `apply` returns the SAME handle
 * reference when no observable content changed, which is the #496 structural-
 * sharing acceptance test; the mutable core keeps the write path O(1).
 *
 * The normative merge is `applyUpdate` / `mergeFields` from
 * `storage/src/internal/materialize.ts`, used verbatim for BOTH provenances.
 * This module never re-implements LWW.
 */

import type { Action, Entity, FieldValue, Update } from "@ebbjs/core";
import { isFieldMap } from "@ebbjs/core";
import { applyUpdate } from "../../storage/src/internal/materialize";

export type EntityId = string;
export type EntityType = string;
export type Version = number;

/** One observable entity change, appended to the version journal. */
export interface EntityChange {
  readonly version: Version;
  readonly id: EntityId;
  readonly type: EntityType;
  readonly deleted: boolean;
}

/**
 * The public read token. Reference identity IS the invalidation signal:
 * `apply` returns the same handle when an Update left observable content
 * unchanged, and a new handle when it changed. Reads reflect the live model
 * (rows are not copied and must not be mutated) — this is a change token plus
 * a read view, not an MVCC snapshot.
 */
export interface ReadModelHandle {
  readonly version: Version;
  /** Base ⊕ optimistic overlay. Tombstones are returned. */
  get(id: EntityId): Entity | null;
  /** All rows of a type, tombstones included (matches EntityStore.query). */
  iterate(type: EntityType): readonly Entity[];
  /** Observable changes with a version strictly greater than `version`. */
  changesSince(version: Version): readonly EntityChange[];
}

/** Serializable resident state. Row-shaped, because IndexedDB can only persist rows. */
export interface ReadModelSnapshot {
  readonly formatVersion: 1;
  /**
   * Max log position folded into `entities`; the hydrate replay point.
   *
   * This is the log's append-order cursor, NOT the server gsn. gsn is neither
   * unique (#473 delivers one Action once per group) nor guaranteed non-zero
   * (#475 backfill, legacy entries), so a `gsn > watermark` replay is not a
   * total cursor; an append-order position covers every logged Action once.
   */
  readonly position: number;
  /** Local version counter, so a reloaded model does not restart the journal. */
  readonly version: Version;
  readonly entities: readonly Entity[];
}

export interface ApplyContext {
  /** 0 for an optimistic local write; the server gsn for a durable one. */
  readonly gsn: number;
  readonly hlc: string;
}

export interface ReadModel extends ReadModelHandle {
  /** The current version handle (same reference `ingest`/`optimistic` return until content changes). */
  handle(): ReadModelHandle;
  /** Durable provenance: fold an action's Updates into the base. Append is the port's job. */
  ingest(action: Action, position: number): ReadModelHandle;
  /** Optimistic provenance: fold into the overlay only; never the base, never the log. */
  optimistic(action: Action): ReadModelHandle;
  /** Drop one optimistic action's writes (echo convergence or conflict resolution). */
  discard(actionId: string): ReadModelHandle;
  /** Load a snapshot into the base. Hydrate then replays the tail via `ingest`. */
  loadSnapshot(snapshot: ReadModelSnapshot): ReadModelHandle;
  toSnapshot(): ReadModelSnapshot;
}

// ---------------------------------------------------------------------------
// Observable-content equality.
//
// `applyUpdate` always returns a new entity object, even when a lower-HLC
// patch is ignored (it still bumps `last_gsn`). Version bumps must track
// *observable* content only, so we compare the fields structurally with a
// reference fast path: the normative merge returns the existing FieldValue
// when the incoming one loses, so untouched leaves compare by reference.
// `last_gsn` is delivery bookkeeping, deliberately excluded.
// ---------------------------------------------------------------------------

const fieldValueEqual = (a: FieldValue, b: FieldValue): boolean => {
  if (a === b) return true;
  const aMap = isFieldMap(a);
  const bMap = isFieldMap(b);
  if (aMap !== bMap) return false;
  if (!aMap || !bMap) return false; // two distinct leaves
  const aKeys = Object.keys(a.map);
  const bKeys = Object.keys(b.map);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const other = b.map[key];
    if (other === undefined || !fieldValueEqual(a.map[key]!, other)) return false;
  }
  return true;
};

const fieldsEqual = (
  a: Readonly<Record<string, FieldValue>>,
  b: Readonly<Record<string, FieldValue>>,
): boolean => {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    const other = b[key];
    if (other === undefined || !fieldValueEqual(a[key]!, other)) return false;
  }
  return true;
};

/** True when `next` differs from `prev` in anything a reader can observe. */
export const contentChanged = (prev: Entity | null, next: Entity | null): boolean => {
  if (prev === null || next === null) return prev !== next;
  if (prev.type !== next.type) return true;
  if (prev.updated_hlc !== next.updated_hlc) return true;
  if (prev.deleted_hlc !== next.deleted_hlc) return true;
  return !fieldsEqual(prev.data.fields, next.data.fields);
};

// ---------------------------------------------------------------------------
// The concrete core.
// ---------------------------------------------------------------------------

interface OptimisticWrite {
  readonly actionId: string;
  readonly update: Update;
  readonly hlc: string;
}

/**
 * An Update that arrived before any base row existed. The store's per-entity
 * gsn-ordered replay keeps it implicitly (replay re-reads the whole log); an
 * incremental model must keep it explicitly so a later `put` — a backfill
 * snapshot, or the real base finally delivered — can reconcile it (#475).
 */
interface OrphanUpdate {
  readonly update: Update;
  readonly gsn: number;
  readonly hlc: string;
  readonly position: number;
}

export const createReadModel = (): ReadModel => {
  const entities = new Map<EntityId, Entity>();
  const typeIndex = new Map<EntityType, Set<EntityId>>();
  const overlay = new Map<EntityId, OptimisticWrite[]>();
  /** Updates that arrived before any base row; replayed when a `put` seeds one. */
  const orphans = new Map<EntityId, OrphanUpdate[]>();
  /** Composed base ⊕ overlay row; absent means "fall through to base". */
  const effective = new Map<EntityId, Entity>();
  const journal: EntityChange[] = [];
  let version = 0;
  let lastPosition = 0;

  const get = (id: EntityId): Entity | null => effective.get(id) ?? entities.get(id) ?? null;

  const iterate = (type: EntityType): readonly Entity[] => {
    const ids = new Set(typeIndex.get(type) ?? []);
    for (const [id, row] of effective) {
      if (row.type === type) ids.add(id);
      else ids.delete(id);
    }
    const out: Entity[] = [];
    for (const id of ids) {
      const row = get(id);
      if (row !== null) out.push(row);
    }
    return out;
  };

  // The handle object is the structural-sharing unit: recreated on a content
  // change, reused otherwise. Reads close over the live maps.
  const makeHandle = (): ReadModelHandle => ({
    version,
    get,
    iterate,
    changesSince: (from: number) => journal.filter((change) => change.version > from),
  });
  let handle: ReadModelHandle = makeHandle();

  const addToType = (type: EntityType, id: EntityId): void => {
    const set = typeIndex.get(type);
    if (set === undefined) typeIndex.set(type, new Set([id]));
    else set.add(id);
  };

  const removeFromType = (type: EntityType, id: EntityId): void => {
    const set = typeIndex.get(type);
    if (set === undefined) return;
    set.delete(id);
    if (set.size === 0) typeIndex.delete(type);
  };

  const bump = (id: EntityId, type: EntityType, deleted: boolean): void => {
    version += 1;
    journal.push({ version, id, type, deleted });
    handle = makeHandle();
  };

  const foldBase = (update: Update, ctx: ApplyContext, position: number): boolean => {
    const id = update.subject_id;
    const previous = entities.get(id) ?? null;
    const next = applyUpdate(previous, update, ctx.gsn, ctx.hlc);
    if (next === null) {
      // A patch/delete with no base: retain it so a later base can reconcile it.
      const pending = orphans.get(id) ?? [];
      pending.push({ update, gsn: ctx.gsn, hlc: ctx.hlc, position });
      orphans.set(id, pending);
      return false;
    }
    entities.set(id, next);
    if (previous !== null && previous.type !== next.type) removeFromType(previous.type, id);
    addToType(next.type, id);
    let changed = contentChanged(previous, next);

    // A `put` is a base. Replay the Updates that arrived before it, exactly as
    // the store's gsn-ordered replay would: only orphans with a gsn *greater*
    // than the put's survive (older ones were no-ops before it, and the
    // full-replacement put supersedes them). The fetched snapshot may already
    // include a survivor's effect; re-applying is idempotent under LWW when it
    // does, and preserves the newer in-flight write when it does not.
    if (update.method === "put") {
      const pending = orphans.get(id);
      if (pending !== undefined) {
        orphans.delete(id);
        const survivors = pending
          .filter((orphan) => orphan.gsn > ctx.gsn)
          .sort((a, b) => a.gsn - b.gsn);
        let row: Entity | null = next;
        for (const orphan of survivors) {
          row = applyUpdate(row, orphan.update, orphan.gsn, orphan.hlc);
        }
        if (row !== null) {
          entities.set(id, row);
          if (next.type !== row.type) {
            removeFromType(next.type, id);
            addToType(row.type, id);
          }
          changed = contentChanged(next, row) || changed;
        }
      }
    }
    return changed;
  };

  /** Recompute one entity's composed row after an overlay edit. */
  const recompose = (id: EntityId): void => {
    const base = entities.get(id) ?? null;
    const writes = overlay.get(id);
    if (writes === undefined || writes.length === 0) {
      overlay.delete(id);
      const previous = effective.get(id);
      effective.delete(id);
      if (previous !== undefined && contentChanged(previous, base)) {
        bump(id, base?.type ?? previous.type, base === null || base.deleted_hlc !== null);
      }
      return;
    }
    let row: Entity | null = base;
    for (const write of writes) row = applyUpdate(row, write.update, 0, write.hlc);
    const previous = effective.has(id) ? effective.get(id)! : base;
    if (row === null) {
      effective.delete(id);
      if (contentChanged(previous, null)) bump(id, previous?.type ?? base?.type ?? "?", true);
      return;
    }
    effective.set(id, row);
    if (contentChanged(previous, row)) bump(id, row.type, row.deleted_hlc !== null);
  };

  const model: ReadModel = {
    get version() {
      return version;
    },
    handle: () => handle,
    get,
    iterate,
    changesSince: (from: number) => journal.filter((change) => change.version > from),

    ingest(action: Action, position: number): ReadModelHandle {
      const touched: EntityId[] = [];
      for (const update of action.updates) {
        const id = update.subject_id;
        touched.push(id);
        if (foldBase(update, { gsn: action.gsn, hlc: action.hlc }, position)) {
          const row = entities.get(id);
          if (row !== null) bump(row.id, row.type, row.deleted_hlc !== null);
        }
      }
      lastPosition = Math.max(lastPosition, position);
      // The echo carries the optimistic action's id: its overlay writes are now
      // in the base, so drop them. Recomposition is a no-op when they agreed.
      model.discard(action.id);
      // Any other overlay on a touched id now sits over a new base.
      for (const id of touched) {
        if (overlay.has(id)) recompose(id);
      }
      return handle;
    },

    optimistic(action: Action): ReadModelHandle {
      for (const update of action.updates) {
        const id = update.subject_id;
        const writes = overlay.get(id) ?? [];
        writes.push({ actionId: action.id, update, hlc: action.hlc });
        overlay.set(id, writes);
        recompose(id);
      }
      return handle;
    },

    discard(actionId: string): ReadModelHandle {
      for (const id of Array.from(overlay.keys())) {
        const writes = overlay.get(id);
        if (writes === undefined) continue;
        const remaining = writes.filter((write) => write.actionId !== actionId);
        if (remaining.length === writes.length) continue;
        if (remaining.length === 0) overlay.delete(id);
        else overlay.set(id, remaining);
        recompose(id);
      }
      return handle;
    },

    loadSnapshot(snapshot: ReadModelSnapshot): ReadModelHandle {
      entities.clear();
      typeIndex.clear();
      orphans.clear();
      for (const entity of snapshot.entities) {
        entities.set(entity.id, entity);
        addToType(entity.type, entity.id);
      }
      version = snapshot.version;
      lastPosition = snapshot.position;
      handle = makeHandle();
      return handle;
    },

    toSnapshot(): ReadModelSnapshot {
      // Never advance the watermark past an orphan: a snapshot omits the orphan
      // (there is no base row for it), so hydrating from it would lose the
      // Update before its base arrives. Cap at the oldest orphan's position.
      let oldest = Number.POSITIVE_INFINITY;
      for (const pending of orphans.values()) {
        for (const orphan of pending) oldest = Math.min(oldest, orphan.position);
      }
      const position =
        oldest === Number.POSITIVE_INFINITY ? lastPosition : Math.min(lastPosition, oldest - 1);
      return {
        formatVersion: 1,
        position,
        version,
        entities: [...entities.values()],
      };
    },
  };

  return model;
};

// ---------------------------------------------------------------------------
// The durable port behind the read model.
// ---------------------------------------------------------------------------

/**
 * Append-only action log. `append` returns the new Action's log position; the
 * position is the log's own monotonic append-order cursor, independent of the
 * server gsn (which is neither unique nor always non-zero).
 * `readTail` returns every Action with position > `afterPosition`, in order.
 * `getForEntity` / `getAll` are gone: the read model buffers an Update that
 * arrives before its base and reconciles it when the base lands, so nothing
 * replays per entity. The snapshot watermark must not advance past an orphan
 * (`toSnapshot` caps it), which is the one remaining ordering obligation.
 */
export interface LoggedAction {
  readonly action: Action;
  readonly position: number;
}

export interface ActionLogPort {
  append(action: Action): Promise<LoggedAction>;
  readTail(afterPosition: number): Promise<readonly LoggedAction[]>;
  lastPosition(): Promise<number>;
  clear(): Promise<void>;
}

export interface SnapshotStorePort {
  load(): Promise<ReadModelSnapshot | null>;
  save(snapshot: ReadModelSnapshot): Promise<void>;
  clear(): Promise<void>;
}

export interface CursorStorePort {
  get(groupId: string): Promise<number | null>;
  set(groupId: string, gsn: number): Promise<void>;
}

/** Re-exported for the seam definition; the surface stays `storage/types`. */
export interface OutboxPort {
  list(): Promise<readonly { readonly action: Action; readonly status: string }[]>;
}

export interface DurableStore {
  readonly actions: ActionLogPort;
  readonly snapshots: SnapshotStorePort;
  readonly cursors: CursorStorePort;
  readonly outbox: OutboxPort;
}

// ---------------------------------------------------------------------------
// One apply pipeline, two provenances.
// ---------------------------------------------------------------------------

/** Durable: append to the log first, then fold into the base. */
export const ingestDurable = async (
  model: ReadModel,
  store: DurableStore,
  action: Action,
  groupId?: string,
): Promise<ReadModelHandle> => {
  const entry = await store.actions.append(action);
  if (groupId !== undefined && action.gsn > 0) {
    const previous = await store.cursors.get(groupId);
    if (previous === null || action.gsn > previous) await store.cursors.set(groupId, action.gsn);
  }
  return model.ingest(entry.action, entry.position);
};

/** Optimistic: fold into the overlay only. The caller has already buffered the outbox row. */
export const applyOptimistic = (model: ReadModel, action: Action): ReadModelHandle =>
  model.optimistic(action);

/**
 * Hydrate = latest snapshot + log tail + the durable outbox projection.
 * The outbox is the source of optimistic state across a reload; its
 * `pending` / `acknowledged` rows replay into the overlay.
 */
export const hydrate = async (model: ReadModel, store: DurableStore): Promise<ReadModel> => {
  const snapshot = await store.snapshots.load();
  if (snapshot !== null) model.loadSnapshot(snapshot);
  const after = snapshot?.position ?? 0;
  for (const entry of await store.actions.readTail(after)) {
    model.ingest(entry.action, entry.position);
  }
  for (const entry of await store.outbox.list()) {
    if (entry.status === "pending" || entry.status === "acknowledged")
      model.optimistic(entry.action);
  }
  return model;
};
