/**
 * Conflicts — the application-facing view over the outbox's `conflicted`
 * rows.
 *
 * A detected loser is a status plus payload on its own outbox entry
 * (#390), so there is no second durable store to cache, seed, or keep in
 * step. This module projects those rows into the entity-level
 * {@link Conflict} the application reads, publishes the set as a
 * synchronous observable for #125, and turns the application's choice into
 * one of the two mechanism verbs: send the held Actions unchanged, or clear
 * them and converge on the remote view. Policy — a backup, a merge, doing
 * nothing — is application code built on the report.
 *
 * Grouping is durable, not recomputed: every losing Action in one
 * connected set of subjects shares the `conflictId` detection stamped on
 * its row, so a conflict survives a reload and a partial resolution
 * without the view holding a private map.
 */

import { compare, type Action, type Entity } from "@ebbjs/core";
import type { ConflictScope } from "@ebbjs/schema";
import type {
  ConflictHold,
  ConflictRemoteAction,
  ConflictSide,
  ConflictSlot,
  ConflictSubjectState,
} from "@ebbjs/storage/types";
import { diffEntity, type EntityDiff } from "@ebbjs/write";
import { actionTouchesHolds, holdKey } from "./conflict-holds";
import { coarsestScope } from "./conflict-slots";
import type { ConflictedOutboxEntry, OutboxCounts, OutboxEntry } from "./outbox";
import { createObservable, type ReadonlyObservable } from "./observable";

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
 * The full before/after rows for one losing subject, plus the projection
 * of the positions that differ. An entity-scoped application reads this
 * rather than the position-level slots.
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
   * Overlapping contested positions, in detection order. Present only for
   * an entry whose own scope is `"field"`: the slots and their
   * {@link ConflictSlotView.remoteWins} verdicts answer the position-level
   * question. Absent for an entity-scope entry — read
   * {@link ConflictSubjectStateView.diff} there. A group's
   * {@link Conflict.scope} is the coarsest of its entries.
   */
  readonly slots?: readonly ConflictSlotView[];
  /**
   * The positions this entry holds off the wire: one component for a
   * field- or component-scope loss, the whole subject for an entity-scope
   * loss.
   */
  readonly holds: readonly ConflictHold[];
  /** Scope detection classified this losing Action under. */
  readonly scope: ConflictScope;
  /** The concurrent missed Actions that touched this entry's losing subjects. */
  readonly remoteActions: readonly ConflictRemoteAction[];
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
  /**
   * How detection classified this conflict. `"field"` surfaced an
   * overlapping position; `"component"` surfaced any concurrent touch of a
   * component; `"entity"` surfaced any concurrent touch of a subject. An
   * entity-scope conflict has no slots — read the per-subject diff.
   */
  readonly scope: ConflictScope;
  /** Union of the entries' losing subjects, first-seen order. */
  readonly subjects: readonly string[];
  /** Union of the entries' held positions, first-seen order. */
  readonly holds: readonly ConflictHold[];
  /**
   * One state per losing subject, in the same order as
   * {@link subjects}: the client's row before the sync, the server's row
   * after it, and the positions that differ. An entity-scoped
   * application reads this — the diff answers an entity-level question,
   * while the slots only report overlapping positions.
   */
  readonly subjectStates: readonly ConflictSubjectStateView[];
  /** The losing Actions, oldest detection first. */
  readonly entries: readonly ConflictEntry[];
  /**
   * The concurrent missed Actions that made this a conflict: actor, action
   * id, and server GSN. Deduped by action id, first-seen across the
   * conflict's entries (each entry's own list is in window order). The
   * rest of the remote context rides each entry's
   * {@link ConflictEntry.action} and {@link ConflictEntry.basedOnGsn}.
   */
  readonly remoteActions: readonly ConflictRemoteAction[];
}

/** One entry a resolution pass could not resolve. */
export interface FailedResolution {
  /** The losing Action's id. */
  readonly entryId: string;
  /** Why the entry stayed conflicted. */
  readonly error: unknown;
}

/**
 * Per-entry results of a verb pass. A partial failure does not roll back
 * the entries that resolved; a failed entry stays conflicted and
 * resolvable.
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
   * Send every held Action in one conflict: clear the component hold and
   * submit the held Actions unchanged, in authoring order. Their ids,
   * Update ids, and field HLCs are untouched — re-stamping would rewrite
   * provenance on an append-only log. An application that wants its scalar
   * value to win writes it again through `defineAction` with a fresh clock.
   *
   * Per-entry failures are returned in {@link ResolveResult.failed}. A
   * durable-store fault in the pass's final flush rejects instead: the rows
   * already moved stay moved, and the fault surfaces through the outbox.
   * Unknown ids are a no-op.
   */
  sendLocalActions(conflictId: string): Promise<ResolveResult>;
  /**
   * Clear every held Action in one conflict: drop its optimistic writes and
   * converge the affected subjects on the remote view. The local writes the
   * hold was keeping off the wire are dropped with it — otherwise the
   * subject could not converge. Pending writes to unaffected subjects and
   * writes made after the hold lifted are untouched. A subject still named
   * by a failed entry stays held and keeps its writes; retry the clear for
   * it. Unknown ids are a no-op.
   *
   * Per-entry failures are returned in {@link ResolveResult.failed}. A
   * durable-store fault in the pass's final drop or re-materialize rejects
   * instead: the rows already moved stay moved.
   */
  clearLocalActions(conflictId: string): Promise<ResolveResult>;
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
  /**
   * Clear a conflicted row's hold, returning it to `pending` with its
   * Action unchanged. A no-op for an unknown or non-conflicted id.
   */
  releaseConflict(actionId: string): Promise<void>;
  /**
   * Snapshot the `pending` writes the current component hold excludes, so a
   * clear can drop exactly those and never a write made after the hold
   * lifted.
   */
  heldPending(holds: readonly ConflictHold[]): readonly OutboxEntry[];
  /**
   * Delete the named `pending` writes and return their Actions so the
   * caller can revert their optimistic overlays. `acknowledged` rows are
   * already on the server and are never dropped.
   */
  dropHeld(actionIds: readonly string[]): Promise<readonly Action[]>;
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
   * Drop a losing Action's optimistic writes and re-materialize every
   * entity it touched from the action log.
   */
  reMaterialize(action: Action): Promise<void>;
  /**
   * Send the flushable queue after a verb pass: the released held Actions,
   * and any pending writes to those subjects that the hold was blocking.
   */
  flush(): Promise<void>;
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

/**
 * The `before` row of the entity's earliest unresolved conflict, or
 * `null` when no unresolved conflict references it. `list()` orders
 * conflicts by earliest detection HLC, so the first match is the
 * earliest; a conflict whose `before` is `null` yields `null`. Backs
 * `duplicate({ at: "preSync" })`.
 */
export const findPreSyncRow = async (
  conflicts: Conflicts,
  entityId: string,
): Promise<Entity | null> => {
  for (const conflict of await conflicts.list()) {
    const state = conflict.subjectStates.find((candidate) => candidate.subjectId === entityId);
    if (state !== undefined) return state.before;
  }
  return null;
};

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
  component: slot.component,
  path: slot.path,
  local: slot.local,
  remote: slot.remote,
  remoteWins: () => sideRemoteWins(slot),
});

/** Project a conflicted outbox row into the entry the application reads. */
const toEntry = (entry: ConflictedOutboxEntry): ConflictEntry => {
  // A row written before IndexedDB schema v10 carries neither field. It is
  // still a field-scope conflict with no recorded remote context, not a
  // reason to make the whole view unreachable.
  const scope = entry.conflict.scope ?? "field";
  return {
    action: entry.action,
    subjects: entry.conflict.subjects,
    slots: scope === "entity" ? undefined : entry.conflict.slots.map(toSlotView),
    holds: entry.conflict.holds,
    scope,
    remoteActions: entry.conflict.remoteActions ?? [],
    basedOnGsn: entry.basedOnGsn,
    catchUpId: entry.conflict.catchUpId,
    conflictId: entry.conflict.conflictId,
    detectedAtHlc: entry.conflict.detectedAtHlc,
  };
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

/** First value per key, in first-seen order. */
const unionBy = <T>(values: readonly T[], keyOf: (value: T) => string): T[] => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
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
    const subjects = unionBy(
      ordered.flatMap((entry) => entry.subjects),
      (subject) => subject,
    );
    const holds = unionBy(
      ordered.flatMap((entry) => entry.holds),
      holdKey,
    );
    const remoteActions = unionBy(
      ordered.flatMap((entry) => entry.remoteActions),
      (remote) => remote.actionId,
    );
    conflicts.push({
      id,
      scope: coarsestScope(ordered.map((entry) => entry.scope)),
      subjects,
      holds,
      subjectStates: aggregateSubjectStates(ordered, subjects, statesByAction),
      entries: ordered,
      remoteActions,
    });
  }
  conflicts.sort((a, b) => compare(earliestHlc(a), earliestHlc(b)));
  return conflicts;
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
  let conflicts: readonly Conflict[] = [];
  let byConflictId = new Map<string, Conflict>();
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

  // Detection and a verb pass both move rows through the outbox, whose
  // change stream fires after each transition; refresh keeps the view
  // current without a poll.
  deps.outbox.onChange(refresh);

  /** Which of the two mechanism verbs a pass applies. */
  type Verb = "send" | "clear";

  const applyOne = async (entry: ConflictEntry, verb: Verb): Promise<void> => {
    if (verb === "send") {
      // The Action is submitted verbatim; the outbox keeps the entry's
      // action id, Update ids, and field HLCs untouched.
      await deps.outbox.releaseConflict(entry.action.id);
      return;
    }
    await deps.reMaterialize(entry.action);
    await deps.outbox.clearConflict(entry.action.id);
  };

  /**
   * Apply one verb to every entry of a conflict. A per-entry failure is
   * recorded and the rest still run. Sending flushes once after the whole
   * group left the hold, so a grouped conflict's Actions leave together;
   * clearing also drops the writes the hold was blocking and
   * re-materializes each, so every affected subject converges.
   */
  const applyVerb = async (conflict: Conflict, verb: Verb): Promise<ResolveResult> => {
    await rehydrate();
    // Snapshot the held writes before the conflicted rows move. A write
    // enqueued after this point was never held, so a clear must not drop it.
    const held = verb === "clear" ? deps.outbox.heldPending(conflict.holds) : [];
    const resolved: string[] = [];
    const failed: FailedResolution[] = [];
    for (const entry of conflict.entries) {
      const entryId = entry.action.id;
      try {
        await applyOne(entry, verb);
        resolved.push(entryId);
      } catch (error) {
        // No rollback: a later entry still resolves, and the failed entry
        // keeps its row and `conflictId`.
        failed.push({ entryId, error });
      }
    }
    if (verb === "clear") {
      // Drop the snapshot rows for the positions this pass actually
      // released. A position a failed entry still holds keeps its writes;
      // an Action spanning both is dropped whole, because it cannot be sent
      // in part.
      const stillHeld = new Set(
        deps.outbox
          .conflicts()
          .flatMap((row) => row.conflict.holds)
          .map(holdKey),
      );
      const released = conflict.holds.filter((hold) => !stillHeld.has(holdKey(hold)));
      const toDrop = held.filter((entry) => actionTouchesHolds(entry.action, released));
      if (toDrop.length > 0) {
        const dropped = await deps.outbox.dropHeld(toDrop.map((entry) => entry.action.id));
        for (const action of dropped) await deps.reMaterialize(action);
      }
    } else if (resolved.length > 0) {
      await deps.flush();
    }
    return { resolved, failed };
  };

  const sendLocalActions = async (conflictId: string): Promise<ResolveResult> => {
    await rehydrate();
    const conflict = byConflictId.get(conflictId);
    if (conflict === undefined) return { resolved: [], failed: [] };
    return applyVerb(conflict, "send");
  };

  const clearLocalActions = async (conflictId: string): Promise<ResolveResult> => {
    await rehydrate();
    const conflict = byConflictId.get(conflictId);
    if (conflict === undefined) return { resolved: [], failed: [] };
    return applyVerb(conflict, "clear");
  };

  void rehydrate().catch(() => {});

  const conflictsApi: Conflicts = {
    list: async () => {
      await rehydrate();
      return conflicts;
    },
    count: () => conflicts.length,
    sendLocalActions,
    clearLocalActions,
    onChange: (listener) => observable.subscribe((snapshot) => listener(snapshot.conflicts)),
    rehydrate,
  };

  return { conflicts: conflictsApi, observable };
}
