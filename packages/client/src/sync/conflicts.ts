/**
 * Conflicts — the application-facing read/resolve view over the outbox's
 * `conflicted` rows.
 *
 * A detected loser is a status plus payload on its own outbox entry
 * (#390), so there is no second durable store to cache, seed, or keep in
 * step. This module projects those rows into the {@link ConflictEntry}
 * shape the application reads, publishes the count as a synchronous
 * observable for #125, and turns the application's `retry` / `discard`
 * decision into the outbox transition that decision implies.
 *
 * The projection keeps the persisted `catchUpId` / `conflictId` and the
 * slot sides, so #392 can layer entity-level grouping and `remoteWins()`
 * on top without a storage change.
 */

import { compare, isFieldMap, type Action, type FieldValue, type Update } from "@ebbjs/core";
import type { ConflictSlot } from "@ebbjs/storage/types";
import { subjectIds } from "./action-subjects";
import type { ConflictedOutboxEntry, OutboxCounts } from "./outbox";
import { createObservable, type ReadonlyObservable } from "./observable";

/** The application's decision for one conflict. */
export type ConflictResolution = "retry" | "discard";

/**
 * One losing local Action, projected from its `conflicted` outbox row.
 * The application reads this shape; `client.sync.conflicts` publishes it.
 */
export interface ConflictEntry {
  /** The losing Action, held on the outbox row for resolution. */
  readonly action: Action;
  /**
   * Subjects that actually lost. A create-plus-update write names only
   * the entity that lost, so a freshly created entity is not dragged in.
   */
  readonly subjects: readonly string[];
  /**
   * Overlapping contested positions, in detection order. Empty when the
   * entity-level scope surfaced a subject with no position overlap; an
   * application reads that as "nothing of mine would be lost".
   */
  readonly slots: readonly ConflictSlot[];
  /** Highest server GSN the client had applied when the Action was authored. */
  readonly basedOnGsn: number;
  /** The catch-up pass that produced this entry. */
  readonly catchUpId: string;
  /**
   * Stamped at detection and persisted with the row, so it survives a
   * reload and partial resolution. Grouping is the connected set of
   * losing subjects within one `catchUpId`.
   */
  readonly conflictId: string;
  /** Client HLC stamped at detection. The `list()` ordering key. */
  readonly detectedAtHlc: string;
}

/** Fired with the whole conflict set whenever it changes. */
export type ConflictChangeListener = (entries: readonly ConflictEntry[]) => void;

/**
 * Read-only snapshot of the conflict set, the value of
 * `client.sync.conflicts`. `count` is O(1) over the view's cache, so a
 * binding that only needs the depth never materializes entries.
 */
export interface ConflictSnapshot {
  /** Number of conflicts awaiting resolution. */
  readonly count: number;
  /** Conflicts awaiting resolution, oldest detection first. */
  readonly entries: readonly ConflictEntry[];
}

/**
 * The application-facing conflict surface, reachable as
 * `client.conflicts`.
 */
export interface Conflicts {
  /**
   * Conflicts awaiting resolution, oldest detection first. Awaits the
   * outbox's durable load, so a fresh client reports persisted rows.
   */
  list(): Promise<readonly ConflictEntry[]>;
  /**
   * Depth of the conflict set from the in-memory cache. Synchronous so a
   * framework binding can read it through `useSyncExternalStore`; pair it
   * with {@link onChange} to re-read when the set changes. `0` until the
   * initial load settles.
   */
  count(): number;
  /**
   * Resolve one conflict by `action.id`. Unknown ids are a no-op.
   *
   * - `retry` rebuilds a fresh Action from the losing `slots` — a fresh
   *   `update_id` + HLC per update, so they win — and re-enqueues it as
   *   pending.
   * - `discard` drops the losing Action's optimistic writes and replays
   *   the action log, converging the affected entities on the server's
   *   view.
   */
  resolve(actionId: string, resolution: ConflictResolution): Promise<void>;
  /**
   * Subscribe to conflict-set changes: a detection, a resolution, or the
   * initial durable load. Returns an unsubscribe function. Listeners are
   * isolated — a throwing listener does not affect the others.
   */
  onChange(listener: ConflictChangeListener): () => void;
  /**
   * Await the outbox's durable load. Runs eagerly at construction as a
   * single-flight operation (idempotent); returns that same promise so
   * callers can await it.
   */
  rehydrate(): Promise<void>;
}

/**
 * The outbox seam the view reads and resolves through. Narrow so the
 * view performs no durable I/O of its own.
 */
export interface ConflictOutbox {
  /** Conflicted rows in outbox order. */
  conflicts(): readonly ConflictedOutboxEntry[];
  /** The buffer's change stream, so a detection or resolution refreshes the view. */
  onChange(listener: (counts: OutboxCounts) => void): () => void;
  /** Await the buffer's durable load. */
  rehydrate(): Promise<void>;
  /** Delete a conflicted row. A no-op for an unknown or non-conflicted id. */
  clearConflict(actionId: string): Promise<void>;
}

/**
 * Collaborators the view needs. Kept narrow so the view performs no I/O
 * of its own beyond the outbox it reads.
 */
export interface ConflictsDependencies {
  /** The outbox whose conflicted rows this view projects. */
  outbox: ConflictOutbox;
  /**
   * Re-enqueue a rebased losing Action on the pending write path:
   * durable, optimistically applied, and scheduled to flush.
   */
  requeue(action: Action): Promise<void>;
  /**
   * Drop a losing Action's optimistic writes and re-materialize every
   * entity it touched from the action log.
   */
  reMaterialize(action: Action): Promise<void>;
  /**
   * Wrap rebased Updates in a fresh Action (new action id, advanced
   * clock). The Action's HLC is minted here.
   */
  stampAction(updates: readonly Update[]): Action;
  /** Fresh field HLC for a rebased Update. */
  hlc(): string;
  /** Fresh Update / FieldValue id. */
  generateUpdateId(): string;
  /**
   * Drop the pre-sync captures for subjects no remaining conflict
   * references. Called after a resolution removes its Action, so an
   * entity's backup outlives a partial resolution but is released once
   * the entity is fully resolved.
   */
  releaseSubjects(ids: readonly string[]): void;
}

/** The view plus the observable it publishes. */
export interface ConflictManager {
  readonly conflicts: Conflicts;
  /**
   * Read-only observable over the conflict set, mounted as
   * `client.sync.conflicts`. Seeded empty until the initial durable load
   * settles; fires on every detection, resolution, and that load.
   */
  readonly observable: ReadonlyObservable<ConflictSnapshot>;
}

/** The shape the view exposes, projected from a conflicted outbox row. */
const toEntry = (entry: ConflictedOutboxEntry): ConflictEntry => ({
  action: entry.action,
  subjects: entry.conflict.subjects,
  slots: entry.conflict.slots,
  basedOnGsn: entry.basedOnGsn,
  catchUpId: entry.conflict.catchUpId,
  conflictId: entry.conflict.conflictId,
  detectedAtHlc: entry.conflict.detectedAtHlc,
});

/** The stamping collaborators {@link rebaseAction} needs. */
type RebaseStamper = Pick<ConflictsDependencies, "stampAction" | "hlc" | "generateUpdateId">;

/** The field map an Update carries, tolerating a fieldless `delete`. */
const readFields = (update: Update): Readonly<Record<string, FieldValue>> =>
  update.data?.fields ?? {};

/**
 * The losing Action's value at one slot. Updates apply in order, so the
 * last write found for a slot is the one that lands — the Action was
 * authored by this client, whose HLC advances with every update.
 */
const valueAtSlot = (action: Action, slot: ConflictSlot): FieldValue | undefined => {
  let found: FieldValue | undefined;
  for (const update of action.updates) {
    if (update.subject_id !== slot.subjectId) continue;
    let node: FieldValue | undefined = readFields(update)[slot.field];
    for (const key of slot.path) {
      if (node === undefined || !isFieldMap(node)) {
        node = undefined;
        break;
      }
      node = node.map[key];
    }
    if (node !== undefined) found = node;
  }
  return found;
};

/** Re-stamp every leaf under a value with one fresh `update_id` + HLC. */
const reStamp = (field: FieldValue, updateId: string, hlc: string): FieldValue => {
  if (!isFieldMap(field)) return { value: field.value, update_id: updateId, hlc };
  const map: Record<string, FieldValue> = {};
  for (const [key, child] of Object.entries(field.map)) {
    map[key] = reStamp(child, updateId, hlc);
  }
  return { map };
};

/** Wrap a value in its map-key path, innermost key last. */
const nestValue = (leaf: FieldValue, path: readonly string[]): FieldValue =>
  path.reduceRight<FieldValue>((child, key) => ({ map: { [key]: child } }), leaf);

/** Union two map trees so sibling keys lost together travel in one patch. */
const mergeTrees = (a: FieldValue, b: FieldValue): FieldValue => {
  if (!isFieldMap(a) || !isFieldMap(b)) return b;
  const map: Record<string, FieldValue> = { ...a.map };
  for (const [key, value] of Object.entries(b.map)) {
    const previous = map[key];
    map[key] = previous === undefined ? value : mergeTrees(previous, value);
  }
  return { map };
};

/**
 * Rebuild one field's losing value. A slot at the field root re-stamps
 * the whole value; otherwise each lost leaf is nested under its map
 * path and the trees are unioned.
 */
const fieldValue = (
  slots: readonly ConflictSlot[],
  action: Action,
  updateId: string,
  hlc: string,
): FieldValue | undefined => {
  const rootSlot = slots.find((slot) => slot.path.length === 0);
  if (rootSlot !== undefined) {
    const value = valueAtSlot(action, rootSlot);
    if (value !== undefined) return reStamp(value, updateId, hlc);
  }

  let tree: FieldValue | undefined;
  for (const slot of slots) {
    if (slot.path.length === 0) continue;
    const value = valueAtSlot(action, slot);
    if (value === undefined) continue;
    const nested = nestValue(reStamp(value, updateId, hlc), slot.path);
    tree = tree === undefined ? nested : mergeTrees(tree, nested);
  }
  return tree;
};

/**
 * Rebuild the conflicting slots into one patch per subject. Each Update
 * carries a fresh `update_id` + HLC and only the slots that lost, so a
 * key the peer did not touch is left on its current value. The original
 * method is not preserved: re-stamping the losing values on top of the
 * current state is a patch whatever method first carried them.
 *
 * `null` when the Action carried no slot the conflict named.
 */
const rebaseAction = (entry: ConflictEntry, deps: RebaseStamper): Action | null => {
  const bySubject = new Map<
    string,
    { subjectId: string; subjectType: string; slots: ConflictSlot[] }
  >();
  for (const slot of entry.slots) {
    const update = entry.action.updates.find((u) => u.subject_id === slot.subjectId);
    if (update === undefined) continue;
    const key = `${update.subject_id}\u0000${update.subject_type}`;
    const subject = bySubject.get(key) ?? {
      subjectId: update.subject_id,
      subjectType: update.subject_type,
      slots: [],
    };
    subject.slots.push(slot);
    bySubject.set(key, subject);
  }

  const updates = [...bySubject.values()].map((subject): Update => {
    const updateId = deps.generateUpdateId();
    const hlc = deps.hlc();
    const fields: Record<string, FieldValue> = {};
    const byField = new Map<string, ConflictSlot[]>();
    for (const slot of subject.slots) {
      const list = byField.get(slot.field) ?? [];
      list.push(slot);
      byField.set(slot.field, list);
    }
    for (const [field, slots] of byField) {
      const value = fieldValue(slots, entry.action, updateId, hlc);
      if (value !== undefined) fields[field] = value;
    }
    return {
      id: updateId,
      subject_id: subject.subjectId,
      subject_type: subject.subjectType,
      method: "patch",
      data: { fields },
    };
  });
  if (updates.length === 0) return null;
  return deps.stampAction(updates);
};

/**
 * Build the conflict view over the outbox.
 *
 * Construction subscribes to the outbox change stream and kicks off the
 * initial load without caller involvement; a rejected load must not
 * surface as an unhandled rejection, and an awaiting caller still sees
 * it.
 */
export function createConflicts(deps: ConflictsDependencies): ConflictManager {
  let entries: readonly ConflictEntry[] = [];
  let rehydration: Promise<void> | null = null;
  const observable = createObservable<ConflictSnapshot>({ count: 0, entries: [] });

  const emit = (): void => {
    observable.set({ count: entries.length, entries });
  };

  /** Re-project the outbox's conflicted rows, oldest detection first. */
  const refresh = (): void => {
    entries = deps.outbox
      .conflicts()
      .map(toEntry)
      .sort((a, b) => compare(a.detectedAtHlc, b.detectedAtHlc));
    emit();
  };

  const rehydrate = (): Promise<void> => {
    rehydration ??= deps.outbox
      .rehydrate()
      .then(refresh)
      .catch((err: unknown) => {
        // Clear the memo so a transient failure cannot brick the cache;
        // the next call retries the load.
        rehydration = null;
        throw err;
      });
    return rehydration;
  };

  // Detection and resolution both move rows through the outbox, whose
  // change stream fires after each transition; refresh keeps the view
  // current without a poll.
  deps.outbox.onChange(refresh);

  const resolve = async (actionId: string, resolution: ConflictResolution): Promise<void> => {
    await rehydrate();
    const entry = entries.find((candidate) => candidate.action.id === actionId);
    if (entry === undefined) return;

    if (resolution === "retry") {
      // Enqueue before clearing: a durable-buffer failure must leave the
      // conflict resolvable rather than drop the user's write.
      const rebased = rebaseAction(entry, deps);
      if (rebased !== null) await deps.requeue(rebased);
    } else {
      await deps.reMaterialize(entry.action);
    }
    // `clearConflict` fires the outbox change stream, so `entries` here
    // is the post-resolution set. An entity another conflict still holds
    // stays captured.
    await deps.outbox.clearConflict(actionId);
    const stillConflicted = new Set<string>();
    for (const remaining of entries) {
      for (const subjectId of subjectIds(remaining.action)) stillConflicted.add(subjectId);
    }
    const released = subjectIds(entry.action).filter(
      (subjectId) => !stillConflicted.has(subjectId),
    );
    if (released.length > 0) deps.releaseSubjects(released);
  };

  void rehydrate().catch(() => {});

  const conflicts: Conflicts = {
    list: async () => {
      await rehydrate();
      return entries;
    },
    count: () => entries.length,
    resolve,
    onChange: (listener) => observable.subscribe((snapshot) => listener(snapshot.entries)),
    rehydrate,
  };

  return { conflicts, observable };
}
