import {
  componentField,
  componentModel,
  EBB_MODEL_NAME,
  fieldComponent,
  isComponentUpdate,
  isRowCreate,
  linkTargets,
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
import { createLeaseTable, type LeaseKey, type LeaseTable } from "./leases";
import type {
  MaterializationPolicy,
  MembershipQuery,
  Replica,
  ReplicaChange,
  ReplicaOptions,
  ReplicaStats,
  RelationshipQuery,
  Revision,
} from "./types";

export const holdAll: MaterializationPolicy = {
  holds: () => true,
};

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
 * Mutable in-place core. `entities` is the durable base (what `toRecord`
 * persists, once on-demand components are filtered out), `overlay` composes
 * optimistic writes over it, and `effective` caches the composed view for
 * overlaid ids so a read never recomposes.
 *
 * `dormant` is the component-level half of residency (#802): components that
 * exist on a resident row but whose value the replica does not hold. A held
 * note with a lazy body has three fields and one dormant component.
 *
 * `modelIndex` indexes the base by model; `iterate` layers the overlay's model
 * overrides on top of it. `componentIndex` tracks the composed view's component
 * set alongside the adjacency indices, and is likewise derived rather than
 * persisted. The lease table is keyed `(entity, component)`, so an on-demand
 * component is fetched, evicted and released on its own, and a claim goes
 * wherever the value it kept goes: expiry, eviction, a read that installed
 * nothing, or a write that detached the component.
 */
export const createReplica = (options?: ReplicaOptions): Replica => {
  const policy = options?.materialization ?? holdAll;
  const holds = (component: string): boolean => policy.holds(component);
  const declaredVersion = (component: string): number =>
    options?.versions?.declared(component) ?? 1;

  const entities = new Map<string, Entity>();
  /** The declared version each component's value was materialized at (#804). */
  const componentVersions = new Map<string, Map<string, number>>();
  const dormant = new Map<string, Set<string>>();
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
  /**
   * Components observed on a row before the row became resident. A lazy
   * component's value is not retained, but its existence has to survive until a
   * held component makes the row resident.
   */
  const pendingPresence = new Map<string, Map<string, boolean>>();
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
   * Every component a resident row is known to carry: held values plus the
   * components whose values are not resident.
   */
  const presenceOfRow = (id: string, row: Entity): readonly string[] => {
    const components = new Set(fieldComponentsOf(row));
    const known = dormant.get(id);
    if (known !== undefined) {
      for (const component of known) components.add(component);
    }
    return [...components];
  };

  /** Whether a lease still claims `component`'s value for `id`. */
  const claimed = (id: string, component: string): boolean =>
    leases.isResident({ entityId: id, component });

  /**
   * A row is resident iff any of its components is held or claimed. A row that
   * carries no component has nothing to retain, so it stays.
   */
  const resident = (id: string, row: Entity): boolean => {
    const components = presenceOfRow(id, row);
    if (components.length === 0) return true;
    return components.some((component) => holds(component) || claimed(id, component));
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

  /**
   * Fold the writes that waited behind a read that installed nothing, rather
   * than leaving them for a read that may never come.
   */
  const replayBufferedWrites = (id: string): void => {
    const buffered = pendingWrites.get(id);
    if (buffered === undefined) return;
    pendingWrites.delete(id);
    for (const entry of buffered)
      applyBaseUpdate(entry.update, entry.gsn, entry.hlc, entry.position);
  };

  /** Drop every read in flight, so no result lands in a replaced view. */
  const cancelAllReads = (): void => {
    for (const id of inFlightReads.keys()) cancelReadsFor(id);
  };

  /** Remember a component exists without holding its value. */
  const ensureDormant = (id: string, component: string): void => {
    const components = dormant.get(id);
    if (components === undefined) dormant.set(id, new Set([component]));
    else components.add(component);
  };

  const forgetDormant = (id: string, component: string): void => {
    const components = dormant.get(id);
    if (components === undefined) return;
    components.delete(component);
    if (components.size === 0) dormant.delete(id);
  };

  const notePendingPresence = (id: string, component: string, present: boolean): void => {
    const components = pendingPresence.get(id);
    if (components === undefined) pendingPresence.set(id, new Map([[component, present]]));
    else components.set(component, present);
  };

  /** Fold components observed before the row was resident into its presence. */
  const absorbPendingPresence = (id: string): void => {
    const pending = pendingPresence.get(id);
    if (pending === undefined) return;
    pendingPresence.delete(id);
    for (const [component, present] of pending) {
      if (present) ensureDormant(id, component);
      else forgetDormant(id, component);
    }
  };

  /** Append one observable change. `components` is what the change touched. */
  const bump = (id: string, deleted: boolean, components: readonly string[]): void => {
    revision += 1;
    journal.push({ revision, id, deleted, components });
    trimJournal();
  };

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
    return row === null ? [] : presenceOfRow(id, row);
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

  /** Remove a non-held component's value from a base row and keep its existence. */
  const stripToResidency = (id: string, row: Entity): Entity => {
    let changed = false;
    const fields: Record<string, FieldValue> = {};
    for (const [field, value] of Object.entries(row.data.fields)) {
      const component = fieldComponent(row.model, field);
      if (holds(component) || claimed(id, component)) {
        fields[field] = value;
      } else {
        changed = true;
        ensureDormant(id, component);
      }
    }
    return changed ? { ...row, data: { fields } } : row;
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

    // A create names no component, so it has no version to stamp and no
    // residency to settle: it only makes the row exist.
    if (!isRowCreate(update)) {
      if (update.method === "drop") forgetVersion(id, update.component);
      else if (update.method !== "delete") {
        stampVersion(id, update.component, declaredVersion(update.component));
      }

      if (update.method !== "delete") {
        const component = update.component;
        const residentComponent = holds(component) || claimed(id, component);
        if (!residentComponent) {
          if (previous === null) {
            // A component the policy does not hold and no lease covers is not
            // retained. Its existence is all the replica remembers until a held
            // component makes the row resident.
            forgetVersion(id, component);
            notePendingPresence(id, component, update.method !== "drop");
            return;
          }
          if (update.method === "drop") forgetDormant(id, component);
          else ensureDormant(id, component);
          // The create fixes the row's model, so a component write moves nothing,
          // and a value the policy does not retain cannot reach a reader: keeping
          // it must not advance the row's metadata and re-run the model's readers.
          return;
        }
      }
    }

    const next = applyUpdate(previous, update, gsn, hlc, RESIDENT_MAP_FIELDS);

    if (next === null) {
      // An unopened on-demand row has no base here by design; the local store
      // owns the base, so keeping the update would retain body data the replica
      // is deliberately not holding.
      if (previous === null) {
        if (update.method === "delete") pendingPresence.delete(id);
        if (update.method === "drop") {
          notePendingPresence(id, update.component, false);
          bufferUpdate(orphans, { update, gsn, hlc, position });
        }
        return;
      }
      entities.delete(id);
      dormant.delete(id);
      componentVersions.delete(id);
      removeFromModel(previous.model, id);
      return;
    }

    if (previous === null) absorbPendingPresence(id);

    const stripped = stripToResidency(id, next);
    if (!resident(id, stripped)) {
      // A not-resident row is unobservable: it retains nothing and journals
      // nothing. Dropping a previously resident row is still observable, and
      // `resync` journals that removal from the composed-view comparison.
      entities.delete(id);
      dormant.delete(id);
      componentVersions.delete(id);
      if (previous !== null) removeFromModel(previous.model, id);
      else orphans.delete(id);
      return;
    }

    entities.set(id, stripped);
    if (previous !== null && previous.model !== stripped.model) removeFromModel(previous.model, id);
    addToModel(stripped.model, id);
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
    entities.set(id, stripToResidency(id, row));
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
   * indices with it. An overlay does not keep a row resident on its own: a
   * local write to an on-demand component is a write to the store's row until
   * the component is read, exactly as a remote one is.
   */
  const publish = (
    id: string,
    next: Entity | null,
    overlaid: boolean,
    previous: Snapshot,
  ): Snapshot => {
    const retained = next !== null && resident(id, next) ? next : null;
    if (overlaid) effective.set(id, retained);
    else effective.delete(id);
    const settled: Snapshot = {
      row: retained,
      components: retained === null ? [] : presenceOfRow(id, retained),
    };
    reconcileIndex(previous, settled);
    return settled;
  };

  /**
   * Settle the view after a residency move — an install or an expiry. Nothing
   * here journals: keeping or dropping a value is not a content change, so a
   * derived reader has nothing to re-run for (#936).
   */
  const refresh = (id: string, previous: Snapshot): void => {
    const { next, overlaid } = compose(id);
    publish(id, next, overlaid, previous);
    notify();
  };

  /**
   * Recompute the composed view after the base or overlay changed, bumping the
   * revision iff a reader can see the difference. `previous` is the composed
   * view captured before the change, which is what makes an echo of an
   * already-visible optimistic write a no-op for the revision.
   */
  const resync = (id: string, previous: Snapshot): void => {
    const { next, overlaid } = compose(id);
    const settled = publish(id, next, overlaid, previous);
    const retained = settled.row;

    const journalChange = (deleted: boolean, components: readonly string[]): void =>
      bump(id, deleted, components);

    if (retained === null) {
      if (next !== null) {
        journalChange(
          next.deleted_hlc !== null,
          touchedComponentSet(previous.row, previous.components, null, []),
        );
      } else if (previous.row !== null) {
        journalChange(true, touchedComponentSet(previous.row, previous.components, null, []));
      }
      return;
    }
    const touched = touchedComponentSet(
      previous.row,
      previous.components,
      retained,
      settled.components,
    );
    if (contentChanged(previous.row, retained) || touched.length > 0) {
      journalChange(retained.deleted_hlc !== null, touched);
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

  /** Remove a row's base, overlay, presence and index traces without journaling. */
  const removeRow = (id: string): void => {
    const base = entities.get(id);
    entities.delete(id);
    componentVersions.delete(id);
    dormant.delete(id);
    overlay.delete(id);
    effective.delete(id);
    orphans.delete(id);
    pendingPresence.delete(id);
    cancelReadsFor(id);
    if (base !== undefined) removeFromModel(base.model, id);
  };

  /**
   * Eviction is a visible removal, so each dropped row journals exactly like
   * a tombstone would — minus the tombstone. Traces an id leaves in the
   * overlay or orphan buffer have no row to journal, but go with it.
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
      bump(id, true, previous.components);
    }
    if (removed) notify();
    return revision;
  };

  const load = (record: ReplicaRecord): Revision => {
    if (!isValidReplicaRecord(record)) return revision;
    entities.clear();
    modelIndex.clear();
    dormant.clear();
    componentVersions.clear();
    orphans.clear();
    overlay.clear();
    effective.clear();
    pendingPresence.clear();
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
    const notResident = record.notResident ?? {};
    for (const entity of record.entities) {
      const fields: Record<string, FieldValue> = {};
      const offloaded = new Set<string>();
      for (const [field, value] of Object.entries(entity.data.fields)) {
        const component = fieldComponent(entity.model, field);
        if (holds(component)) fields[field] = value;
        else offloaded.add(component);
      }
      for (const component of notResident[entity.id] ?? []) {
        const model = componentModel(component);
        if (!holds(component) && (model === entity.model || model === EBB_MODEL_NAME)) {
          offloaded.add(component);
        }
      }
      const carried = Object.keys(entity.data.fields).length > 0 || offloaded.size > 0;
      const carriedComponents = [
        ...Object.keys(entity.data.fields).map((field) => fieldComponent(entity.model, field)),
        ...offloaded,
      ];
      const stamps = new Map<string, number>();
      for (const component of carriedComponents) {
        stamps.set(
          component,
          record.componentVersions[entity.id]?.[component] ?? declaredVersion(component),
        );
      }
      if (carried && Object.keys(fields).length === 0) {
        // The row is not resident, but an open later reads it from the store.
        if (stamps.size > 0) componentVersions.set(entity.id, stamps);
        continue;
      }
      // A row with every component held is adopted whole: the record's row is
      // the row the replica keeps, so a load does not duplicate it.
      const row =
        offloaded.size === 0
          ? withAdoptedMapFields(entity)
          : withAdoptedMapFields({ ...entity, data: { fields } });
      entities.set(row.id, row);
      addToModel(row.model, row.id);
      if (offloaded.size > 0) dormant.set(row.id, offloaded);
      const components = [
        ...Object.keys(fields).map((field) => fieldComponent(row.model, field)),
        ...offloaded,
      ];
      if (stamps.size > 0) componentVersions.set(row.id, stamps);
      presence.push({ id: row.id, components });
      for (const entry of indexEntriesFor(row)) add(reverse, entry);
      for (const entry of forwardIndexEntriesFor(row)) add(forward, entry);
    }
    // An all-on-demand row has no `entities` entry; its stamps come back here.
    for (const [id, stamps] of Object.entries(record.componentVersions)) {
      if (componentVersions.has(id)) continue;
      const entries = Object.entries(stamps);
      if (entries.length > 0) componentVersions.set(id, new Map(entries));
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
    // Values are residency, not durability: only held components persist, and a
    // resident map field leaves as the flat wire shape. A component without a
    // value still persists its existence.
    const persisted: Entity[] = [];
    const notResident: Record<string, readonly string[]> = {};
    const versions: Record<string, Record<string, number>> = {};
    for (const row of entities.values()) {
      const components = presenceOfRow(row.id, row);
      const held = components.filter(holds);
      if (components.length > 0 && held.length === 0) continue;
      const fields: Record<string, FieldValue> = {};
      for (const [field, value] of Object.entries(row.data.fields)) {
        if (holds(fieldComponent(row.model, field))) fields[field] = value;
      }
      persisted.push(withWireMapFields({ ...row, data: { fields } }));
      const offloaded = components.filter((component) => !holds(component));
      if (offloaded.length > 0) notResident[row.id] = offloaded;
      // A session-materialized component has no stamp; persist the declaration.
      const stamps: Record<string, number> = {};
      for (const component of components) {
        stamps[component] =
          componentVersions.get(row.id)?.get(component) ?? declaredVersion(component);
      }
      if (Object.keys(stamps).length > 0) versions[row.id] = stamps;
    }
    // All-on-demand rows are not in `entities`; persist their stamps here.
    for (const [id, stamps] of componentVersions) {
      if (versions[id] !== undefined || stamps.size === 0) continue;
      versions[id] = Object.fromEntries(stamps);
      notResident[id] = [...stamps.keys()];
    }
    const record: ReplicaRecord = {
      format: REPLICA_RECORD_FORMAT,
      position,
      revision,
      entities: persisted,
      componentVersions: versions,
    };
    return Object.keys(notResident).length === 0 ? record : { ...record, notResident };
  };

  const stats = (): ReplicaStats => {
    const byModel: Record<string, number> = {};
    const heldByModel: Record<string, number> = {};
    const heldComponents: Record<string, number> = {};
    const nonResidentComponents: Record<string, number> = {};
    const ids = new Set<string>(entities.keys());
    for (const [id, row] of effective) {
      if (row !== null) ids.add(id);
    }
    let total = 0;
    let heldTotal = 0;
    let components = 0;
    let residentComponents = 0;
    let nonResident = 0;

    for (const id of ids) {
      const row = viewOf(id);
      if (row === null) continue;
      total += 1;
      byModel[row.model] = (byModel[row.model] ?? 0) + 1;
      const carried = presenceOfRow(id, row);
      if (carried.length === 0 || carried.some(holds)) {
        heldByModel[row.model] = (heldByModel[row.model] ?? 0) + 1;
        heldTotal += 1;
      }
      for (const component of new Set(carried)) {
        components += 1;
        const hasValue = row.data.fields[componentField(component)] !== undefined;
        if (hasValue) residentComponents += 1;
        if (holds(component)) heldComponents[component] = (heldComponents[component] ?? 0) + 1;
        if (!hasValue) {
          nonResidentComponents[component] = (nonResidentComponents[component] ?? 0) + 1;
          nonResident += 1;
        }
      }
    }
    return {
      entities: total,
      byModel,
      held: heldTotal,
      heldByModel,
      leases: leases.stats(),
      components,
      residentComponents,
      heldComponents,
      nonResidentComponents,
      nonResident,
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
   */
  const dropResidentValue = (key: LeaseKey): void => {
    // A timer armed by a table a `load` has since replaced must not drop a value
    // the live table still claims.
    if (leases.isResident(key)) return;
    const id = key.entityId;
    const component = key.component;
    const base = entities.get(id);
    if (base === undefined || holds(component)) return;
    const field = componentField(component);
    if (base.data.fields[field] === undefined) return;
    const previous = capture(id);
    const { [field]: _released, ...fields } = base.data.fields;
    const next: Entity = { ...base, data: { fields } };
    ensureDormant(id, component);
    if (resident(id, next)) entities.set(id, next);
    else removeRow(id);
    refresh(id, previous);
  };

  /** Read one component through the seam. */
  const readOne = async (id: string, component: string): Promise<Entity | null> =>
    options?.readComponent?.(id, component) ?? null;

  /** Install a component read for `id`, replaying writes buffered behind it. */
  const installComponent = (
    id: string,
    component: string,
    loaded: Entity,
    buffered: readonly OrphanUpdate[],
  ): boolean => {
    const field = componentField(component);
    const adopted = withAdoptedMapFields(loaded);
    const value = adopted.data.fields[field];
    if (value === undefined) return false;
    const previous = capture(id);
    const base = entities.get(id) ?? null;
    const fields = { ...base?.data.fields, [field]: value };
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
    forgetDormant(id, component);
    if (base === null) absorbPendingPresence(id);
    for (const entry of buffered)
      applyBaseUpdate(entry.update, entry.gsn, entry.hlc, entry.position);
    refresh(id, previous);
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
        if (loaded === null) {
          replayBufferedWrites(id);
          return;
        }
        const buffered = pendingWrites.get(id) ?? [];
        pendingWrites.delete(id);
        installComponent(id, component, loaded, buffered);
      } catch (thrown) {
        replayBufferedWrites(id);
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
    if (holds(component)) return;
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

  const isHeld = (component: string): boolean => holds(component);

  const isRowHeld = (row: Entity): boolean =>
    presenceOfRow(row.id, row).every((component) => holds(component));

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
    isHeld,
    isRowHeld,
    read,
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
