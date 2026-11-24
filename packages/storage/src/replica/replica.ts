import {
  componentField,
  fieldComponent,
  isComponentUpdate,
  type Action,
  type Entity,
  type FieldValue,
  type Update,
} from "@ebbjs/core";

import {
  applyUpdate,
  RESIDENT_MAP_FIELDS,
  withAdoptedMapFields,
  withWireMapFields,
} from "../internal/materialize";
import { touchedComponentSet } from "../internal/component-index";
import { REPLICA_RECORD_FORMAT, isValidReplicaRecord } from "../internal/replica-record";
import type { MembershipLink } from "../types/entity-store";
import type { ReplicaRecord } from "../types/replica-store";

import { contentChanged } from "./content-changed";
import { createLeaseTable, type LeaseKey, type LeaseTable, type Release } from "./leases";
import { componentsOfRow, createRowIndex, entryOf, type RowEntry } from "./row-index";
import { jsonBytes } from "./size";
import type {
  MembershipQuery,
  MembershipTransition,
  Replica,
  ReplicaBytes,
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

/** A composed view plus the components the row carries. */
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
 * A durable base the overlay is composed over. It exists only while a row has
 * optimistic writes; every other row's base is its index entry plus the value
 * cache.
 */
interface BaseState {
  readonly row: Entity | null;
  readonly versions: Readonly<Record<string, number>>;
}

const sameFields = (
  a: Readonly<Record<string, FieldValue>>,
  b: Readonly<Record<string, FieldValue>>,
): boolean => {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
};

const rowMetaEquals = (a: Entity, b: Entity): boolean =>
  a.id === b.id &&
  a.model === b.model &&
  a.exists === b.exists &&
  a.created_hlc === b.created_hlc &&
  a.updated_hlc === b.updated_hlc &&
  a.deleted_hlc === b.deleted_hlc &&
  a.last_gsn === b.last_gsn;

const entityOfEntry = (entry: RowEntry, data: Entity["data"]): Entity => ({
  id: entry.id,
  model: entry.model,
  data,
  exists: entry.exists,
  created_hlc: entry.createdHlc,
  updated_hlc: entry.updatedHlc,
  deleted_hlc: entry.deletedHlc,
  last_gsn: entry.lastGsn,
});

const rowFromEntry = (entry: RowEntry, extra?: Readonly<Record<string, FieldValue>>): Entity =>
  entityOfEntry(entry, {
    fields: extra === undefined ? entry.fields : { ...entry.fields, ...extra },
  });

/** The values a row carries that live outside its entry: map-shaped user components. */
const extraFieldsOf = (row: Entity, entry: RowEntry): Readonly<Record<string, FieldValue>> => {
  const extra: Record<string, FieldValue> = {};
  for (const [field, value] of Object.entries(row.data.fields)) {
    if (entry.fields[field] === undefined) extra[field] = value;
  }
  return extra;
};

interface Envelope {
  readonly id: string;
  readonly model: string;
  readonly exists: boolean;
  readonly created_hlc: string | null;
  readonly updated_hlc: string;
  readonly deleted_hlc: string | null;
  readonly last_gsn: number;
}

const envelopeShape = (row: Envelope): Envelope => ({
  id: row.id,
  model: row.model,
  exists: row.exists,
  created_hlc: row.created_hlc,
  updated_hlc: row.updated_hlc,
  deleted_hlc: row.deleted_hlc,
  last_gsn: row.last_gsn,
});

/** A row's envelope: everything but its component values. */
const envelopeBytes = (entry: RowEntry): number =>
  jsonBytes(
    envelopeShape({
      id: entry.id,
      model: entry.model,
      exists: entry.exists,
      created_hlc: entry.createdHlc,
      updated_hlc: entry.updatedHlc,
      deleted_hlc: entry.deletedHlc,
      last_gsn: entry.lastGsn,
    }),
  );

/** An empty structure retains nothing, so it must not cost its JSON punctuation. */
const recordBytes = (shape: Readonly<Record<string, unknown>>): number =>
  Object.keys(shape).length === 0 ? 0 : jsonBytes(shape);

/**
 * Mutable in-place core. `index` owns every row's place in the lookups a query
 * reads; `values` owns the component values that may leave memory. Together
 * they replace the old base row map: `get` composes the entry's always-resident
 * fields with whatever values are resident, and `iterate` answers with the
 * entry alone.
 *
 * The overlay still composes optimistic writes over the durable base. For an
 * overlaid row the base is kept in `overlaidBase`, so discarding the writes can
 * restore it; every other row's base is its index entry plus the value cache.
 */
export const createReplica = (options?: ReplicaOptions): Replica => {
  const declaredVersion = (component: string): number =>
    options?.versions?.declared(component) ?? 1;

  const index = createRowIndex();
  /** Values that do not live in an entry: the map-shaped user components. */
  const values = new Map<string, Readonly<Record<string, FieldValue>>>();
  /**
   * The row objects iterate and get answer with, one per entry. They are views
   * of entries and values, not a third retained category, so `bytes` counts
   * the data they point at rather than the caches. Keeping them stable is what
   * makes a shared row read share one object.
   */
  const entryRows = new Map<string, Entity>();
  const composedRows = new Map<string, Entity>();
  /**
   * Components whose values a read installed from the local store, and which
   * therefore may leave again when their last claim expires. A value the log
   * folded is the replica's own data and never expires.
   */
  const storeOwned = new Map<string, Set<string>>();
  const overlay = new Map<string, OptimisticWrite[]>();
  /** The durable base under an overlaid row, kept only while writes are pending. */
  const overlaidBase = new Map<string, BaseState>();
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
   * a row no create has filed under a model yet belongs to none.
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

  /**
   * The composed row: the entry's always-resident fields plus the values the
   * cache holds. A missing map value makes the row partial; a query acquires
   * before projecting.
   */
  const viewOf = (id: string): Entity | null => {
    const entry = index.get(id);
    if (entry === undefined) return null;
    const extra = values.get(id);
    if (extra === undefined || Object.keys(extra).length === 0) {
      return entryRows.get(id) ?? null;
    }
    const fields = { ...entry.fields, ...extra };
    const cached = composedRows.get(id);
    const data =
      cached !== undefined && sameFields(cached.data.fields, fields) ? cached.data : { fields };
    const row = entityOfEntry(entry, data);
    if (cached !== undefined && rowMetaEquals(cached, row)) return cached;
    composedRows.set(id, row);
    return row;
  };

  /** Write the index entry for a settled base row, and replace its cached views. */
  const setIndexedRow = (
    id: string,
    row: Entity | null,
    versions: Readonly<Record<string, number>>,
  ): void => {
    if (row === null) {
      index.remove(id);
      entryRows.delete(id);
      composedRows.delete(id);
      values.delete(id);
      return;
    }
    const entry = entryOf(row, versions);
    index.set(entry);
    const previous = entryRows.get(id);
    const data =
      previous !== undefined && sameFields(previous.data.fields, entry.fields)
        ? previous.data
        : { fields: entry.fields };
    entryRows.set(id, entityOfEntry(entry, data));
    const extra = extraFieldsOf(row, entry);
    if (Object.keys(extra).length === 0) values.delete(id);
    else values.set(id, extra);
  };

  /** Remove a row's base, overlay, and index traces without journaling. */
  const removeRow = (id: string): void => {
    index.remove(id);
    entryRows.delete(id);
    composedRows.delete(id);
    values.delete(id);
    storeOwned.delete(id);
    overlay.delete(id);
    overlaidBase.delete(id);
    orphans.delete(id);
    cancelReadsFor(id);
  };

  /** The durable base under a row: the overlaid snapshot, or the index entry. */
  const baseStateOf = (id: string): BaseState | null => {
    const base = overlaidBase.get(id);
    if (base !== undefined) return base;
    const entry = index.get(id);
    if (entry === undefined) return null;
    return { row: rowFromEntry(entry, values.get(id)), versions: entry.versions };
  };

  const versionsForRow = (
    previous: Readonly<Record<string, number>>,
    row: Entity | null,
    written: ReadonlySet<string> = new Set(),
  ): Readonly<Record<string, number>> => {
    if (row === null) return {};
    const versions: Record<string, number> = {};
    for (const component of componentsOfRow(row)) {
      versions[component] = written.has(component)
        ? declaredVersion(component)
        : (previous[component] ?? declaredVersion(component));
    }
    return versions;
  };

  const updateComponent = (update: Update): string | null =>
    isComponentUpdate(update) && update.method !== "drop" ? update.component : null;

  /** The component an update stamps at its declaration, if it writes a value. */
  const writtenComponents = (updates: readonly Update[]): ReadonlySet<string> => {
    const written = new Set<string>();
    for (const update of updates) {
      const component = updateComponent(update);
      if (component !== null) written.add(component);
    }
    return written;
  };

  /**
   * A row with the value cache folded in. A base row under optimistic writes
   * keeps only durable values; the map values a read installed live here.
   */
  const withResidentValues = (id: string, row: Entity | null): Entity | null => {
    const extra = values.get(id);
    if (row === null || extra === undefined) return row;
    return { ...row, data: { fields: { ...extra, ...row.data.fields } } };
  };

  /** Compose the overlay's writes over a base row. */
  const composeRow = (id: string, base: Entity | null): Entity | null => {
    let row = withResidentValues(id, base);
    for (const write of overlay.get(id) ?? []) {
      row = applyUpdate(row, write.update, 0, write.hlc, RESIDENT_MAP_FIELDS);
    }
    return row;
  };

  /**
   * Settle the index on the composed view. A row with no pending writes brings
   * its base back into the index; an overlaid row is recomposed and set again,
   * which is the one place a write reaches the model, component, edge and
   * membership maps.
   */
  const deriveIndex = (id: string): void => {
    const overlaid = overlaidBase.get(id);
    if (overlaid === undefined) return;
    const writes = overlay.get(id) ?? [];
    const row = composeRow(id, overlaid.row);
    const versions =
      writes.length === 0
        ? versionsForRow(overlaid.versions, row)
        : versionsForRow(
            overlaid.versions,
            row,
            writtenComponents(writes.map((write) => write.update)),
          );
    if (writes.length === 0) overlaidBase.delete(id);
    if (row === null) removeRow(id);
    else setIndexedRow(id, row, versions);
  };

  const capture = (id: string): Snapshot => ({
    row: viewOf(id),
    components: index.get(id)?.components ?? [],
  });

  const get = (id: string): Entity | undefined => viewOf(id) ?? undefined;

  const iterate = (model: string): readonly Entity[] =>
    index.idsOfModel(model).flatMap((id) => {
      const row = entryRows.get(id);
      return row === undefined ? [] : [row];
    });

  /** Append an update waiting for a base row, keyed by its subject. */
  const bufferUpdate = (buffer: Map<string, OrphanUpdate[]>, entry: OrphanUpdate): void => {
    const id = entry.update.subject_id;
    const pending = buffer.get(id);
    if (pending === undefined) buffer.set(id, [entry]);
    else pending.push(entry);
  };

  /**
   * Fold one Update into the base. A row with optimistic writes folds into the
   * base snapshot the writes are composed over; every other row folds into its
   * index entry and value cache.
   */
  const foldIntoBase = (update: Update, gsn: number, hlc: string, position: number): void => {
    const id = update.subject_id;

    // The local store row is read asynchronously; keep updates that land while
    // that read is in flight so the install replays them instead of hiding
    // them behind a snapshot taken before they arrived.
    if (hasReadInFlight(id)) {
      bufferUpdate(pendingWrites, { update, gsn, hlc, position });
      return;
    }

    const overlaid = overlaidBase.get(id);
    if (overlaid !== undefined) {
      const next = applyUpdate(overlaid.row, update, gsn, hlc, RESIDENT_MAP_FIELDS);
      const component = updateComponent(update);
      const versions =
        component === null
          ? overlaid.versions
          : versionsForRow(overlaid.versions, next, new Set([component]));
      overlaidBase.set(id, { row: next, versions });
      storeOwned.delete(id);
      return;
    }

    const entry = index.get(id);
    const previous = entry === undefined ? null : rowFromEntry(entry, values.get(id));
    const next = applyUpdate(previous, update, gsn, hlc, RESIDENT_MAP_FIELDS);

    if (next === null) {
      if (previous === null) {
        // A drop for a row this replica has never held: keep the Update so a
        // later base can replay it in gsn order.
        if (update.method === "drop") bufferUpdate(orphans, { update, gsn, hlc, position });
        return;
      }
      removeRow(id);
      return;
    }

    // A write moves the row into the log's own materialized base: its values
    // are the replica's data now, so no lease expiry may take them away.
    storeOwned.delete(id);
    const component = updateComponent(update);
    const versions =
      component === null
        ? versionsForRow(entry?.versions ?? {}, next)
        : versionsForRow(entry?.versions ?? {}, next, new Set([component]));
    setIndexedRow(id, next, versions);
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
    const base = baseStateOf(id)?.row ?? null;
    if (base === null) return;
    orphans.delete(id);

    const survivors = pending
      .filter((orphan) => orphan.gsn > baseGsn)
      .sort((a, b) => a.gsn - b.gsn);
    for (const orphan of survivors) {
      applyBaseUpdate(orphan.update, orphan.gsn, orphan.hlc, orphan.position);
    }
  };

  /**
   * Recompute the composed view after the base or overlay changed, journaling
   * iff a reader can see the difference. `previous` is the composed view
   * captured before the change, which is what makes an echo of an
   * already-visible optimistic write a no-op for the revision.
   */
  const resync = (id: string, previous: Snapshot): void => {
    deriveIndex(id);
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
      index.get(id)?.components ?? [],
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

  /**
   * Fold the writes that waited behind a cold read, and settle them like any
   * other write. Returns whether anything was replayed, so the caller can
   * notify once for the batch.
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

  const ingest = (action: Action, delta: readonly Update[], position: number): Revision => {
    const before = new Map<string, Snapshot>();
    for (const update of delta) rememberView(before, update.subject_id);

    // The echo of an optimistic Action now lives in the base; drop its overlay.
    const echoed = dropOverlay(action.id, before);

    // A create opens the row and the row's components land in the same Action,
    // so a buffered later write is folded once the whole Action is in — not on
    // the first Update that makes the row exist, which would order it before
    // the components delivered with the create.
    const awaitingOrphans = [...orphans.keys()].filter((id) => index.get(id) === undefined);

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
      if (!overlaidBase.has(id)) {
        overlaidBase.set(id, baseStateOf(id) ?? { row: null, versions: {} });
      }
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

  /**
   * Eviction is a visible removal, so each dropped row journals one membership
   * change naming the model it was filed under — it leaves that set, and which
   * components it carried is not what a reader matches on.
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
    index.clear();
    values.clear();
    entryRows.clear();
    composedRows.clear();
    storeOwned.clear();
    orphans.clear();
    overlay.clear();
    overlaidBase.clear();
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
    for (const entity of record.entities) {
      // The record is a snapshot of the materialized view, so its rows are
      // adopted whole and become the replica's own data again.
      const row = withAdoptedMapFields(entity);
      const versions: Record<string, number> = {};
      for (const component of componentsOfRow(row)) {
        versions[component] =
          record.componentVersions[row.id]?.[component] ?? declaredVersion(component);
      }
      setIndexedRow(row.id, row, versions);
    }
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
    const persisted: Entity[] = [];
    const versions: Record<string, Record<string, number>> = {};
    for (const entry of index.entries()) {
      const base = overlaidBase.get(entry.id);
      const row = base === undefined ? viewOf(entry.id) : base.row;
      if (row === null) continue;
      persisted.push(withWireMapFields(row));
      const stamped = base === undefined ? entry.versions : base.versions;
      const shape: Record<string, number> = {};
      for (const component of componentsOfRow(row)) {
        shape[component] = stamped[component] ?? declaredVersion(component);
      }
      if (Object.keys(shape).length > 0) versions[row.id] = shape;
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
    let total = 0;
    let components = 0;
    for (const entry of index.entries()) {
      total += 1;
      byModel[entry.model] = (byModel[entry.model] ?? 0) + 1;
      components += entry.components.length;
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

  /**
   * The overlay's own writes, the composed views it caches, and the updates
   * waiting for a base row. All three exist only because a write is unconfirmed.
   */
  const unconfirmedWriteBytes = (): number => {
    const overlayShape: Record<string, readonly OptimisticWrite[]> = {};
    for (const [id, writes] of overlay) overlayShape[id] = writes;
    const orphanShape: Record<string, readonly OrphanUpdate[]> = {};
    for (const [id, updates] of orphans) orphanShape[id] = updates;
    let views = 0;
    for (const id of overlay.keys()) {
      const row = viewOf(id);
      if (row === null) continue;
      views += jsonBytes(envelopeShape(row));
      views += jsonBytes(row.data);
    }
    return recordBytes(overlayShape) + recordBytes(orphanShape) + views;
  };

  /** Declared version stamps on the base entries, part of the index account. */
  const versionBytes = (): number => {
    const shape: Record<string, Readonly<Record<string, number>>> = {};
    for (const entry of index.entries()) {
      const base = overlaidBase.get(entry.id);
      const stamped = base === undefined ? entry.versions : base.versions;
      if (Object.keys(stamped).length > 0) shape[entry.id] = stamped;
    }
    return recordBytes(shape);
  };

  const bytes = (): ReplicaBytes => {
    let rows = 0;
    let valueBytes = 0;
    for (const entry of index.entries()) {
      const base = overlaidBase.get(entry.id);
      const row = base === undefined ? viewOf(entry.id) : base.row;
      if (row === null) continue;
      const baseEntry = base === undefined ? entry : entryOf(row, base.versions);
      rows += envelopeBytes(baseEntry);
      valueBytes += jsonBytes(baseEntry.fields);
      if (base === undefined) {
        const extra = values.get(entry.id);
        if (extra !== undefined) valueBytes += jsonBytes(extra);
      }
    }
    const indexBytes = index.bytes() + versionBytes();
    const journalBytes = journal.length === 0 ? 0 : jsonBytes(journal);
    const unconfirmedWrites = unconfirmedWriteBytes();
    return {
      rows,
      values: valueBytes,
      index: indexBytes,
      journal: journalBytes,
      unconfirmedWrites,
      total: rows + valueBytes + indexBytes + journalBytes + unconfirmedWrites,
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
   * the composed view and nothing journals (#936). Only a value a read
   * installed may leave; a value the log folded is the replica's own data.
   */
  const dropResidentValue = (key: LeaseKey): void => {
    // A timer armed by a table a `load` has since replaced must not drop a value
    // the live table still claims.
    if (leases.isResident(key)) return;
    const id = key.entityId;
    const entry = index.get(id);
    if (entry === undefined) return;
    if (!storeOwned.get(id)?.has(key.component)) return;
    // An overlaid row's base is held apart from the value cache; expiring it
    // would need a base edit that the next derive turns back into an index
    // change. Leave it resident until the overlay clears (#975 owns the rule).
    if (overlaidBase.has(id)) return;
    const field = componentField(key.component);
    // A leaf is always resident in its entry, so no claim can take it away.
    if (entry.fields[field] !== undefined) return;
    const extra = values.get(id);
    if (extra === undefined || extra[field] === undefined) return;

    const { [field]: _dropped, ...remaining } = extra;
    if (Object.keys(remaining).length === 0) values.delete(id);
    else values.set(id, remaining);
    composedRows.delete(id);
    notify();
  };

  /** Read one component through the seam. */
  const readOne = async (id: string, component: string): Promise<Entity | null> =>
    options?.readComponent?.(id, component) ?? null;

  /** Mark the values a store read installed as lease-owned, so they may expire. */
  const ownFromStore = (id: string, components: readonly string[]): void => {
    const owned = storeOwned.get(id);
    if (owned === undefined) storeOwned.set(id, new Set(components));
    else for (const component of components) owned.add(component);
  };

  /**
   * Install a component read for `id`, then replay the writes that waited
   * behind it. A component the entry already names is a residency move: only
   * its value lands in the cache and the index is untouched. A component the
   * row does not know is a store install, which derives a whole entry.
   */
  const installComponent = (id: string, component: string, loaded: Entity): boolean => {
    const field = componentField(component);
    const adopted = withAdoptedMapFields(loaded);
    const value = adopted.data.fields[field];
    if (value === undefined) return false;

    const entry = index.get(id);
    if (entry !== undefined && entry.components.includes(component)) {
      // A leaf or platform value is already in the entry; a map value is the
      // only one a read can still install.
      if (entry.fields[field] !== undefined) {
        replayBufferedWrites(id);
        return true;
      }
      const current = values.get(id) ?? {};
      values.set(id, { ...current, [field]: value });
      composedRows.delete(id);
      ownFromStore(id, [component]);
      replayBufferedWrites(id);
      notify();
      return true;
    }

    const base = baseStateOf(id);
    const previous = base?.row ?? null;
    // The store hands over a whole row; values the replica already holds are
    // its own data, so the base wins and the install only fills what it lacks.
    const fields = { ...adopted.data.fields, ...previous?.data.fields };
    const row: Entity = {
      ...(previous ?? adopted),
      id,
      model: adopted.model,
      data: { fields },
      exists: adopted.exists,
      created_hlc: adopted.created_hlc,
      updated_hlc: adopted.updated_hlc,
      deleted_hlc: adopted.deleted_hlc,
      last_gsn: Math.max(previous?.last_gsn ?? 0, adopted.last_gsn),
    };
    const versions = versionsForRow(base?.versions ?? {}, row);
    if (overlaidBase.has(id)) {
      overlaidBase.set(id, { row, versions });
      deriveIndex(id);
    } else {
      setIndexedRow(id, row, versions);
    }
    ownFromStore(id, componentsOfRow(row));
    replayBufferedWrites(id);
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

  const isComponentResident = (id: string, component: string): boolean => {
    const row = viewOf(id);
    return row !== null && row.data.fields[componentField(component)] !== undefined;
  };

  /** Whether the replica holds a value for every component `row` carries. */
  const fullyResident = (row: Entity): boolean =>
    Object.keys(row.data.fields)
      .map((field) => fieldComponent(row.model, field))
      .every((component) => isComponentResident(row.id, component));

  const residentComponents = (id: string): readonly string[] => {
    const row = viewOf(id);
    return row === null
      ? []
      : Object.keys(row.data.fields).map((field) => fieldComponent(row.model, field));
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
    return index.get(id)?.versions[component];
  };

  return {
    get revision() {
      return revision;
    },
    get changeFloor() {
      return changeFloor;
    },
    get,
    base: (id) => {
      const base = overlaidBase.get(id);
      return base === undefined ? (viewOf(id) ?? undefined) : (base.row ?? undefined);
    },
    iterate,
    fullyResident,
    read,
    acquire,
    isComponentResident,
    residentComponents,
    componentVersion,
    changesSince,
    stats,
    bytes,
    relationships: (query: RelationshipQuery): readonly string[] => {
      if (query.sourceId !== undefined) {
        return index.edgeTargets(query.as, query.type, query.sourceId);
      }
      if (query.targetId !== undefined) {
        return index.edgeSources(query.as, query.type, query.targetId);
      }
      return [];
    },
    components: (component) => index.idsWithComponent(component),
    memberships: (query: MembershipQuery): readonly string[] => {
      if (query.groupId !== undefined) return index.groupMembers(query.groupId);
      if (query.entityId !== undefined) return index.entityGroups(query.entityId);
      return [];
    },
    membershipLinks: (entityId: string): readonly MembershipLink[] =>
      index.membershipRows(entityId).map(({ membershipId, groupId }) => ({
        membershipId,
        groupId,
      })),
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
