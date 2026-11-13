import {
  componentField,
  componentModel,
  componentName,
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
  forwardIndexEntryFor,
  forwardIndexKey,
  forwardMembershipIndexKey,
  indexEntryFor,
  liveMembershipLinks,
  liveRelationshipLinks,
  liveSourceIds,
  membershipIndexKey,
  reverseIndexDelta,
  reverseIndexKey,
  type IndexEntry,
  type ReverseIndex,
} from "../internal/reverse-index";
import type {
  MembershipLink,
  RelationshipLink,
  RelationshipSourceQuery,
} from "../types/entity-store";
import type { ReplicaRecord } from "../types/replica-store";

import { contentChanged } from "./content-changed";
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

const DEFAULT_JOURNAL_CAPACITY = 1024;
export const DEFAULT_PINNED_CAPACITY = 16;
export const DEFAULT_PINNED_TTL_MS = 30_000;

/**
 * A capacity that retains everything is `Infinity`, so the trimmer never finds
 * an excess. Non-positive and non-finite values are unbounded by contract.
 */
const capacityOf = (capacity: number | undefined, fallback: number): number => {
  if (capacity === undefined) return fallback;
  if (!Number.isFinite(capacity) || capacity <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(capacity));
};

/** `Infinity` disables TTL release, so no timer is armed at all. */
const pinnedTtlOf = (ttlMs: number | undefined): number => {
  if (ttlMs === undefined) return DEFAULT_PINNED_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return Number.POSITIVE_INFINITY;
  return ttlMs;
};

/** A pending pin must not keep a Node process alive. */
const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
};

/** `(entity, component)` is the pin key; the separator cannot occur in either. */
const PIN_SEPARATOR = "\u0000";
const pinKey = (id: string, component: string): string => `${id}${PIN_SEPARATOR}${component}`;
const pinIdOf = (key: string): string => key.slice(0, key.indexOf(PIN_SEPARATOR));
const pinComponentOf = (key: string): string => key.slice(key.indexOf(PIN_SEPARATOR) + 1);
/** The row a pin key or a whole-row open key addresses. */

interface Pin {
  /** Whether the component is currently open; a closed pin waits out its TTL. */
  open: boolean;
  /** `null` while open, or when TTL release is disabled. */
  timer: ReturnType<typeof setTimeout> | null;
}

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

/**
 * Mutable in-place core. `entities` is the durable base (what `toRecord`
 * persists, once pinned components are filtered out), `overlay` composes
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
 * persisted. Pins are keyed `(entity, component)`, so an on-demand component is
 * fetched, evicted and TTL-released on its own.
 */
export const createReplica = (options?: ReplicaOptions): Replica => {
  const policy = options?.materialization ?? holdAll;
  const holds = (component: string): boolean => policy.holds(component);

  const entities = new Map<string, Entity>();
  const dormant = new Map<string, Set<string>>();
  const modelIndex = new Map<string, Set<string>>();
  let componentIndex: ComponentIndex = new Map();
  const overlay = new Map<string, OptimisticWrite[]>();
  const effective = new Map<string, Entity | null>();
  const orphans = new Map<string, OrphanUpdate[]>();
  const journalCapacity = capacityOf(options?.journalCapacity, DEFAULT_JOURNAL_CAPACITY);
  const pinnedCapacity = capacityOf(options?.pinnedCapacity, DEFAULT_PINNED_CAPACITY);
  const pinnedTtlMs = pinnedTtlOf(options?.pinnedTtlMs);
  // Iteration order is LRU order: a touch deletes and re-adds, so the first
  // key is the oldest pin.
  const pins = new Map<string, Pin>();
  const inFlightOpens = new Map<string, Promise<Entity | null>>();
  /** Cancels a cold read whose component was closed or evicted while it was loading. */
  const openEpochs = new Map<string, number>();
  let nextOpenEpoch = 0;
  /** Updates that landed for a row while a cold read was in flight. */
  const pendingOpens = new Map<string, OrphanUpdate[]>();
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

  // Adjacency over the composed view, not the base map: traversal must see
  // optimistic edges. Both directions share the index module's entry
  // derivation, so the replica cannot drift from the adapters.
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

  /** Present components of a row's field map, under the row's own model. */
  const fieldComponentsOf = (row: Entity): readonly string[] =>
    Object.keys(row.data.fields).map((field) => componentName(row.type, field));

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

  const pinsOf = (id: string): readonly string[] => {
    const keys: string[] = [];
    for (const key of pins.keys()) {
      if (pinIdOf(key) === id) keys.push(key);
    }
    return keys;
  };

  const hasOpenInFlight = (id: string): boolean => {
    for (const key of inFlightOpens.keys()) {
      if (pinIdOf(key) === id) return true;
    }
    return false;
  };

  /**
   * A row is resident iff any of its components is held, or the row is pinned.
   * A row that carries no component has nothing to retain, so it stays.
   */
  const resident = (id: string, row: Entity): boolean => {
    const components = presenceOfRow(id, row);
    if (components.length === 0) return true;
    if (pinsOf(id).length > 0) return true;
    return components.some(holds);
  };

  const cancelOpen = (key: string): void => {
    if (!inFlightOpens.has(key)) return;
    inFlightOpens.delete(key);
    pendingOpens.delete(pinIdOf(key));
    openEpochs.set(key, ++nextOpenEpoch);
  };

  const cancelOpensFor = (id: string): void => {
    for (const key of inFlightOpens.keys()) {
      if (pinIdOf(key) === id) cancelOpen(key);
    }
    pendingOpens.delete(id);
  };

  const dropPin = (key: string): void => {
    const pin = pins.get(key);
    if (pin === undefined) return;
    if (pin.timer !== null) clearTimeout(pin.timer);
    pins.delete(key);
  };

  const dropPinsFor = (id: string): void => {
    for (const key of pinsOf(id)) dropPin(key);
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
    // The base index answers for every composed row, and the overlay can move a
    // row between models without touching the base, so its overrides win.
    const ids = new Set(modelIndex.get(model) ?? []);
    for (const [id, row] of effective) {
      if (row !== null && row.type === model) ids.add(id);
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

  /** Drop dormant names the row's current model cannot carry. */
  const dropStaleDormant = (id: string, type: string): void => {
    const known = dormant.get(id);
    if (known === undefined) return;
    for (const component of known) {
      const model = componentModel(component);
      if (model !== type && model !== "ebb") known.delete(component);
    }
    if (known.size === 0) dormant.delete(id);
  };

  /** Remove a non-held component's value from a base row and keep its existence. */
  const stripToResidency = (id: string, row: Entity): Entity => {
    dropStaleDormant(id, row.type);
    let changed = false;
    const fields: Record<string, FieldValue> = {};
    for (const [field, value] of Object.entries(row.data.fields)) {
      const component = componentName(row.type, field);
      if (holds(component) || pins.has(pinKey(id, component))) {
        fields[field] = value;
      } else {
        changed = true;
        ensureDormant(id, component);
      }
    }
    return changed ? { ...row, data: { fields } } : row;
  };

  /** Drop pins that the composed view no longer justifies: absent or now held. */
  const dropStalePins = (id: string, components: readonly string[]): void => {
    const present = new Set(components);
    for (const key of pinsOf(id)) {
      const component = pinComponentOf(key);
      if (!present.has(component) || holds(component)) dropPin(key);
    }
  };

  const applyBaseUpdate = (update: Update, gsn: number, hlc: string, position: number): void => {
    const id = update.subject_id;
    const previous = entities.get(id) ?? null;

    // The local store row is read asynchronously; keep updates that land while
    // that read is in flight so the install replays them instead of hiding
    // them behind a snapshot taken before they arrived.
    if (hasOpenInFlight(id)) {
      bufferUpdate(pendingOpens, { update, gsn, hlc, position });
      return;
    }

    if (update.method !== "delete") {
      const component = update.component;
      const residentComponent = holds(component) || pins.has(pinKey(id, component));
      if (!residentComponent) {
        if (previous === null) {
          // A component the policy does not hold and no pin covers is not
          // retained. Its existence is all the replica remembers until a held
          // component makes the row resident.
          notePendingPresence(id, component, update.method !== "drop");
          return;
        }
        const sameModel = componentModel(component) === previous.type;
        if (update.method === "drop") forgetDormant(id, component);
        else ensureDormant(id, component);
        // A write in the row's own model changes no retained value, so it must
        // not advance the row's metadata and invalidate every reader of the
        // model. A write naming another model moves the row and falls through.
        if (sameModel) return;
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
      removeFromModel(previous.type, id);
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
      if (previous !== null) removeFromModel(previous.type, id);
      else orphans.delete(id);
      return;
    }

    entities.set(id, stripped);
    if (previous !== null && previous.type !== stripped.type) removeFromModel(previous.type, id);
    addToModel(stripped.type, id);

    if (previous === null) {
      const pending = orphans.get(id);
      if (pending !== undefined) {
        orphans.delete(id);
        // Replay what the store's gsn-ordered replay would: only Updates newer
        // than the row's first write survive; older ones are subsumed by it.
        const survivors = pending
          .filter((orphan) => orphan.gsn > gsn)
          .sort((a, b) => a.gsn - b.gsn);
        let row = stripped;
        for (const orphan of survivors) {
          row = applyUpdate(row, orphan.update, orphan.gsn, orphan.hlc, RESIDENT_MAP_FIELDS) ?? row;
        }
        if (row !== stripped) {
          const residentRow = stripToResidency(id, row);
          entities.set(id, residentRow);
          if (stripped.type !== residentRow.type) {
            removeFromModel(stripped.type, id);
            addToModel(residentRow.type, id);
          }
        }
      }
    }
  };

  /**
   * Every derived index tracks the composed view, so they must be reconciled
   * wherever that view changes — which is why this hangs off `resync`, the
   * one place every base, overlay, drop and tombstone write already funnels
   * through.
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

  /**
   * Recompute the composed view after the base or overlay changed, bumping the
   * revision iff a reader can see the difference. `previous` is the composed
   * view captured before the change, which is what makes an echo of an
   * already-visible optimistic write a no-op for the revision.
   */
  const resync = (id: string, previous: Snapshot): void => {
    const base = entities.get(id) ?? null;
    const writes = overlay.get(id);
    let next = base;
    if (writes !== undefined) {
      for (const write of writes) {
        next = applyUpdate(next, write.update, 0, write.hlc, RESIDENT_MAP_FIELDS);
      }
    }
    const nextComponents = next === null ? [] : presenceOfRow(id, next);
    // A pin belongs to the base row, not to the composed view: a local drop
    // overlay can hide a component for a moment without releasing the value the
    // base still holds. A pin for a component the base no longer carries — or
    // that the policy now holds — is not a pin.
    const baseComponents = base === null ? [] : presenceOfRow(id, base);
    dropStalePins(id, baseComponents);

    const overlaid = writes !== undefined && writes.length > 0;
    // An overlay does not keep a row resident on its own: a local write to an
    // on-demand component is a write to the store's row until the component is
    // opened, exactly as a remote one is.
    const retained = next !== null && resident(id, next) ? next : null;
    const nextSnapshot: Snapshot = {
      row: retained,
      components: retained === null ? [] : nextComponents,
    };

    if (overlaid) effective.set(id, retained);
    else effective.delete(id);

    // A row that left the replica — or that the policy now holds outright —
    // must not leave a phantom pin behind.
    if (retained === null) dropPinsFor(id);

    reconcileIndex(previous, nextSnapshot);

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
      nextSnapshot.components,
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

    for (const update of delta) applyBaseUpdate(update, action.gsn, action.hlc, position);
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
    dormant.delete(id);
    overlay.delete(id);
    effective.delete(id);
    orphans.delete(id);
    pendingPresence.delete(id);
    pendingOpens.delete(id);
    cancelOpensFor(id);
    dropPinsFor(id);
    if (base !== undefined) removeFromModel(base.type, id);
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
    orphans.clear();
    overlay.clear();
    effective.clear();
    pendingOpens.clear();
    pendingPresence.clear();
    inFlightOpens.clear();
    openEpochs.clear();
    for (const key of pins.keys()) dropPin(key);
    journal.length = 0;
    journalStart = 0;
    // One linear pass rebuilds the base, both adjacency directions, and
    // component existence; the derived indices are not persisted. Mutating the local
    // row maps keeps the rebuild linear where folding `applyIndexDelta` per
    // row would copy the whole key space each time.
    const reverse: Record<string, Record<string, string>> = {};
    const forward: Record<string, Record<string, string>> = {};
    const add = (index: Record<string, Record<string, string>>, entry: IndexEntry): void => {
      const rows = index[entry.key];
      if (rows === undefined) index[entry.key] = { [entry.rowId]: entry.value };
      else rows[entry.rowId] = entry.value;
    };
    const presence: { id: string; components: readonly string[] }[] = [];
    const notResident = record.notResident ?? {};
    for (const entity of record.entities) {
      const fields: Record<string, FieldValue> = {};
      const offloaded = new Set<string>();
      for (const [field, value] of Object.entries(entity.data.fields)) {
        const component = componentName(entity.type, field);
        if (holds(component)) fields[field] = value;
        else offloaded.add(component);
      }
      for (const component of notResident[entity.id] ?? []) {
        const model = componentModel(component);
        if (!holds(component) && (model === entity.type || model === "ebb")) {
          offloaded.add(component);
        }
      }
      const carried = Object.keys(entity.data.fields).length > 0 || offloaded.size > 0;
      if (carried && Object.keys(fields).length === 0) continue;
      // A row with every component held is adopted whole: the record's row is
      // the row the replica keeps, so a load does not duplicate it.
      const row =
        offloaded.size === 0
          ? withAdoptedMapFields(entity)
          : withAdoptedMapFields({ ...entity, data: { fields } });
      entities.set(row.id, row);
      addToModel(row.type, row.id);
      if (offloaded.size > 0) dormant.set(row.id, offloaded);
      const components = [
        ...Object.keys(fields).map((field) => componentName(row.type, field)),
        ...offloaded,
      ];
      presence.push({ id: row.id, components });
      const reverseEntry = indexEntryFor(row);
      if (reverseEntry !== null) add(reverse, reverseEntry);
      const forwardEntry = forwardIndexEntryFor(row);
      if (forwardEntry !== null) add(forward, forwardEntry);
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
    for (const row of entities.values()) {
      const components = presenceOfRow(row.id, row);
      const held = components.filter(holds);
      if (components.length > 0 && held.length === 0) continue;
      const fields: Record<string, FieldValue> = {};
      for (const [field, value] of Object.entries(row.data.fields)) {
        if (holds(componentName(row.type, field))) fields[field] = value;
      }
      persisted.push(withWireMapFields({ ...row, data: { fields } }));
      const offloaded = components.filter((component) => !holds(component));
      if (offloaded.length > 0) notResident[row.id] = offloaded;
    }
    const record: ReplicaRecord = {
      format: REPLICA_RECORD_FORMAT,
      position,
      revision,
      entities: persisted,
    };
    return Object.keys(notResident).length === 0 ? record : { ...record, notResident };
  };

  const stats = (): ReplicaStats => {
    const byType: Record<string, number> = {};
    const heldByType: Record<string, number> = {};
    const heldComponents: Record<string, number> = {};
    const pinnedComponents: Record<string, number> = {};
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
      byType[row.type] = (byType[row.type] ?? 0) + 1;
      const carried = presenceOfRow(id, row);
      if (carried.length === 0 || carried.some(holds)) {
        heldByType[row.type] = (heldByType[row.type] ?? 0) + 1;
        heldTotal += 1;
      }
      for (const component of new Set(carried)) {
        components += 1;
        const hasValue = row.data.fields[componentField(component)] !== undefined;
        if (hasValue) residentComponents += 1;
        if (holds(component)) heldComponents[component] = (heldComponents[component] ?? 0) + 1;
        if (pins.has(pinKey(id, component))) {
          pinnedComponents[component] = (pinnedComponents[component] ?? 0) + 1;
        }
        if (!hasValue) {
          nonResidentComponents[component] = (nonResidentComponents[component] ?? 0) + 1;
          nonResident += 1;
        }
      }
    }
    return {
      entities: total,
      byType,
      held: heldTotal,
      heldByType,
      pinned: pins.size,
      components,
      residentComponents,
      heldComponents,
      pinnedComponents,
      nonResidentComponents,
      nonResident,
      revision,
      position: lastPosition,
      changes: retainedChanges(),
      changeFloor,
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

  /** Set a pin without trimming, so a multi-component install settles as one. */
  const pinComponent = (id: string, component: string): void => {
    const key = pinKey(id, component);
    dropPin(key);
    pins.set(key, { open: true, timer: null });
  };

  /**
   * Release a component's value: the pin goes, the value leaves the base, and
   * the component stays known to exist. A row with nothing left to retain is
   * evicted.
   */
  const releaseComponent = (id: string, component: string): void => {
    const key = pinKey(id, component);
    if (!pins.has(key)) return;
    dropPin(key);
    const previous = capture(id);
    const base = entities.get(id);
    if (base === undefined) return;
    let next = base;
    if (!holds(component)) {
      const field = componentField(component);
      if (base.data.fields[field] !== undefined) {
        const { [field]: _released, ...fields } = base.data.fields;
        next = { ...base, data: { fields } };
        ensureDormant(id, component);
      }
    }
    if (!resident(id, next)) {
      removeRow(id);
      reconcileIndex(previous, { row: null, components: [] });
      if (previous.row !== null) bump(id, true, previous.components);
    } else {
      entities.set(id, next);
      resync(id, previous);
    }
    notify();
  };

  /** Release the least recently opened components past the configured window. */
  const trimPins = (): void => {
    while (pins.size > pinnedCapacity) {
      const oldest = pins.keys().next();
      if (oldest.done === true) return;
      releaseComponent(pinIdOf(oldest.value), pinComponentOf(oldest.value));
    }
  };

  /** Mark a component as the most recently opened and trim the window. */
  const openPin = (id: string, component: string): void => {
    if (holds(component)) return;
    pinComponent(id, component);
    trimPins();
  };

  const closePin = (id: string, component: string): void => {
    const pin = pins.get(pinKey(id, component));
    if (pin === undefined || !pin.open) return;
    pin.open = false;
    if (!Number.isFinite(pinnedTtlMs)) {
      releaseComponent(id, component);
      return;
    }
    pin.timer = setTimeout(() => releaseComponent(id, component), pinnedTtlMs);
    unrefTimer(pin.timer);
  };

  /** Read one component through the seam. */
  const readOne = async (id: string, component: string): Promise<Entity | null> =>
    options?.readComponent?.(id, component) ?? null;

  /** Install a component read for `id`, pinning it and replaying buffered writes. */
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
      type: loaded.type,
      data: { fields },
      exists: loaded.exists,
      created_hlc: loaded.created_hlc,
      updated_hlc: loaded.updated_hlc,
      deleted_hlc: loaded.deleted_hlc,
      last_gsn: Math.max(base?.last_gsn ?? 0, loaded.last_gsn),
    };
    entities.set(id, row);
    addToModel(row.type, id);
    forgetDormant(id, component);
    if (base === null) absorbPendingPresence(id);
    if (!holds(component)) pinComponent(id, component);
    for (const entry of buffered)
      applyBaseUpdate(entry.update, entry.gsn, entry.hlc, entry.position);
    trimPins();
    resync(id, previous);
    notify();
    return true;
  };

  const openComponent = (id: string, component: string): Promise<Entity | null> => {
    const view = get(id);
    if (holds(component)) return Promise.resolve(view ?? null);
    if (view !== undefined) {
      const field = componentField(component);
      if (view.data.fields[field] !== undefined || pins.has(pinKey(id, component))) {
        // Re-opening a resident component only touches the LRU window.
        openPin(id, component);
        return Promise.resolve(get(id) ?? view);
      }
    }
    const key = pinKey(id, component);
    const pending = inFlightOpens.get(key);
    if (pending !== undefined) return pending;
    const epoch = ++nextOpenEpoch;
    openEpochs.set(key, epoch);
    const read = readOne(id, component).then(
      (loaded) => {
        if (inFlightOpens.get(key) === read) inFlightOpens.delete(key);
        // A close or eviction while the read was in flight wins: the component
        // does not reappear behind the caller's back.
        if (openEpochs.get(key) !== epoch) return null;
        if (loaded === null) return null;
        const buffered = pendingOpens.get(id) ?? [];
        pendingOpens.delete(id);
        return installComponent(id, component, loaded, buffered) ? (get(id) ?? null) : null;
      },
      (error: unknown) => {
        if (inFlightOpens.get(key) === read) inFlightOpens.delete(key);
        throw error;
      },
    );
    inFlightOpens.set(key, read);
    return read;
  };

  const open = (id: string, component: string): Promise<Entity | null> =>
    openComponent(id, component);

  const close = (id: string, component: string): void => {
    cancelOpen(pinKey(id, component));
    if (!pins.has(pinKey(id, component))) return;
    closePin(id, component);
  };

  const isOpen = (id: string, component: string): boolean =>
    pins.get(pinKey(id, component))?.open === true;

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
    open,
    close,
    isOpen,
    isComponentResident,
    residentComponents,
    changesSince,
    stats,
    relationships: (query: RelationshipQuery): readonly string[] => {
      if (query.sourceId !== undefined) {
        return liveSourceIds(forwardIndex[forwardIndexKey(query.as, query.type, query.sourceId)]);
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
    relationshipLinks: (query: RelationshipSourceQuery): readonly RelationshipLink[] =>
      liveRelationshipLinks(forwardIndex[forwardIndexKey(query.as, query.type, query.sourceId)]),
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
