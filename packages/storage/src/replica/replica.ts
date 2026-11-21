import {
  componentField,
  fieldComponent,
  isComponentUpdate,
  isRowCreate,
  linkTargets,
  type Action,
  type Entity,
  type Update,
} from "@ebbjs/core";

import {
  applyUpdate,
  RESIDENT_MAP_FIELDS,
  withAdoptedMapFields,
  withWireMapFields,
} from "../internal/materialize";
import {
  applyComponentDelta,
  buildComponentIndexFrom,
  componentSetDelta,
  componentIds,
  touchedComponentSet,
  type ComponentIndex,
} from "../internal/component-index";
import { REPLICA_RECORD_FORMAT, isValidReplicaRecord } from "../internal/replica-record";
import {
  applyIndexDelta,
  forwardIndexDelta,
  forwardIndexEntriesFor,
  forwardMembershipIndexKey,
  indexEntriesFor,
  liveMembershipLinks,
  liveSourceIds,
  membershipIndexKey,
  reverseIndexDelta,
  reverseIndexKey,
  type IndexEntry,
  type ReverseIndex,
} from "../internal/reverse-index";
import type { MembershipLink } from "../types/entity-store";
import type { ReplicaRecord } from "../types/replica-store";

import { contentChanged } from "./content-changed";
import { createLeaseTable, type LeaseKey, type LeaseTable, type Release } from "./leases";
import type {
  MembershipQuery,
  MembershipTransition,
  Replica,
  ReplicaChange,
  ReplicaOptions,
  ReplicaStats,
  RelationshipQuery,
  Revision,
} from "./types";

export const DEFAULT_JOURNAL_CAPACITY = 1024;

/**
 * A journal that retains everything is `Infinity`, so the trimmer never finds
 * an excess. Non-positive and non-finite values are unbounded by contract.
 */
const journalCapacityOf = (capacity: number | undefined): number => {
  if (capacity === undefined) return DEFAULT_JOURNAL_CAPACITY;
  if (!Number.isFinite(capacity) || capacity <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(capacity));
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

/** A composed view plus the components it is known to carry. */
interface Snapshot {
  readonly row: Entity | null;
  readonly components: readonly string[];
}

/** One cold component read, shared by every caller that asked for it. */
interface PendingRead {
  /** Set when the row left the replica, so a late result installs nothing. */
  cancelled: boolean;
  /** The read's own outcome, awaited by every coalesced caller. */
  promise: Promise<void>;
}

/**
 * Mutable in-place core. `entities` is the materialized base (what `toRecord`
 * persists), `overlay` composes optimistic writes over it, and `effective`
 * caches the composed view for overlaid ids so a read never recomposes.
 *
 * A row's values are its components' residency: every row the replica holds
 * carries a value for every component it knows about, so there is no
 * component-level "known but absent" half to track. What decides how long a
 * value stays is the lease table, keyed `(entity, component)`. A row folded
 * from the log is the replica's own data and no claim can take it away; a row
 * a read installed from the local store is claimed by that read, and leaves
 * whole once the last claim's grace period ends (`storeRows`). There is no cap
 * and no declared policy (#933, #943).
 *
 * `modelIndex` indexes the base by model; `iterate` layers the overlay's model
 * overrides on top of it. `componentIndex` tracks the composed view's component
 * set alongside the adjacency indices, and is likewise derived rather than
 * persisted.
 */
export const createReplica = (options?: ReplicaOptions): Replica => {
  const declaredVersion = (component: string): number =>
    options?.versions?.declared(component) ?? 1;

  const entities = new Map<string, Entity>();
  /** The declared version each component's value was materialized at (#804). */
  const componentVersions = new Map<string, Map<string, number>>();
  /**
   * Rows whose values a read installed from the local store rather than folding
   * from the log. Their components are lease-owned, so the last expired claim
   * takes the row with it; a row the log folded is never expirable.
   */
  const storeRows = new Set<string>();
  const modelIndex = new Map<string, Set<string>>();
  let componentIndex: ComponentIndex = new Map();
  const overlay = new Map<string, OptimisticWrite[]>();
  const effective = new Map<string, Entity | null>();
  const orphans = new Map<string, OrphanUpdate[]>();
  const journalCapacity = journalCapacityOf(options?.journalCapacity);
  /**
   * A read claims the components it materializes, so a value is never dropped
   * while a caller is installing it, and a released value stays warm for one
   * grace period. Replaced wholesale by `load`, which drops every value.
   */
  let leases: LeaseTable = createLeaseTable({
    residencyTtlMs: options?.residencyTtlMs,
    onExpire: (key) => dropResidentValue(key),
  });
  /**
   * Cold reads in flight, per row then component, shared by concurrent readers.
   * An entry lives exactly as long as its read: `settleRead` is the only way
   * one goes away, and a row's map goes with its last entry.
   */
  const inFlightReads = new Map<string, Map<string, PendingRead>>();
  /** Updates that landed for a row while a cold read was in flight. */
  const pendingWrites = new Map<string, OrphanUpdate[]>();
  let journal: ReplicaChange[] = [];
  // Head cursor into `journal`: trimming advances it in O(1), and a later
  // splice folds the dead prefix away once it dominates the array.
  let journalStart = 0;

  // Adjacency over the composed view, not the base map: the reverse index must
  // see optimistic edges. It shares the index module's entry derivation, so the
  // replica cannot drift from the adapters. The forward index is the
  // entity-keyed membership direction only: a source's own edges are a read of
  // its row's `ebb/link` component.
  let reverseIndex: ReverseIndex = {};
  let forwardIndex: ReverseIndex = {};

  let revision: Revision = 0;
  let changeFloor: Revision = 0;
  let lastPosition = 0;
  const listeners = new Set<() => void>();

  /** Notify derived readers after the composed view has settled. */
  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[Replica] change listener threw:", err);
      }
    }
  };

  const addToModel = (model: string, id: string): void => {
    const ids = modelIndex.get(model);
    if (ids === undefined) modelIndex.set(model, new Set([id]));
    else ids.add(id);
  };

  const removeFromModel = (model: string, id: string): void => {
    const ids = modelIndex.get(model);
    if (ids === undefined) return;
    ids.delete(id);
    if (ids.size === 0) modelIndex.delete(model);
  };

  /** Present components of a row's field map, an `ebb/*` overlay under `ebb`. */
  const fieldComponentsOf = (row: Entity): readonly string[] =>
    Object.keys(row.data.fields).map((field) => fieldComponent(row.model, field));

  /**
   * Every component a row carries. A row's fields are its components: the
   * replica holds no value it cannot project, so nothing is "known but absent".
   */
  const presenceOfRow = (row: Entity): readonly string[] => fieldComponentsOf(row);

  const hasReadInFlight = (id: string): boolean => {
    const reads = inFlightReads.get(id);
    return reads !== undefined && reads.size > 0;
  };

  /** Cancel a row's cold reads: whatever they return must not land. */
  const cancelReadsFor = (id: string): void => {
    const reads = inFlightReads.get(id);
    if (reads !== undefined) {
      for (const pending of reads.values()) pending.cancelled = true;
      inFlightReads.delete(id);
    }
    pendingWrites.delete(id);
  };

  /**
   * Drop one read's bookkeeping, whatever it returned. Identity-guarded, so a
   * read that settles after its row was dropped cannot delete its successor.
   */
  const settleRead = (id: string, component: string, pending: PendingRead): void => {
    const reads = inFlightReads.get(id);
    if (reads === undefined || reads.get(component) !== pending) return;
    reads.delete(component);
    if (reads.size === 0) inFlightReads.delete(id);
  };

  /**
   * Fold the writes that waited behind a cold read, and settle them like any
   * other write: the base takes them, and `resync` republishes the composed
   * view, reconciles the derived indices, and journals what they changed. A
   * row they create is therefore visible to `components()` and the adjacency
   * index, not only by id. `pending` is the view settled just before the fold,
   * for a caller that has already published one. Returns whether anything was
   * replayed, so the caller can notify once for the batch.
   */
  const replayBufferedWrites = (id: string, pending?: Snapshot): boolean => {
    const buffered = pendingWrites.get(id);
    if (buffered === undefined) return false;
    pendingWrites.delete(id);
    const previous = pending ?? capture(id);
    for (const entry of buffered)
      applyBaseUpdate(entry.update, entry.gsn, entry.hlc, entry.position);
    resync(id, previous);
    return true;
  };

  /** Drop every read in flight, so no result lands in a replaced view. */
  const cancelAllReads = (): void => {
    for (const id of inFlightReads.keys()) cancelReadsFor(id);
  };

  /** Append one content change: the values of a row that stayed in its set. */
  const journalContent = (id: string, deleted: boolean, components: readonly string[]): void => {
    revision += 1;
    journal.push({ revision, id, kind: "content", deleted, components });
    trimJournal();
  };

  /**
   * Append one membership change: the row's place in a model's set moved. It
   * names no component, because a row can enter or leave carrying anything.
   */
  const journalMembership = (
    id: string,
    deleted: boolean,
    membership: MembershipTransition,
    models: readonly string[],
  ): void => {
    revision += 1;
    journal.push({ revision, id, kind: "membership", deleted, membership, models });
    trimJournal();
  };

  /**
   * The row as the set a read is drawn from sees it: a tombstone is a value, so
   * a tombstoned row is not in the set even while the replica holds its row, and
   * a row no create has filed under a model yet belongs to none. Residency is
   * not part of it: a row the policy keeps no value of is still a row `get` and
   * `iterate` answer with, and a read draws its ids from there.
   */
  const sourceRow = (row: Entity | null): Entity | null =>
    row !== null && row.model !== "" && row.deleted_hlc === null ? row : null;

  const retainedChanges = (): number => journal.length - journalStart;

  /**
   * Drop the oldest changes once the retained window exceeds the configured
   * capacity. The floor moves to the newest dropped revision: from there the
   * retained journal is complete again, and an older cursor cannot be served.
   */
  const trimJournal = (): void => {
    const excess = retainedChanges() - journalCapacity;
    if (excess <= 0) return;
    journalStart += excess;
    changeFloor = journal[journalStart - 1].revision;
    if (journalStart * 2 >= journal.length) {
      journal = journal.slice(journalStart);
      journalStart = 0;
    }
  };

  const viewOf = (id: string): Entity | null =>
    effective.has(id) ? (effective.get(id) ?? null) : (entities.get(id) ?? null);

  const presenceOfView = (id: string): readonly string[] => {
    const row = viewOf(id);
    return row === null ? [] : presenceOfRow(row);
  };

  const capture = (id: string): Snapshot => ({
    row: viewOf(id),
    components: presenceOfView(id),
  });

  const get = (id: string): Entity | undefined => viewOf(id) ?? undefined;

  const iterate = (model: string): readonly Entity[] => {
    // The base index answers for every composed row, but the overlay can know a
    // row the base has never seen — an optimistic create — or hold the create
    // that settles a placeholder's provisional model, so its rows win.
    const ids = new Set(modelIndex.get(model) ?? []);
    for (const [id, row] of effective) {
      if (row !== null && row.model === model) ids.add(id);
      else ids.delete(id);
    }
    const rows: Entity[] = [];
    for (const id of ids) {
      const row = get(id);
      if (row !== undefined) rows.push(row);
    }
    return rows;
  };

  /** Append an update waiting for a base row, keyed by its subject. */
  const bufferUpdate = (buffer: Map<string, OrphanUpdate[]>, entry: OrphanUpdate): void => {
    const id = entry.update.subject_id;
    const pending = buffer.get(id);
    if (pending === undefined) buffer.set(id, [entry]);
    else pending.push(entry);
  };

  /** Record the version an explicit component write materializes at. */
  const stampVersion = (id: string, component: string, version: number): void => {
    const stamps = componentVersions.get(id);
    if (stamps === undefined) componentVersions.set(id, new Map([[component, version]]));
    else stamps.set(component, version);
  };

  const forgetVersion = (id: string, component: string): void => {
    const stamps = componentVersions.get(id);
    if (stamps === undefined) return;
    stamps.delete(component);
    if (stamps.size === 0) componentVersions.delete(id);
  };

  const foldIntoBase = (update: Update, gsn: number, hlc: string, position: number): void => {
    const id = update.subject_id;
    const previous = entities.get(id) ?? null;

    // The local store row is read asynchronously; keep updates that land while
    // that read is in flight so the install replays them instead of hiding
    // them behind a snapshot taken before they arrived.
    if (hasReadInFlight(id)) {
      bufferUpdate(pendingWrites, { update, gsn, hlc, position });
      return;
    }

    // A create names no component, so it has no version to stamp: it only
    // makes the row exist.
    if (!isRowCreate(update)) {
      if (update.method === "drop") forgetVersion(id, update.component);
      else if (update.method !== "delete") {
        stampVersion(id, update.component, declaredVersion(update.component));
      }
    }

    const next = applyUpdate(previous, update, gsn, hlc, RESIDENT_MAP_FIELDS);

    if (next === null) {
      if (previous === null) {
        // A drop for a row this replica has never held: keep the Update so a
        // later base can replay it in gsn order.
        if (update.method === "drop") bufferUpdate(orphans, { update, gsn, hlc, position });
        return;
      }
      entities.delete(id);
      componentVersions.delete(id);
      storeRows.delete(id);
      removeFromModel(previous.model, id);
      return;
    }

    // A write moves the row into the log's own materialized base: its values
    // are the replica's data now, so no lease expiry may take them away.
    storeRows.delete(id);
    entities.set(id, next);
    if (previous !== null && previous.model !== next.model) removeFromModel(previous.model, id);
    addToModel(next.model, id);
  };

  /**
   * Fold one Update into the base, then drop the claim a `drop` left dangling:
   * a claim keeps a value warm, so a component the row no longer carries has
   * nothing to keep and must not report residency the view does not have. A
   * live claim stays — it still owns the read that asked for the value.
   */
  const applyBaseUpdate = (update: Update, gsn: number, hlc: string, position: number): void => {
    foldIntoBase(update, gsn, hlc, position);
    if (update.method !== "drop") return;
    const id = update.subject_id;
    const component = update.component;
    if (isComponentResident(id, component)) return;
    const key = { entityId: id, component };
    if (leases.refsOf(key) === 0) leases.forget(key);
  };

  /**
   * Fold the writes that arrived before this row had a base into it, now that
   * one does. Only Updates newer than the Action that opened the row survive;
   * older ones are subsumed by it, exactly as the store's gsn-ordered replay
   * would fold them.
   */
  const replayOrphans = (id: string, baseGsn: number): void => {
    const pending = orphans.get(id);
    if (pending === undefined) return;
    const base = entities.get(id);
    if (base === undefined) return;
    orphans.delete(id);

    const survivors = pending
      .filter((orphan) => orphan.gsn > baseGsn)
      .sort((a, b) => a.gsn - b.gsn);
    let row: Entity = base;
    for (const orphan of survivors) {
      row = applyUpdate(row, orphan.update, orphan.gsn, orphan.hlc, RESIDENT_MAP_FIELDS) ?? row;
    }
    if (row === base) return;

    // Buffered writes are drops, which detach a field and never move a model.
    entities.set(id, row);
  };

  /**
   * Every derived index tracks the composed view, so they must be reconciled
   * wherever that view changes — which is why `publish` is the one place a
   * settled view reaches them.
   */
  const reconcileIndex = (previous: Snapshot, next: Snapshot): void => {
    const before = previous.row ?? undefined;
    const after = next.row ?? undefined;
    reverseIndex = applyIndexDelta(reverseIndex, reverseIndexDelta(before, after));
    forwardIndex = applyIndexDelta(forwardIndex, forwardIndexDelta(before, after));
    const id = (after ?? before)?.id;
    if (id === undefined) return;
    const delta = componentSetDelta(id, previous.components, next.components);
    if (delta !== null) componentIndex = applyComponentDelta(componentIndex, delta);
  };

  /** The base row with the overlay's optimistic writes folded on, if any. */
  const compose = (id: string): { next: Entity | null; overlaid: boolean } => {
    const writes = overlay.get(id) ?? [];
    let next = entities.get(id) ?? null;
    for (const write of writes) {
      next = applyUpdate(next, write.update, 0, write.hlc, RESIDENT_MAP_FIELDS);
    }
    return { next, overlaid: writes.length > 0 };
  };

  /**
   * Settle a composed view: cache it for overlaid ids, then move the derived
   * indices with it. A published row is the row `get` and `iterate` answer
   * with, and it carries a value for every component it knows.
   */
  const publish = (
    id: string,
    next: Entity | null,
    overlaid: boolean,
    previous: Snapshot,
  ): Snapshot => {
    if (overlaid) effective.set(id, next);
    else effective.delete(id);
    const settled: Snapshot = {
      row: next,
      components: next === null ? [] : presenceOfRow(next),
    };
    reconcileIndex(previous, settled);
    return settled;
  };

  /** Publish one row's settled view: no journal entry, no notification. */
  const publishRow = (id: string, previous: Snapshot): void => {
    const { next, overlaid } = compose(id);
    publish(id, next, overlaid, previous);
  };

  /**
   * Settle the view after a residency move — an install or an expiry. Nothing
   * here journals: keeping or dropping a value is not a content change, so a
   * derived reader has nothing to re-run for (#936).
   */
  const refresh = (id: string, previous: Snapshot): void => {
    publishRow(id, previous);
    notify();
  };

  /**
   * Recompute the composed view after the base or overlay changed, journaling
   * iff a reader can see the difference. `previous` is the composed view
   * captured before the change, which is what makes an echo of an
   * already-visible optimistic write a no-op for the revision.
   *
   * A row arriving or leaving the set it is read from, or being filed under
   * another model, is a membership change and stops there: its components are
   * what it arrived or left carrying, not a value change a reader could already
   * have seen. Everything else is a content change naming what it touched.
   *
   * Both sides are read from the same settled view — what `get` and `iterate`
   * answer with — because that is the set a read draws from. Residency is a
   * separate question: a row the policy retains no value of is still in the set,
   * so a create that keeps nothing still enters it, and a write to it cannot
   * make it leave.
   */
  const resync = (id: string, previous: Snapshot): void => {
    const { next, overlaid } = compose(id);
    publish(id, next, overlaid, previous);
    const view = viewOf(id);
    const before = sourceRow(previous.row);
    const after = sourceRow(view);

    if (after !== null) {
      if (before === null) {
        journalMembership(id, false, "entered", [after.model]);
        return;
      }
      if (before.model !== after.model) {
        journalMembership(id, false, "changed-model", [before.model, after.model]);
        return;
      }
    } else if (before !== null) {
      journalMembership(id, view?.deleted_hlc != null, "left", [before.model]);
      return;
    }

    // A row out of the set on both sides and absent now is unobservable: there
    // is nothing left to name.
    if (view === null) return;
    const touched = touchedComponentSet(
      previous.row,
      previous.components,
      view,
      presenceOfView(id),
    );
    if (contentChanged(previous.row, view) || touched.length > 0) {
      journalContent(id, view.deleted_hlc !== null, touched);
    }
  };

  const rememberView = (before: Map<string, Snapshot>, id: string): void => {
    if (!before.has(id)) before.set(id, capture(id));
  };

  /** Drop one action's overlay writes, capturing the pre-change views. */
  const dropOverlay = (actionId: string, before: Map<string, Snapshot>): string[] => {
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
    const before = new Map<string, Snapshot>();
    for (const update of delta) rememberView(before, update.subject_id);

    // The echo of an optimistic Action now lives in the base; drop its overlay.
    const echoed = dropOverlay(action.id, before);

    // A create opens the row and the row's components land in the same Action,
    // so a buffered later write is folded once the whole Action is in — not on
    // the first Update that makes the row exist, which would order it before
    // the components delivered with the create.
    const awaitingOrphans = [...orphans.keys()].filter((id) => !entities.has(id));

    for (const update of delta) applyBaseUpdate(update, action.gsn, action.hlc, position);
    for (const id of awaitingOrphans) replayOrphans(id, action.gsn);
    if (position > lastPosition) lastPosition = position;

    const touched = new Set<string>(delta.map((update) => update.subject_id));
    for (const id of echoed) touched.add(id);
    for (const id of touched) resync(id, before.get(id) ?? capture(id));
    notify();
    return revision;
  };

  const optimistic = (action: Action): Revision => {
    const before = new Map<string, Snapshot>();
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
    for (const id of touched) resync(id, before.get(id) ?? capture(id));
    notify();
    return revision;
  };

  const discard = (actionId: string): Revision => {
    const before = new Map<string, Snapshot>();
    const affected = dropOverlay(actionId, before);
    for (const id of affected) resync(id, before.get(id) ?? capture(id));
    notify();
    return revision;
  };

  /** Remove a row's base, overlay, and index traces without journaling. */
  const removeRow = (id: string): void => {
    const base = entities.get(id);
    entities.delete(id);
    componentVersions.delete(id);
    storeRows.delete(id);
    overlay.delete(id);
    effective.delete(id);
    orphans.delete(id);
    cancelReadsFor(id);
    if (base !== undefined) removeFromModel(base.model, id);
  };

  /**
   * Eviction is a visible removal, so each dropped row journals one membership
   * change naming the model it was filed under — it leaves that set, and which
   * components it carried is not what a reader matches on. Traces an id leaves
   * in the overlay or orphan buffer have no row to journal, but go with it.
   */
  const evict = (ids: readonly string[]): Revision => {
    const seen = new Set<string>();
    let removed = false;
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const previous = capture(id);
      removeRow(id);
      for (const component of previous.components) leases.forget({ entityId: id, component });
      reconcileIndex(previous, { row: null, components: [] });
      if (previous.row === null) continue;
      removed = true;
      const filed = sourceRow(previous.row);
      // A row no model has filed belongs to no set, so what a reader loses is
      // the values it carried rather than a place in a model.
      if (filed === null)
        journalContent(id, previous.row.deleted_hlc !== null, previous.components);
      else journalMembership(id, previous.row.deleted_hlc !== null, "left", [filed.model]);
    }
    if (removed) notify();
    return revision;
  };

  const load = (record: ReplicaRecord): Revision => {
    if (!isValidReplicaRecord(record)) return revision;
    entities.clear();
    modelIndex.clear();
    storeRows.clear();
    componentVersions.clear();
    orphans.clear();
    overlay.clear();
    effective.clear();
    cancelAllReads();
    // A load replaces the in-memory view, so every claim on the old values goes
    // with it. A timer armed by the replaced table can still fire; `dropResidentValue`
    // checks the live table before dropping anything.
    leases = createLeaseTable({
      residencyTtlMs: options?.residencyTtlMs,
      onExpire: (key) => dropResidentValue(key),
    });
    journal.length = 0;
    journalStart = 0;
    // One linear pass rebuilds the base, the adjacency index, and component
    // existence; the derived indices are not persisted. Mutating the local row
    // maps keeps the rebuild linear where folding `applyIndexDelta` per row
    // would copy the whole key space each time.
    const reverse: Record<string, Record<string, string>> = {};
    const forward: Record<string, Record<string, string>> = {};
    const add = (index: Record<string, Record<string, string>>, entry: IndexEntry): void => {
      const rows = index[entry.key];
      if (rows === undefined) index[entry.key] = { [entry.id]: entry.value };
      else rows[entry.id] = entry.value;
    };
    const presence: { id: string; components: readonly string[] }[] = [];
    for (const entity of record.entities) {
      // The record is a snapshot of the materialized view, so its rows are
      // adopted whole and become the replica's own data again.
      const row = withAdoptedMapFields(entity);
      entities.set(row.id, row);
      addToModel(row.model, row.id);
      const components = presenceOfRow(row);
      const stamps = new Map<string, number>();
      for (const component of components) {
        stamps.set(
          component,
          record.componentVersions[row.id]?.[component] ?? declaredVersion(component),
        );
      }
      if (stamps.size > 0) componentVersions.set(row.id, stamps);
      presence.push({ id: row.id, components });
      for (const entry of indexEntriesFor(row)) add(reverse, entry);
      for (const entry of forwardIndexEntriesFor(row)) add(forward, entry);
    }
    componentIndex = buildComponentIndexFrom(presence);
    reverseIndex = reverse;
    forwardIndex = forward;
    // A load replaces the journal wholesale. When it advances the revision,
    // that jump is the signal; when it does not (a restore of the same
    // durable base), bump by one so derived readers still observe the swap.
    revision = record.revision > revision ? record.revision : revision + 1;
    changeFloor = revision;
    lastPosition = record.position;
    notify();
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
    // A resident row persists whole: what a read installed is in memory the
    // same way a folded value is, and a map field leaves as the flat wire
    // shape. Durability is the store's; this is the fast path back to a view.
    const persisted: Entity[] = [];
    const versions: Record<string, Record<string, number>> = {};
    for (const row of entities.values()) {
      persisted.push(withWireMapFields(row));
      // A session-materialized component has no stamp; persist the declaration.
      const stamps: Record<string, number> = {};
      for (const component of presenceOfRow(row)) {
        stamps[component] =
          componentVersions.get(row.id)?.get(component) ?? declaredVersion(component);
      }
      if (Object.keys(stamps).length > 0) versions[row.id] = stamps;
    }
    return {
      format: REPLICA_RECORD_FORMAT,
      position,
      revision,
      entities: persisted,
      componentVersions: versions,
    };
  };

  const stats = (): ReplicaStats => {
    const byModel: Record<string, number> = {};
    const ids = new Set<string>(entities.keys());
    for (const [id, row] of effective) {
      if (row !== null) ids.add(id);
    }
    let total = 0;
    let components = 0;

    for (const id of ids) {
      const row = viewOf(id);
      if (row === null) continue;
      total += 1;
      byModel[row.model] = (byModel[row.model] ?? 0) + 1;
      components += new Set(presenceOfRow(row)).size;
    }
    return {
      entities: total,
      byModel,
      leases: leases.stats(),
      components,
      revision,
      position: lastPosition,
      changes: retainedChanges(),
      changeFloor,
      readsInFlight: inFlightReads.size,
    };
  };

  const changesSince = (from: Revision): readonly ReplicaChange[] => {
    if (from < changeFloor) return [];
    const changes: ReplicaChange[] = [];
    for (let index = journalStart; index < journal.length; index += 1) {
      const change = journal[index];
      if (change.revision > from) changes.push(change);
    }
    return changes;
  };

  /**
   * Drop a value whose claim went inactive for longer than the residency grace
   * period. Expiry is a residency event, not a content change: the value leaves
   * the composed view and nothing journals (#936).
   *
   * Only a claim owns a value: a row the log folded is the replica's own data,
   * and a lease that expired over it releases nothing. A row a read installed
   * leaves whole, because every value it carries came from the same store copy,
   * and it leaves only once no sibling is leased or still inside its own grace
   * period: each value gets its one grace period, and the row goes with the
   * last of them. An active lease is never expired (#933).
   */
  const dropResidentValue = (key: LeaseKey): void => {
    // A timer armed by a table a `load` has since replaced must not drop a value
    // the live table still claims.
    if (leases.isResident(key)) return;
    const id = key.entityId;
    const base = entities.get(id);
    if (base === undefined) return;
    // A row the log folded has no lease to run out: it is the replica's own
    // data, so it stays resident for the session. Reclaiming it needs a memory
    // budget this replica does not have yet (#957).
    if (!storeRows.has(id)) return;
    // Components are read from the composed view: an overlay can carry one the
    // base has never seen, and its claim is just as live.
    const components = new Set(presenceOfRow(base));
    const view = viewOf(id);
    if (view !== null) {
      for (const component of presenceOfRow(view)) components.add(component);
    }
    if (!components.has(key.component)) return;
    const stillResident = [...components].some(
      (component) => component !== key.component && leases.isResident({ entityId: id, component }),
    );
    if (stillResident) return;
    const previous = capture(id);
    removeRow(id);
    for (const component of previous.components) leases.forget({ entityId: id, component });
    refresh(id, previous);
  };

  /** Read one component through the seam. */
  const readOne = async (id: string, component: string): Promise<Entity | null> =>
    options?.readComponent?.(id, component) ?? null;

  /**
   * Install a component read for `id`, then replay the writes that waited
   * behind it. The install itself is residency: it is published, never
   * journalled. The writes are content, and journal through the replay.
   */
  const installComponent = (id: string, component: string, loaded: Entity): boolean => {
    const field = componentField(component);
    const adopted = withAdoptedMapFields(loaded);
    const value = adopted.data.fields[field];
    if (value === undefined) return false;
    const previous = capture(id);
    const base = entities.get(id) ?? null;
    // The store hands over a whole row, and the replica keeps it whole: a
    // value an older base row already carries is the replica's own data, so
    // the base wins and the install only fills what it lacks.
    const fields = { ...adopted.data.fields, ...base?.data.fields };
    const row: Entity = {
      ...(base ?? loaded),
      id,
      model: loaded.model,
      data: { fields },
      exists: loaded.exists,
      created_hlc: loaded.created_hlc,
      updated_hlc: loaded.updated_hlc,
      deleted_hlc: loaded.deleted_hlc,
      last_gsn: Math.max(base?.last_gsn ?? 0, loaded.last_gsn),
    };
    entities.set(id, row);
    addToModel(row.model, id);
    if (base === null) storeRows.add(id);
    publishRow(id, previous);
    replayBufferedWrites(id, capture(id));
    notify();
    return true;
  };

  /** A cold read for one component that nobody else is already running. */
  const startRead = (
    reads: Map<string, PendingRead>,
    id: string,
    component: string,
  ): PendingRead => {
    const pending: PendingRead = { cancelled: false, promise: Promise.resolve() };
    reads.set(component, pending);
    pending.promise = (async (): Promise<void> => {
      try {
        const loaded = await readOne(id, component).finally(() => {
          // Out of flight on every path, success or failure: a rejected read
          // must not poison the component, and it must not leave later writes
          // buffering behind a read that will never install.
          settleRead(id, component, pending);
        });
        if (pending.cancelled) return;
        // A read that installs nothing still leaves the writes that waited
        // behind it: they are content, and none of them may be dropped.
        const installed = loaded !== null && installComponent(id, component, loaded);
        if (!installed && replayBufferedWrites(id)) notify();
      } catch (thrown) {
        if (replayBufferedWrites(id)) notify();
        throw thrown;
      }
    })();
    return pending;
  };

  /**
   * Materialize one component under a claim. The claim is taken before the
   * store read, so nothing can drop the value between reading and installing
   * it, and it is released by the caller once the read has settled.
   */
  const materialize = async (id: string, component: string): Promise<void> => {
    const release = leases.acquire({ entityId: id, component });
    try {
      // A resident value is shared, not re-read; claiming it refreshes its
      // grace period, which is what makes a remount inside the TTL free.
      if (isComponentResident(id, component)) return;
      let reads = inFlightReads.get(id);
      if (reads === undefined) inFlightReads.set(id, (reads = new Map()));
      const pending = reads.get(component) ?? startRead(reads, id, component);
      await pending.promise;
    } finally {
      release();
      // A read that installed nothing leaves no value to keep, so it leaves no
      // claim behind either.
      if (!isComponentResident(id, component) && leases.refsOf({ entityId: id, component }) === 0) {
        leases.forget({ entityId: id, component });
      }
    }
  };

  /** Whether the replica holds a value for every component `row` carries. */
  const fullyResident = (row: Entity): boolean =>
    fieldComponentsOf(row).every((component) => isComponentResident(row.id, component));

  const isComponentResident = (id: string, component: string): boolean => {
    const row = viewOf(id);
    return row !== null && row.data.fields[componentField(component)] !== undefined;
  };

  const residentComponents = (id: string): readonly string[] => {
    const row = viewOf(id);
    return row === null ? [] : fieldComponentsOf(row);
  };

  const read = async (id: string, components: readonly string[]): Promise<Entity | null> => {
    await Promise.all(components.map((component) => materialize(id, component)));
    return get(id) ?? null;
  };

  /**
   * Claim every value before reading any of them, so nothing a long-lived reader
   * depends on can go inactive between the read installing it and the claim
   * replacing the read's own one. A component the read installs nothing for
   * keeps no claim: there is no value to hold.
   */
  const acquire = async (id: string, components: readonly string[]): Promise<Release> => {
    /** A claim on a value that never arrived leaves no residency entry behind. */
    const dropEmptyClaim = (entityId: string, component: string): void => {
      if (
        leases.refsOf({ entityId, component }) === 0 &&
        !isComponentResident(entityId, component)
      ) {
        leases.forget({ entityId, component });
      }
    };
    const claims: { component: string; release: Release }[] = [];
    for (const component of new Set(components)) {
      claims.push({ component, release: leases.acquire({ entityId: id, component }) });
    }
    try {
      await Promise.all(claims.map(({ component }) => materialize(id, component)));
    } catch (thrown) {
      for (const { component, release } of claims) {
        release();
        dropEmptyClaim(id, component);
      }
      throw thrown;
    }
    const claimed: Release[] = [];
    for (const { component, release } of claims) {
      if (isComponentResident(id, component)) {
        claimed.push(release);
        continue;
      }
      release();
      dropEmptyClaim(id, component);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of claimed) release();
    };
  };

  const componentVersion = (id: string, component: string): number | undefined => {
    // An optimistic write is at the declaration it was validated against.
    const writes = overlay.get(id);
    if (
      writes?.some(
        (write) =>
          isComponentUpdate(write.update) &&
          write.update.method !== "drop" &&
          write.update.component === component,
      ) === true
    ) {
      return declaredVersion(component);
    }
    return componentVersions.get(id)?.get(component);
  };

  return {
    get revision() {
      return revision;
    },
    get changeFloor() {
      return changeFloor;
    },
    get,
    base: (id) => entities.get(id),
    iterate,
    fullyResident,
    read,
    acquire,
    isComponentResident,
    residentComponents,
    componentVersion,
    changesSince,
    stats,
    relationships: (query: RelationshipQuery): readonly string[] => {
      if (query.sourceId !== undefined) {
        const row = get(query.sourceId);
        // A tombstoned row keeps its fields, so it is asked separately whether
        // it is still a live source of anything.
        if (row === undefined || row.deleted_hlc !== null) return [];
        return linkTargets(row, query.as, query.type);
      }
      if (query.targetId !== undefined) {
        return liveSourceIds(reverseIndex[reverseIndexKey(query.as, query.type, query.targetId)]);
      }
      return [];
    },
    components: (component) => componentIds(componentIndex, component),
    memberships: (query: MembershipQuery): readonly string[] => {
      if (query.groupId !== undefined) {
        return liveSourceIds(reverseIndex[membershipIndexKey(query.groupId)]);
      }
      if (query.entityId !== undefined) {
        return liveSourceIds(forwardIndex[forwardMembershipIndexKey(query.entityId)]);
      }
      return [];
    },
    membershipLinks: (entityId: string): readonly MembershipLink[] =>
      liveMembershipLinks(forwardIndex[forwardMembershipIndexKey(entityId)]),
    ingest,
    optimistic,
    discard,
    load,
    toRecord,
    evict,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
