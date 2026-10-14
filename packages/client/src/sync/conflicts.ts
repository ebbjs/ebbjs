/**
 * Conflicts — the application-facing read/resolve view over the outbox's
 * `conflicted` rows.
 *
 * A detected loser is a status plus payload on its own outbox entry
 * (#390), so there is no second durable store to cache, seed, or keep in
 * step. This module projects those rows into the entity-level
 * {@link Conflict} the application reads, publishes the set as a
 * synchronous observable for #125, and turns the application's `retry` /
 * `discard` decision into the outbox transitions that decision implies.
 *
 * Grouping is durable, not recomputed: every losing Action in one
 * connected set of subjects shares the `conflictId` detection stamped on
 * its row, so a conflict survives a reload and a partial resolution
 * without the view holding a private map.
 */

import {
  compare,
  isFieldMap,
  type Action,
  type Entity,
  type FieldValue,
  type Update,
} from "@ebbjs/core";
import type { ConflictSide, ConflictSlot, ConflictSubjectState } from "@ebbjs/storage/types";
import { subjectIds } from "./action-subjects";
import type { ConflictedOutboxEntry, OutboxCounts } from "./outbox";
import { projectFieldValue } from "./query-builder";
import { createObservable, type ReadonlyObservable } from "./observable";

/** The application's decision for one conflict. */
export type ConflictResolution = "retry" | "discard";

/**
 * A contested position with the merge's verdict at that position. The
 * stored slot stays plain; the view adds the comparison the application
 * reads.
 */
export interface ConflictSlotView extends ConflictSlot {
  /**
   * Whether the server's value wins the merge here: an absent remote, a
   * kind divergence, or — for two leaves — the higher HLC, then the
   * greater `update_id`. Mirrors `mergeFieldValue` for the position.
   */
  remoteWins(): boolean;
}

/**
 * One position that differs between a subject's before and after rows.
 * `path` is the map-key path from the field root, empty for a whole
 * non-map field. The values are projected through
 * {@link projectFieldValue}, the same rule the merge and slot sides use.
 */
export interface EntityDiff {
  /** The top-level field the differing position belongs to. */
  readonly field: string;
  /** Ordered map keys from the field root to the position; empty at the root. */
  readonly path: readonly string[];
  /** The client's projected value before the sync; `undefined` when absent. */
  readonly before: unknown;
  /** The server's projected value after the sync; `undefined` when absent. */
  readonly after: unknown;
  /** Derived from the projected values: an absent before is `added`, an absent after `removed`, else `changed`. */
  readonly kind: "changed" | "added" | "removed";
}

/**
 * The full before/after rows for one losing subject, plus the projection
 * of the positions that differ. An entity-scoped application reads this
 * rather than {@link Conflict.remoteWins}.
 */
export interface ConflictSubjectStateView extends ConflictSubjectState {
  readonly diff: readonly EntityDiff[];
}

/**
 * One losing local Action, projected from its `conflicted` outbox row.
 * A {@link Conflict} holds one or more of these, in authoring order.
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
  readonly slots: readonly ConflictSlotView[];
  /** Highest server GSN the client had applied when the Action was authored. */
  readonly basedOnGsn: number;
  /** The catch-up pass that produced this entry. */
  readonly catchUpId: string;
  /**
   * The entity-level conflict this entry belongs to. Shared by every
   * losing Action in one connected set of subjects from a single
   * catch-up pass, so grouping survives a reload.
   */
  readonly conflictId: string;
  /** Client HLC stamped at detection. The `list()` ordering key. */
  readonly detectedAtHlc: string;
}

/**
 * One application-level conflict: the set of losing Actions detected
 * together for one connected set of subjects. Resolving the conflict
 * fans out to every entry.
 */
export interface Conflict {
  /** The persisted `conflictId` shared by every entry. */
  readonly id: string;
  /** Union of the entries' losing subjects, first-seen order. */
  readonly subjects: readonly string[];
  /**
   * One state per losing subject, in the same order as
   * {@link subjects}: the client's row before the sync, the server's row
   * after it, and the positions that differ. An entity-scoped
   * application reads this — the diff answers an entity-level question,
   * while {@link remoteWins} only reports whether the merge would lose at
   * an overlapping position.
   */
  readonly subjectStates: readonly ConflictSubjectStateView[];
  /** The losing Actions, oldest detection first. */
  readonly entries: readonly ConflictEntry[];
  /**
   * `true` when any position's server value wins the merge, `false` for
   * a conflict with no slots. An application opts into "only when my
   * value would lose" by reading this.
   *
   * This answers a position-level question: with no overlapping position
   * it is `false` by construction. Entity scope asks a different one —
   * read {@link subjectStates} / the diff instead.
   */
  remoteWins(): boolean;
}

/** One entry a resolution pass could not resolve. */
export interface FailedResolution {
  /** The losing Action's id. */
  readonly entryId: string;
  /** Why the entry stayed conflicted. */
  readonly error: unknown;
}

/**
 * Per-entry results of a resolution pass. A partial failure does not
 * roll back the entries that resolved; a failed entry stays conflicted
 * and resolvable.
 */
export interface ResolveResult {
  /** Ids of the entries that resolved and left the conflict set. */
  readonly resolved: readonly string[];
  /** Entries that failed, with the error that stopped them. */
  readonly failed: readonly FailedResolution[];
}

/** Fired with the whole conflict set whenever it changes. */
export type ConflictChangeListener = (conflicts: readonly Conflict[]) => void;

/**
 * Read-only snapshot of the conflict set, the value of
 * `client.sync.conflicts`. `count` is O(1) over the view's cache, so a
 * binding that only needs the depth never materializes conflicts.
 */
export interface ConflictSnapshot {
  /** Number of conflicts awaiting resolution. */
  readonly count: number;
  /** Conflicts awaiting resolution, oldest detection first. */
  readonly conflicts: readonly Conflict[];
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
  list(): Promise<readonly Conflict[]>;
  /**
   * Depth of the conflict set from the in-memory cache. Synchronous so a
   * framework binding can read it through `useSyncExternalStore`; pair it
   * with {@link onChange} to re-read when the set changes. `0` until the
   * initial load settles.
   */
  count(): number;
  /**
   * Resolve every entry in one conflict, in authoring order. Unknown ids
   * are a no-op.
   *
   * - `retry` re-asserts each whole losing Action, freshly stamped, and
   *   re-enqueues it as pending, so non-colliding fields travel with it.
   * - `discard` drops each losing Action's optimistic writes and replays
   *   the action log, converging the affected entities on the server's
   *   view.
   */
  resolve(conflictId: string, resolution: ConflictResolution): Promise<ResolveResult>;
  /**
   * Resolve specific entries by local Action id — the per-entry
   * primitive `resolve` fans out to. Unknown ids are skipped. A failed
   * entry stays conflicted under its `conflictId`.
   */
  resolveEntries(
    entryIds: readonly string[],
    resolution: ConflictResolution,
  ): Promise<ResolveResult>;
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
   * Replace a conflicted outbox row with its freshly-stamped re-assert in
   * one durable write: durable, optimistically applied, and scheduled to
   * flush.
   */
  retry(originalId: string, action: Action): Promise<void>;
  /**
   * Drop a losing Action's optimistic writes and re-materialize every
   * entity it touched from the action log.
   */
  reMaterialize(action: Action): Promise<void>;
  /**
   * Wrap re-stamped Updates in a fresh Action (new action id, advanced
   * clock). The Action's HLC is minted here.
   */
  stampAction(updates: readonly Update[]): Action;
  /** Fresh field HLC for a re-stamped Update. */
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

/** The stamping collaborators {@link restampAction} needs. */
type Restamper = Pick<ConflictsDependencies, "stampAction" | "hlc" | "generateUpdateId">;

/**
 * Whether a side is a merge leaf (it carries an `update_id`). A map side
 * and an absent side do not; either means the position's kind diverged
 * or the server holds nothing, so the remote side takes the merge.
 */
const isLeafSide = (side: ConflictSide): boolean => side.update_id !== undefined;

/**
 * Whether the server's side wins the merge at one position, mirroring
 * `mergeFieldValue`: an absent remote or a kind divergence is a remote
 * win; two leaves compare HLC, then `update_id`.
 */
const sideRemoteWins = (slot: ConflictSlot): boolean => {
  const { local, remote } = slot;
  if (!isLeafSide(local) || !isLeafSide(remote)) return true;
  const hlcCmp = compare(local.hlc ?? "", remote.hlc ?? "");
  if (hlcCmp !== 0) return hlcCmp < 0;
  return (remote.update_id as string) >= (local.update_id as string);
};

/** Project a stored slot into its method-carrying view. */
const toSlotView = (slot: ConflictSlot): ConflictSlotView => ({
  subjectId: slot.subjectId,
  field: slot.field,
  path: slot.path,
  local: slot.local,
  remote: slot.remote,
  remoteWins: () => sideRemoteWins(slot),
});

/** Project a conflicted outbox row into the entry the application reads. */
const toEntry = (entry: ConflictedOutboxEntry): ConflictEntry => ({
  action: entry.action,
  subjects: entry.conflict.subjects,
  slots: entry.conflict.slots.map(toSlotView),
  basedOnGsn: entry.basedOnGsn,
  catchUpId: entry.conflict.catchUpId,
  conflictId: entry.conflict.conflictId,
  detectedAtHlc: entry.conflict.detectedAtHlc,
});

/** A null row contributes no fields, so the other side's fields all read as added. */
const rowFields = (entity: Entity | null): Record<string, FieldValue> => entity?.data.fields ?? {};

/**
 * Canonical string for a projected value, distinguishing an absent side
 * (`undefined`) from a tombstone (`null`). Mirrors `stableStringify` in
 * `client.ts`: object keys sorted at every level, arrays in order.
 */
const stableValueString = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(stableValueString).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableValueString(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
};

/** A position only emits when the two projected values differ. */
const projectedEqual = (before: unknown, after: unknown): boolean =>
  stableValueString(before) === stableValueString(after);

/**
 * A nested map entry that projects to `null` is a tombstone, not a
 * present value: `projectFieldValue` omits it from a map, so the diff
 * reads it as absent rather than as a changed position.
 */
const presentChild = (child: FieldValue | undefined): FieldValue | undefined =>
  child !== undefined && projectFieldValue(child) === null ? undefined : child;

/**
 * Diff one position, recursing into a pair of maps. A pair of maps
 * recurses over the sorted union of their keys, so the diff vocabulary
 * matches the merge; any other pair projects each present side and emits
 * one diff when the projected values differ.
 */
const diffFieldValue = (
  field: string,
  path: readonly string[],
  before: FieldValue | undefined,
  after: FieldValue | undefined,
  out: EntityDiff[],
): void => {
  if (before !== undefined && after !== undefined && isFieldMap(before) && isFieldMap(after)) {
    // Map keys are positions, so recurse over their sorted union.
    const keys = [...new Set([...Object.keys(before.map), ...Object.keys(after.map)])].sort();
    for (const key of keys) {
      diffFieldValue(
        field,
        [...path, key],
        presentChild(before.map[key]),
        presentChild(after.map[key]),
        out,
      );
    }
    return;
  }
  const beforeValue = before === undefined ? undefined : projectFieldValue(before);
  const afterValue = after === undefined ? undefined : projectFieldValue(after);
  if (projectedEqual(beforeValue, afterValue)) return;
  out.push({
    field,
    path,
    before: beforeValue,
    after: afterValue,
    kind: beforeValue === undefined ? "added" : afterValue === undefined ? "removed" : "changed",
  });
};

/**
 * Project a before/after pair into the positions that differ, top-level
 * fields sorted by name and paths sorted by key name. A null row reads
 * as an empty field map, so a null `before` makes every after field
 * `added`.
 */
const diffEntity = (before: Entity | null, after: Entity | null): readonly EntityDiff[] => {
  const beforeFields = rowFields(before);
  const afterFields = rowFields(after);
  const names = [...new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])].sort();
  const out: EntityDiff[] = [];
  for (const field of names) {
    diffFieldValue(field, [], beforeFields[field], afterFields[field], out);
  }
  return out;
};

/**
 * Aggregate one group's subject states, in `subjects` order. Deduped by
 * `subjectId` alone: the first state across the detection-ordered
 * entries supplies `before`, the last `after`. Every entry in a group
 * comes from one catch-up pass, so the rule is a no-op today.
 */
const aggregateSubjectStates = (
  ordered: readonly ConflictEntry[],
  subjects: readonly string[],
  statesByAction: ReadonlyMap<string, readonly ConflictSubjectState[]>,
): readonly ConflictSubjectStateView[] => {
  const bySubject = new Map<string, ConflictSubjectState>();
  for (const entry of ordered) {
    for (const state of statesByAction.get(entry.action.id) ?? []) {
      const merged = bySubject.get(state.subjectId);
      bySubject.set(
        state.subjectId,
        merged === undefined ? state : { ...merged, after: state.after },
      );
    }
  }
  const views: ConflictSubjectStateView[] = [];
  for (const subjectId of subjects) {
    const state = bySubject.get(subjectId);
    if (state === undefined) continue;
    views.push({ ...state, diff: diffEntity(state.before, state.after) });
  }
  return views;
};

/** Earliest detection HLC in a conflict; the set's ordering key. */
const earliestHlc = (conflict: Conflict): string => conflict.entries[0]?.detectedAtHlc ?? "";

/**
 * Group projected entries by their persisted `conflictId`. Entries are
 * already in outbox order; within a group they are re-sorted by
 * `detectedAtHlc`, which detection stamped in authoring order.
 */
const groupConflicts = (
  entries: readonly ConflictEntry[],
  statesByAction: ReadonlyMap<string, readonly ConflictSubjectState[]>,
): readonly Conflict[] => {
  const groups = new Map<string, ConflictEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.conflictId);
    if (group === undefined) groups.set(entry.conflictId, [entry]);
    else group.push(entry);
  }

  const conflicts: Conflict[] = [];
  for (const [id, group] of groups) {
    const ordered = [...group].sort((a, b) => compare(a.detectedAtHlc, b.detectedAtHlc));
    const subjects: string[] = [];
    const seen = new Set<string>();
    for (const entry of ordered) {
      for (const subject of entry.subjects) {
        if (seen.has(subject)) continue;
        seen.add(subject);
        subjects.push(subject);
      }
    }
    conflicts.push({
      id,
      subjects,
      subjectStates: aggregateSubjectStates(ordered, subjects, statesByAction),
      entries: ordered,
      remoteWins: () => ordered.some((e) => e.slots.some((s) => s.remoteWins())),
    });
  }
  conflicts.sort((a, b) => compare(earliestHlc(a), earliestHlc(b)));
  return conflicts;
};

/** Re-stamp one leaf with a fresh `update_id` + HLC. */
const restampField = (field: FieldValue, updateId: string, hlc: string): FieldValue => {
  if (!isFieldMap(field)) return { value: field.value, update_id: updateId, hlc };
  const map: Record<string, FieldValue> = {};
  for (const [key, child] of Object.entries(field.map)) {
    map[key] = restampField(child, updateId, hlc);
  }
  return { map };
};

/** Re-stamp every leaf the Update carries, keeping its subject and method. */
const restampUpdate = (update: Update, deps: Restamper): Update => {
  const updateId = deps.generateUpdateId();
  const hlc = deps.hlc();
  const fields = update.data?.fields;
  if (fields === undefined) return { ...update, id: updateId };
  const restamped: Record<string, FieldValue> = {};
  for (const [field, value] of Object.entries(fields)) {
    restamped[field] = restampField(value, updateId, hlc);
  }
  return { ...update, id: updateId, data: { fields: restamped } };
};

/**
 * Rebuild a losing Action freshly: every Update keeps its subject and
 * method, but every leaf is re-stamped with a fresh `update_id` + HLC and
 * the Action gets a new id + clock. Re-asserting the whole Action is what
 * carries its non-colliding fields, and what lets an entity-scope loss
 * (no overlapping slots) be rebuilt at all.
 */
const restampAction = (action: Action, deps: Restamper): Action =>
  deps.stampAction(action.updates.map((update) => restampUpdate(update, deps)));

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
  let conflicts: readonly Conflict[] = [];
  let byConflictId = new Map<string, Conflict>();
  let byEntryId = new Map<string, ConflictEntry>();
  let rehydration: Promise<void> | null = null;
  const observable = createObservable<ConflictSnapshot>({ count: 0, conflicts: [] });

  const emit = (): void => {
    observable.set({ count: conflicts.length, conflicts });
  };

  /** Re-project and regroup the outbox's conflicted rows. */
  const refresh = (): void => {
    const rows = deps.outbox.conflicts();
    entries = rows.map(toEntry);
    const statesByAction = new Map(rows.map((row) => [row.action.id, row.conflict.subjectStates]));
    conflicts = groupConflicts(entries, statesByAction);
    byConflictId = new Map(conflicts.map((conflict) => [conflict.id, conflict]));
    byEntryId = new Map(entries.map((entry) => [entry.action.id, entry]));
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

  const applyOne = async (entry: ConflictEntry, resolution: ConflictResolution): Promise<void> => {
    if (resolution === "retry") {
      // The outbox replaces the conflicted row with the fresh re-assert in
      // one durable write, so a failure leaves the conflict resolvable
      // rather than enqueuing a duplicate the next attempt would repeat.
      await deps.retry(entry.action.id, restampAction(entry.action, deps));
    } else {
      await deps.reMaterialize(entry.action);
      await deps.outbox.clearConflict(entry.action.id);
    }
  };

  /**
   * Release the pre-sync captures of every resolved subject no remaining
   * conflict still references. Reads the post-resolution entries, which
   * `clearConflict`'s change stream has already refreshed.
   */
  const releaseSubjectsAfter = (resolved: readonly Action[]): void => {
    if (resolved.length === 0) return;
    const stillConflicted = new Set<string>();
    for (const entry of byEntryId.values()) {
      for (const subjectId of subjectIds(entry.action)) stillConflicted.add(subjectId);
    }
    const released = new Set<string>();
    for (const action of resolved) {
      for (const subjectId of subjectIds(action)) {
        if (!stillConflicted.has(subjectId)) released.add(subjectId);
      }
    }
    if (released.size > 0) deps.releaseSubjects([...released]);
  };

  const resolveEntries = async (
    entryIds: readonly string[],
    resolution: ConflictResolution,
  ): Promise<ResolveResult> => {
    await rehydrate();
    const resolved: string[] = [];
    const failed: FailedResolution[] = [];
    const resolvedActions: Action[] = [];
    for (const entryId of entryIds) {
      const entry = byEntryId.get(entryId);
      if (entry === undefined) continue;
      try {
        await applyOne(entry, resolution);
        resolved.push(entryId);
        resolvedActions.push(entry.action);
      } catch (error) {
        // No rollback: a later entry still resolves, and the failed entry
        // keeps its row and `conflictId`.
        failed.push({ entryId, error });
      }
    }
    releaseSubjectsAfter(resolvedActions);
    return { resolved, failed };
  };

  const resolve = async (
    conflictId: string,
    resolution: ConflictResolution,
  ): Promise<ResolveResult> => {
    await rehydrate();
    const conflict = byConflictId.get(conflictId);
    if (conflict === undefined) return { resolved: [], failed: [] };
    return resolveEntries(
      conflict.entries.map((entry) => entry.action.id),
      resolution,
    );
  };

  void rehydrate().catch(() => {});

  const conflictsApi: Conflicts = {
    list: async () => {
      await rehydrate();
      return conflicts;
    },
    count: () => conflicts.length,
    resolve,
    resolveEntries,
    onChange: (listener) => observable.subscribe((snapshot) => listener(snapshot.conflicts)),
    rehydrate,
  };

  return { conflicts: conflictsApi, observable };
}
