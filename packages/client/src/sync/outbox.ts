/**
 * Outbox — the local write buffer sitting between callers and the
 * `/sync/actions` network path.
 *
 * Every locally-authored Action is `enqueue`d — persisted to the
 * injected `OutboxStore`, appended to the in-memory queue, and
 * optimistically applied to the local cache — and then `flush`ed to
 * the server. The store is durable, so construction rehydrates buffered
 * entries back into the queue.
 *
 * An entry's life is a small state machine:
 *
 * ```
 * enqueue ─► pending ─(flush accepted)─► acknowledged ─(own echo)─► removed
 *               │                            │
 *               │ (flush rejected)           │ (a reload loads it only to
 *               ▼                            │  await the echo)
 *             error ─(retry)─► pending       │
 * ```
 *
 * `noteInbound` drives the echo leg: the single inbound funnel
 * (`SyncClient._applyAction`) hands every received Action here, and an
 * Action that matches a buffered entry with a server GSN proves the
 * entry is in the canonical log and removes it. Detection is separate:
 * `detectConflicts` runs once per catch-up over the accumulated missed
 * window, before the flush gate reopens, and moves losing entries to the
 * Conflicts store. Live sync is pure convergence — no conflict rows.
 *
 * The module depends only on injected seams: the store, an HLC source
 * for the ordering key, `applyOptimistic` (the client wires it to the
 * entity cache + change emitter), and `submit` (the network write).
 * The client remains the only place that knows about the concrete
 * storage adapter and fetch.
 */

import { compare, type Action } from "@ebbjs/core";
import type { ConflictEntry, ConflictSlot, ConflictStore, OutboxStore } from "@ebbjs/storage/types";

import type { Rejection, WriteResponse } from "./types";
import {
  actionTouchesSubject,
  actionWrites,
  conflictSlot,
  foldInboundWindow,
  inboundSubjects,
  isConflictableField,
  overlappingPaths,
  slotKey,
} from "./conflict-slots";
import { createObservable } from "./observable";

/**
 * Entry status. `pending` is flushable; `acknowledged` has been
 * accepted by the server and awaits its sync echo (never re-flushed);
 * `error` is a server rejection awaiting application handling.
 */
export type OutboxStatus = "pending" | "acknowledged" | "error";

/** One buffered Action and its lifecycle status. */
export interface OutboxEntry {
  readonly action: Action;
  readonly status: OutboxStatus;
  /** HLC stamped when the Action was buffered; the durable ordering key. */
  readonly enqueuedAtHlc: string;
  /**
   * Highest server sequence the client had applied when the Action was
   * authored. An inbound Action is concurrent with this write when its
   * GSN is greater; `0` means "always concurrent".
   */
  readonly basedOnGsn: number;
}

/**
 * Classified result of a `flush()`. `unreachable` is the only kind a
 * caller may retry blindly — every other kind means the server saw the
 * batch and the entries have left `pending`. A `partial` batch's
 * rejections are terminal until the application calls `retry`.
 */
export type FlushOutcome =
  | { kind: "empty" }
  | { kind: "accepted"; actionIds: readonly string[] }
  | { kind: "partial"; accepted: readonly string[]; rejected: readonly Rejection[] }
  | { kind: "unreachable"; error: unknown };

/**
 * Classified result of matching an inbound Action against the buffer.
 * `echo` is this client's own Action returning over the sync stream and
 * removing its buffered entry; anything else is `none`. Race detection is
 * catch-up-scoped and reported by {@link DetectedConflict} instead.
 */
export type InboundOutcome = { kind: "echo"; actionId: string } | { kind: "none" };

/** One buffered Action a catch-up pass moved to the Conflicts store. */
export interface DetectedConflict {
  /** The losing `action.id`. */
  readonly actionId: string;
  /** Subjects that actually lost. */
  readonly subjects: readonly string[];
  /**
   * Overlapping contested positions, in detection order. Empty when the
   * entity-level scope surfaced a subject with no position overlap.
   */
  readonly slots: readonly ConflictSlot[];
}

/**
 * Collaborators the outbox needs. Kept narrow so the outbox can't
 * reach into the client or storage directly.
 */
export interface OutboxDependencies {
  /**
   * Optimistically apply an Action's Updates to the local entity
   * cache, firing the change emitter so local reads reflect the
   * write before the server echo.
   */
  applyOptimistic(action: Action): Promise<void>;
  /**
   * Submit a batch of Actions through the network write path. A
   * throw leaves the batch pending (the caller decides whether to
   * surface or retry); a resolved response means the server saw the
   * batch, though it may have rejected individual Actions.
   */
  submit(actions: readonly Action[]): Promise<WriteResponse>;
  /**
   * Durable buffer every enqueued Action is written to, and the
   * source rehydration reads buffered entries back from. The outbox
   * persists every status transition here; `delete` is how an echo
   * or a conflict removes an entry.
   */
  store: OutboxStore;
  /**
   * Durable table of offline conflicts awaiting application
   * resolution. A buffered Action a catch-up pass finds concurrent with
   * the missed window is moved here whole, so a pending write survives
   * the pass and an already-committed one is surfaced for resolution.
   */
  conflicts: ConflictStore;
  /**
   * Highest server GSN the client has applied, stamped onto every
   * enqueued Action as its write base.
   */
  baseGsn: () => number;
  /**
   * Conflict granularity declared by an entity: `"field"` surfaces a
   * same-position race, `"entity"` any concurrent touch. Unknown types
   * default to `"field"`.
   */
  conflictScope: (subjectType: string) => "field" | "entity";
  /**
   * Field-kind oracle: `true` when `field` on `subjectType` merges
   * last-writer-wins, so an inbound write can silently overwrite a
   * buffered local one. A map field (a document's `content`) is LWW per
   * leaf, so the slot comparison still gates on the leaf. Counter
   * fields return `false`. Structural edge subject types are excluded
   * regardless. Defaults to every non-structural field being LWW.
   */
  isLwwField?: (subjectType: string, field: string) => boolean;
  /** Stamp a fresh HLC for an entry's `enqueuedAtHlc` ordering key. */
  hlc: () => string;
  /** Mint an id for one detected conflict entry. */
  conflictId: () => string;
}

/**
 * Depth of the buffer by status, read as one snapshot so the three
 * counters cannot disagree about the entry set they were taken over.
 */
export interface OutboxCounts {
  /** Flushable backlog. */
  readonly pending: number;
  /** Accepted by the server, awaiting the sync echo. */
  readonly acknowledged: number;
  /** Server-rejected, awaiting application handling. */
  readonly error: number;
}

/** Fired with the buffer's {@link OutboxCounts} whenever an entry changes. */
export type OutboxChangeListener = (counts: OutboxCounts) => void;

/**
 * The write-buffer surface. `counts()` / `onChange()` are the
 * observability hooks the telemetry sub-issue (#125) builds on.
 */
export interface Outbox {
  enqueue(action: Action): Promise<void>;
  /**
   * Still-flushable entries in authoring order. A snapshot: callers
   * cannot mutate the queue through it.
   */
  pending(): readonly OutboxEntry[];
  /** Server-rejected entries awaiting application handling, in authoring order. */
  errors(): readonly OutboxEntry[];
  /**
   * Entries the server has not rejected — `pending` and `acknowledged` —
   * in authoring order. The set at risk during catch-up: neither has seen
   * its echo yet, so an inbound Action can still out-date the optimistic
   * row it was built on.
   */
  unrejected(): readonly OutboxEntry[];
  /**
   * Depth of the entries carrying `status`, defaulting to `pending`
   * (the flushable backlog). The pending / acknowledged / error
   * counters #125 consumes.
   */
  size(status?: OutboxStatus): number;
  /** Depth by status, read as one consistent snapshot. */
  counts(): OutboxCounts;
  /**
   * Subscribe to depth changes: an enqueue, a flush status transition, a
   * retry, a clear, or an echo / conflict removal. The listener fires
   * with the new counts; an unsubscribe function is returned. Fires only
   * on change, not on subscription — read `counts()` for the current
   * depth. Listeners are isolated; a throwing one does not affect the
   * others.
   */
  onChange(listener: OutboxChangeListener): () => void;
  /**
   * Load persisted entries into the in-memory queue. Runs eagerly at
   * construction as a single-flight operation (idempotent); returns
   * that same promise so callers can await it. Every status is loaded:
   * `pending` to flush, `acknowledged` to await its echo, `error` to
   * stay queryable across a reload. Rehydrated entries are seeded only
   * — never optimistically re-applied, since they were already applied
   * before the reload.
   */
  rehydrate(): Promise<void>;
  /**
   * Submit every currently-`pending` Action as one batch and classify
   * the result. Accepted entries become `acknowledged` (persisted, and
   * never included in a later flush); entries named in `rejected[]`
   * become `error` (persisted, not removed). A submit that throws
   * leaves every entry `pending` and reports `unreachable`. Entries
   * enqueued while the request is in flight stay pending.
   *
   * The flush is single-flight: concurrent callers share one in-flight
   * outcome. A failure to read or persist entry state (rehydration or
   * the durable status transition) rejects rather than classifying —
   * `unreachable` means the submit itself threw, which is retryable,
   * while a store failure is a different, non-retryable-blindly fault.
   */
  flush(): Promise<FlushOutcome>;
  /**
   * Return an errored entry to `pending` (persisted) so the next
   * flush re-submits it. A no-op for an unknown or non-errored id.
   */
  retry(actionId: string): Promise<void>;
  /**
   * Delete an errored entry from memory and the store. A no-op for an
   * unknown or non-errored id.
   */
  clearError(actionId: string): Promise<void>;
  /**
   * Classify an inbound Action against the buffer.
   *
   * An Action whose id matches a `pending` / `acknowledged` entry and
   * that carries a server GSN (`gsn > 0`) is this client's own echo: it
   * is removed from memory and the store, and reported as `echo`.
   * Anything else is `none`. Race detection is catch-up-scoped; see
   * {@link Outbox.detectConflicts}.
   */
  noteInbound(action: Action): Promise<InboundOutcome>;
  /**
   * Fold the accumulated missed catch-up window against the buffer and
   * move every losing local Action to the Conflicts store. Runs once per
   * reconnect, before the flush gate reopens.
   *
   * An entry loses when a missed Action with `gsn > entry.basedOnGsn`
   * touches the same position (declared `"field"` scope) or the same
   * entity (declared `"entity"` scope). `pending` and `acknowledged`
   * entries are candidates; an `error` entry is a server rejection, not a
   * race. A conflict is recorded even when the local value would win the
   * merge — the application decides.
   *
   * `catchUpId` is the pass's identity, stamped on every entry it
   * produces. Returns the entries moved, in buffer order.
   */
  detectConflicts(
    actions: readonly Action[],
    catchUpId: string,
  ): Promise<readonly DetectedConflict[]>;
}

/**
 * Build an Outbox backed by a durable store. Each `flush()` submits
 * exactly the entries `pending` when it was called and transitions
 * those entries by identity, so an `enqueue` racing a flush is never
 * dropped by the flush's cleanup.
 */
export function createOutbox(deps: OutboxDependencies): Outbox {
  let entries: readonly OutboxEntry[] = [];
  let rehydration: Promise<void> | null = null;
  const countsSource = createObservable<OutboxCounts>({
    pending: 0,
    acknowledged: 0,
    error: 0,
  });

  const counts = (): OutboxCounts => {
    let pending = 0;
    let acknowledged = 0;
    let error = 0;
    for (const entry of entries) {
      if (entry.status === "pending") pending += 1;
      else if (entry.status === "acknowledged") acknowledged += 1;
      else error += 1;
    }
    return { pending, acknowledged, error };
  };

  /**
   * Notify subscribers after an entry change. Deduped against the last
   * emitted depth, so a rehydration that seeds the same entries a
   * subscriber already read does not fire a phantom change. Cheap when
   * nobody is listening, so the mutation sites call it unconditionally.
   */
  const emit = (): void => {
    const snapshot = counts();
    const previous = countsSource.get();
    if (
      snapshot.pending === previous.pending &&
      snapshot.acknowledged === previous.acknowledged &&
      snapshot.error === previous.error
    ) {
      return;
    }
    countsSource.set(snapshot);
  };

  const rehydrate = (): Promise<void> => {
    rehydration ??= deps.store
      .list()
      .then((persisted) => {
        entries = [...persisted]
          .sort((a, b) => compare(a.enqueuedAtHlc, b.enqueuedAtHlc))
          .map((entry) => ({
            action: entry.action,
            status: entry.status,
            enqueuedAtHlc: entry.enqueuedAtHlc,
            // Absent base means "always concurrent", never a silent drop.
            basedOnGsn: entry.basedOnGsn ?? 0,
          }));
        emit();
      })
      .catch((err: unknown) => {
        // Clear the memo so a transient `list()` failure cannot brick
        // every later write: the next enqueue/flush retries the load.
        rehydration = null;
        throw err;
      });
    return rehydration;
  };

  const enqueue = async (action: Action): Promise<void> => {
    // A write racing startup must land after the persisted entries so
    // the rehydrated queue cannot be clobbered by an out-of-order write.
    await rehydrate();
    const enqueuedAtHlc = deps.hlc();
    const basedOnGsn = deps.baseGsn();
    // Persist before buffering: a store failure must not leave the
    // in-memory queue holding an entry the store never saw.
    await deps.store.put({ action, status: "pending", enqueuedAtHlc, basedOnGsn });
    entries = [...entries, { action, status: "pending", enqueuedAtHlc, basedOnGsn }];
    // Notify before the optimistic apply resolves: the entry is already
    // durable and buffered, so subscribers must see the depth even if the
    // apply throws and `enqueue` rejects.
    emit();
    await deps.applyOptimistic(action);
  };

  const runFlush = async (): Promise<FlushOutcome> => {
    // The first flush must include persisted entries even before a
    // caller has observed rehydration complete.
    await rehydrate();
    const batch = entries.filter((entry) => entry.status === "pending");
    if (batch.length === 0) return { kind: "empty" };

    let response: WriteResponse;
    try {
      response = await deps.submit(batch.map((entry) => entry.action));
    } catch (error) {
      return { kind: "unreachable", error };
    }

    const rejectedIds = new Set(response.rejected.map((rejection) => rejection.id));
    const statusFor = (entry: OutboxEntry): OutboxStatus =>
      rejectedIds.has(entry.action.id) ? "error" : "acknowledged";

    // Commit each entry to memory only once its new status is durable, so
    // a store failure mid-batch cannot leave memory and the store
    // disagreeing: entries are in the same state in both. Skip any entry
    // an echo or conflict sweep removed while the submit was in flight —
    // re-`put`ting after that `delete` would resurrect a row no future
    // echo can clear.
    let changed = false;
    try {
      for (const entry of batch) {
        if (!entries.some((candidate) => candidate.action.id === entry.action.id)) continue;
        const status = statusFor(entry);
        await deps.store.put({
          action: entry.action,
          status,
          enqueuedAtHlc: entry.enqueuedAtHlc,
          basedOnGsn: entry.basedOnGsn,
        });
        if (!entries.some((candidate) => candidate.action.id === entry.action.id)) {
          // The echo's or conflict's `delete` interleaved with this `put`.
          // Re-delete so the row stays gone even if the put landed last and
          // resurrected it.
          await deps.store.delete(entry.action.id);
          continue;
        }
        entries = entries.map((candidate) =>
          candidate.action.id === entry.action.id ? { ...candidate, status } : candidate,
        );
        changed = true;
      }
    } finally {
      // Emit even if a later entry's store write threw: the entries already
      // transitioned in memory, so subscribers must see their new status.
      if (changed) emit();
    }

    if (rejectedIds.size === 0) {
      return { kind: "accepted", actionIds: batch.map((entry) => entry.action.id) };
    }
    return {
      kind: "partial",
      accepted: batch
        .filter((entry) => !rejectedIds.has(entry.action.id))
        .map((entry) => entry.action.id),
      rejected: response.rejected,
    };
  };

  // One flush in flight at a time: two callers racing (e.g. concurrent
  // `write()` calls) must not submit the same batch twice. Later callers
  // share the in-flight outcome; entries enqueued meanwhile stay pending
  // for the next flush.
  let inFlight: Promise<FlushOutcome> | null = null;
  const flush = (): Promise<FlushOutcome> => {
    inFlight ??= runFlush().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const retry = async (actionId: string): Promise<void> => {
    await rehydrate();
    const entry = entries.find((c) => c.action.id === actionId && c.status === "error");
    if (entry === undefined) return;
    await deps.store.put({
      action: entry.action,
      status: "pending",
      enqueuedAtHlc: entry.enqueuedAtHlc,
      basedOnGsn: entry.basedOnGsn,
    });
    entries = entries.map((c) => (c.action.id === actionId ? { ...c, status: "pending" } : c));
    emit();
  };

  const clearError = async (actionId: string): Promise<void> => {
    await rehydrate();
    const entry = entries.find((c) => c.action.id === actionId && c.status === "error");
    if (entry === undefined) return;
    await deps.store.delete(actionId);
    entries = entries.filter((c) => c.action.id !== actionId);
    emit();
  };

  const noteInbound = async (action: Action): Promise<InboundOutcome> => {
    // gsn 0 means the server has not accepted the Action, so it cannot be
    // this client's own echo.
    if (action.gsn <= 0) return { kind: "none" };
    // An echo can arrive before a caller has awaited rehydration (SSE is
    // live from construction), so match against the loaded buffer rather
    // than whatever happens to be in memory already.
    try {
      await rehydrate();
    } catch {
      // The receipt hook is best-effort: the Action is already durable in
      // the log when this runs, so a store read failure must not break the
      // inbound funnel. The entry stays for a later echo or reload.
      return { kind: "none" };
    }

    const echo = entries.find(
      (entry) =>
        entry.action.id === action.id &&
        (entry.status === "pending" || entry.status === "acknowledged"),
    );
    if (echo === undefined) return { kind: "none" };
    try {
      await deps.store.delete(action.id);
    } catch {
      // Keep memory and the store agreeing: the row survives until a
      // later attempt can delete both.
      return { kind: "none" };
    }
    entries = entries.filter((entry) => entry.action.id !== action.id);
    emit();
    return { kind: "echo", actionId: action.id };
  };

  /**
   * Persist one detected conflict and remove the losing entry from the
   * buffer, keeping the two durable stores in agreement. `false` leaves
   * the entry flushable for the next reconnect.
   */
  const persistConflict = async (conflict: ConflictEntry): Promise<boolean> => {
    const actionId = conflict.action.id;
    try {
      await deps.conflicts.put(conflict);
    } catch {
      // Durable buffer first: leave the entry pending rather than
      // dropping the write.
      return false;
    }
    try {
      await deps.store.delete(actionId);
    } catch {
      // Roll the conflict row back so the two durable stores agree and
      // the entry stays flushable for a later pass.
      await deps.conflicts.delete(actionId).catch(() => {});
      return false;
    }
    entries = entries.filter((entry) => entry.action.id !== actionId);
    return true;
  };

  const detectConflicts = async (
    actions: readonly Action[],
    catchUpId: string,
  ): Promise<readonly DetectedConflict[]> => {
    if (actions.length === 0) return [];
    try {
      await rehydrate();
    } catch {
      // Best-effort, like the echo leg: a store read failure leaves the
      // buffer for the next reconnect rather than breaking catch-up.
      return [];
    }
    const candidates = entries.filter((entry) => entry.status !== "error");
    if (candidates.length === 0) return [];
    const folded = foldInboundWindow(actions);
    if (folded.size === 0) return [];
    // Fold every missed Action once; concurrency is judged per entry.
    const window = actions.map((action) => ({ action, subjects: inboundSubjects(action) }));

    const detected: DetectedConflict[] = [];
    for (const entry of candidates) {
      if (!window.some(({ action }) => action.gsn > entry.basedOnGsn)) continue;
      const subjects: string[] = [];
      const slots: ConflictSlot[] = [];
      const seen = new Set<string>();
      for (const [subjectId, pending] of actionWrites(entry.action)) {
        const inbound = folded.get(subjectId);
        if (inbound === undefined) continue;
        const overlap: ConflictSlot[] = [];
        for (const { action, subjects: actionSubjects } of window) {
          if (action.gsn <= entry.basedOnGsn) continue;
          if (!actionTouchesSubject(action, subjectId)) continue;
          const actionInbound = actionSubjects.get(subjectId);
          if (actionInbound === undefined) continue;
          for (const [field, pendingValue] of pending.fields) {
            if (!isConflictableField(deps.isLwwField, inbound.subjectType, field)) continue;
            const remoteField = inbound.fields.get(field);
            const winner = actionInbound.fields.get(field);
            const paths = winner !== undefined ? overlappingPaths(pendingValue, winner) : [];
            // A concurrent put or delete touches every field the entry
            // writes, even one it omits.
            if (winner === undefined && actionInbound.replaced) paths.push([]);
            for (const path of paths) {
              const key = slotKey({ subjectId, field, path });
              if (seen.has(key)) continue;
              seen.add(key);
              overlap.push(
                conflictSlot({
                  subjectId,
                  field,
                  path,
                  pending: pendingValue,
                  remote: winner === undefined ? undefined : remoteField,
                }),
              );
            }
          }
        }
        if (deps.conflictScope(inbound.subjectType) === "entity" || overlap.length > 0) {
          subjects.push(subjectId);
          slots.push(...overlap);
        }
      }
      if (subjects.length === 0) continue;
      const conflict: ConflictEntry = {
        action: entry.action,
        subjects,
        slots,
        basedOnGsn: entry.basedOnGsn,
        catchUpId,
        conflictId: deps.conflictId(),
        detectedAtHlc: deps.hlc(),
      };
      if (!(await persistConflict(conflict))) continue;
      detected.push({ actionId: entry.action.id, subjects, slots });
    }
    if (detected.length > 0) emit();
    return detected;
  };

  // Rehydrate without caller involvement. A rejected `list()` must not
  // surface as an unhandled rejection; awaiting callers still see it.
  void rehydrate().catch(() => {});

  return {
    enqueue,
    rehydrate,
    pending: () => entries.filter((entry) => entry.status === "pending"),
    errors: () => entries.filter((entry) => entry.status === "error"),
    unrejected: () => entries.filter((entry) => entry.status !== "error"),
    size: (status: OutboxStatus = "pending") => counts()[status],
    counts,
    onChange: (listener) => countsSource.subscribe(listener),
    flush,
    retry,
    clearError,
    noteInbound,
    detectConflicts,
  };
}
