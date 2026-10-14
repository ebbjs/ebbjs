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
 *               │ (flush rejected)           │ (a catch-up race)
 *               ▼                            ▼
 *             error ─(retry)─► pending    conflicted ─(resolve)─► pending / removed
 * ```
 *
 * `matchEcho` drives the echo leg: the single inbound funnel
 * (`SyncClient._applyAction`) hands every received Action here, and an
 * Action that matches a buffered entry with a server GSN proves the
 * entry is in the canonical log and removes it. Detection is separate:
 * `detectConflicts` runs once per catch-up over the accumulated missed
 * window, before the flush gate reopens, and stamps the losing entry
 * `conflicted` in the one durable write that holds it. Live sync is pure
 * convergence — no conflict rows.
 *
 * The conflict is a status on the outbox row, not a second store: the
 * hold and the durable record are the same write, so a detected loser
 * can never be submitted even when that write fails. A read view over
 * the conflicted rows is the application's `client.conflicts`.
 *
 * The module depends only on injected seams: the store, an HLC source
 * for the ordering key, `applyOptimistic` (the client wires it to the
 * entity cache + change emitter), and `submit` (the network write).
 * The client remains the only place that knows about the concrete
 * storage adapter and fetch.
 */

import { compare, type Action, type Entity } from "@ebbjs/core";
import type {
  ConflictSlot,
  ConflictSubjectState,
  OutboxConflict,
  OutboxStore,
} from "@ebbjs/storage/types";

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
 * `error` is a server rejection awaiting application handling;
 * `conflicted` is a detected catch-up loser awaiting resolution, held
 * structurally because `pending()` and `runFlush` only admit `pending`.
 */
export type OutboxStatus = "pending" | "acknowledged" | "error" | "conflicted";

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
  /** Present iff `status === "conflicted"`. */
  readonly conflict?: OutboxConflict;
}

/** A `conflicted` entry, narrowed so its payload is not optional. */
export interface ConflictedOutboxEntry extends OutboxEntry {
  readonly status: "conflicted";
  readonly conflict: OutboxConflict;
}

const isConflicted = (entry: OutboxEntry): entry is ConflictedOutboxEntry =>
  entry.status === "conflicted" && entry.conflict !== undefined;

/** A loser subject's pre-detection state; `after` is read at detection. */
interface LoserSubject {
  readonly subjectId: string;
  readonly subjectType: string;
  readonly before: Entity | null;
}

/** One losing entry classified by a detection pass, before grouping. */
interface Loser {
  readonly id: string;
  readonly subjects: string[];
  readonly subjectStates: readonly LoserSubject[];
  readonly slots: ConflictSlot[];
}

/** A loser paired with the conflict id of its connected subject set. */
interface GroupedLoser {
  readonly loser: Loser;
  readonly conflictId: string;
}

/**
 * Assign one `conflictId` per connected set of losing subjects: two losers
 * that share a subject, directly or transitively, are one conflict. The id
 * is persisted on each row, so grouping survives a reload and a partial
 * resolution; a later pass mints fresh ids and never merges into an
 * earlier conflict.
 */
const groupLosers = (losers: readonly Loser[], mintId: () => string): readonly GroupedLoser[] => {
  const parent = new Map<string, string>();
  const find = (subject: string): string => {
    let root = subject;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };
  for (const loser of losers) {
    const [first, ...rest] = loser.subjects;
    if (first === undefined) continue;
    if (!parent.has(first)) parent.set(first, first);
    for (const subject of rest) {
      if (!parent.has(subject)) parent.set(subject, subject);
      union(first, subject);
    }
  }

  const idByRoot = new Map<string, string>();
  return losers.map((loser) => {
    const first = loser.subjects[0];
    if (first === undefined) return { loser, conflictId: mintId() };
    const root = find(first);
    let conflictId = idByRoot.get(root);
    if (conflictId === undefined) {
      conflictId = mintId();
      idByRoot.set(root, conflictId);
    }
    return { loser, conflictId };
  });
};

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
   * persists every status transition here — including a detection that
   * stamps the conflict payload — so the hold and the record are one
   * write. `delete` is how an echo or a resolution removes an entry.
   */
  store: OutboxStore;
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
  /**
   * The row captured for `subjectId` immediately before this pass's
   * window; `null` when none was captured. Keyed by `catchUpId` so one
   * pass's capture cannot satisfy another pass's read.
   */
  preSyncRow: (catchUpId: string, subjectId: string) => Entity | null;
  /**
   * The materialized row for `subjectId` at detection — the server's view
   * once the window landed; `null` when replay yields no row.
   */
  readEntity: (subjectId: string) => Promise<Entity | null>;
}

/**
 * Depth of the buffer by status, read as one snapshot so the counters
 * cannot disagree about the entry set they were taken over.
 */
export interface OutboxCounts {
  /** Flushable backlog. */
  readonly pending: number;
  /** Accepted by the server, awaiting the sync echo. */
  readonly acknowledged: number;
  /** Server-rejected, awaiting application handling. */
  readonly error: number;
  /** Detected catch-up losers awaiting resolution. */
  readonly conflicted: number;
}

/** Fired with the buffer's {@link OutboxCounts} whenever an entry changes. */
export type OutboxChangeListener = (counts: OutboxCounts) => void;

/**
 * A durable store fault on a status transition the buffer could not
 * complete. The in-memory buffer is the session's source of truth, so the
 * entry keeps its status; the fault is surfaced (log + counter + stream)
 * rather than swallowed, because the transition will not survive a reload.
 */
export interface StoreFault {
  /** The Action whose durable transition faulted. */
  readonly actionId: string;
  /** The store error. */
  readonly error: unknown;
}

/** Fired after each durable store fault. */
export type StoreFaultListener = (fault: StoreFault) => void;

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
   * Entries the server has not rejected — `pending`, `acknowledged`,
   * and `conflicted` — in authoring order. The set at risk during
   * catch-up: a not-yet-echoed entry can be out-dated by an inbound
   * Action, and a conflicted one still carries the optimistic row its
   * resolution reads.
   */
  unrejected(): readonly OutboxEntry[];
  /**
   * Detected catch-up losers awaiting resolution, oldest detection
   * first. The read view `client.conflicts` projects.
   */
  conflicts(): readonly ConflictedOutboxEntry[];
  /**
   * Depth of the entries carrying `status`, defaulting to `pending`
   * (the flushable backlog). The pending / acknowledged / error /
   * conflicted counters #125 consumes.
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
   * Cumulative count of durable store faults the buffer has reported.
   * Non-zero means at least one status transition did not reach the
   * store and will not survive a reload. Exposed as
   * `client.sync.outbox.storeFaults`.
   */
  storeFaults(): number;
  /**
   * Subscribe to durable store faults. Returns an unsubscribe function;
   * listeners are isolated. Fires only on a fault, never on
   * subscription — read {@link storeFaults} for the current count.
   */
  onStoreFault(listener: StoreFaultListener): () => void;
  /**
   * Load persisted entries into the in-memory queue. Runs eagerly at
   * construction as a single-flight operation (idempotent); returns
   * that same promise so callers can await it. Every status is loaded:
   * `pending` to flush, `acknowledged` to await its echo, `error` to
   * stay queryable across a reload, `conflicted` to stay held and
   * resolvable. Rehydrated entries are seeded only — never
   * optimistically re-applied, since they were already applied before
   * the reload.
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
   * Replace a conflicted row with a freshly-stamped re-assert in one
   * durable write (`putAndDelete`), so a failure leaves the conflict
   * resolvable instead of enqueuing a duplicate on the next retry. A
   * no-op for an unknown or non-conflicted id.
   */
  retryConflicted(originalId: string, action: Action): Promise<void>;
  /**
   * Delete a conflicted entry from memory and the store without
   * touching the local cache. `resolve`'s discard path re-materializes
   * first; this is the row removal both resolutions end with. A no-op
   * for an unknown or non-conflicted id.
   */
  clearConflict(actionId: string): Promise<void>;
  /**
   * Match an inbound Action against the buffer's echoes.
   *
   * Returns `true` — and removes the entry from memory and the store —
   * when the Action's id matches a `pending` / `acknowledged` entry and
   * it carries a server GSN (`gsn > 0`): this client's own write coming
   * back as canonical. A `conflicted` entry is never retired: the server
   * may have committed the write, but the local value lost and the user
   * has not decided. Anything else is `false`. Race detection is
   * catch-up-scoped; see {@link Outbox.detectConflicts}.
   */
  matchEcho(action: Action): Promise<boolean>;
  /**
   * Fold the accumulated missed catch-up window against the buffer and
   * stamp every losing local Action `conflicted`, in the one durable
   * write that both holds it and records the conflict. Runs once per
   * reconnect, before the flush gate reopens.
   *
   * An entry loses when a missed Action with `gsn > entry.basedOnGsn`
   * touches the same position (declared `"field"` scope) or the same
   * entity (declared `"entity"` scope). `pending` and `acknowledged`
   * entries are candidates; `error` and already-`conflicted` entries are
   * not. A conflict is recorded even when the local value would win the
   * merge — the application decides.
   *
   * `catchUpId` is the pass's identity, stamped on every entry it
   * produces. Losing entries that share a connected set of subjects
   * share one `conflictId`, so the application-facing grouping is
   * durable. Returns the entries it held, in buffer order.
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
  let storeFaultCount = 0;
  const storeFaultListeners = new Set<StoreFaultListener>();
  const countsSource = createObservable<OutboxCounts>({
    pending: 0,
    acknowledged: 0,
    error: 0,
    conflicted: 0,
  });

  const counts = (): OutboxCounts => {
    let pending = 0;
    let acknowledged = 0;
    let error = 0;
    let conflicted = 0;
    for (const entry of entries) {
      if (entry.status === "pending") pending += 1;
      else if (entry.status === "acknowledged") acknowledged += 1;
      else if (entry.status === "error") error += 1;
      else conflicted += 1;
    }
    return { pending, acknowledged, error, conflicted };
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
      snapshot.error === previous.error &&
      snapshot.conflicted === previous.conflicted
    ) {
      return;
    }
    countsSource.set(snapshot);
  };

  /**
   * Surface a durable store fault. Silence here would hide a transition
   * the next reload loses.
   */
  const reportStoreFault = (actionId: string, error: unknown): void => {
    storeFaultCount += 1;
    console.error(`[Outbox] durable store fault for ${actionId}:`, error);
    for (const listener of storeFaultListeners) {
      try {
        listener({ actionId, error });
      } catch (listenerError) {
        console.error("[Outbox] store-fault listener threw:", listenerError);
      }
    }
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
            conflict: entry.conflict,
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

  /**
   * Replace a conflicted row with a fresh pending re-assert in one durable
   * write. Memory changes only after the store commits, so a store failure
   * leaves the conflict exactly as it was — resolvable by a later retry,
   * with no half-enqueued duplicate. A no-op when the id is not a
   * conflicted row.
   */
  const retryConflicted = async (originalId: string, action: Action): Promise<void> => {
    await rehydrate();
    const original = entries.find(
      (candidate) => candidate.action.id === originalId && candidate.status === "conflicted",
    );
    if (original === undefined) return;
    const enqueuedAtHlc = deps.hlc();
    const basedOnGsn = deps.baseGsn();
    const next: OutboxEntry = { action, status: "pending", enqueuedAtHlc, basedOnGsn };
    await deps.store.putAndDelete(next, originalId);
    entries = [...entries.filter((candidate) => candidate.action.id !== originalId), next];
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
    // disagreeing: entries are in the same state in both. Re-check each
    // entry's live status because an echo may have removed it or a
    // catch-up detection may have held it `conflicted` while the submit
    // was in flight — neither newer state may be overwritten.
    let changed = false;
    try {
      for (const entry of batch) {
        const before = entries.find((candidate) => candidate.action.id === entry.action.id);
        if (before === undefined || before.status !== "pending") continue;
        const status = statusFor(entry);
        await deps.store.put({
          action: entry.action,
          status,
          enqueuedAtHlc: entry.enqueuedAtHlc,
          basedOnGsn: entry.basedOnGsn,
        });
        const after = entries.find((candidate) => candidate.action.id === entry.action.id);
        if (after === undefined) {
          // The echo's `delete` interleaved with this `put`; re-delete so
          // the row stays gone even if the put landed last.
          await deps.store.delete(entry.action.id);
          continue;
        }
        if (after.status !== "pending") {
          // A detection's hold interleaved with this `put`; re-persist the
          // newer state so memory and the store agree.
          await deps.store.put(after);
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
      conflict: entry.conflict,
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

  const clearConflict = async (actionId: string): Promise<void> => {
    await rehydrate();
    const entry = entries.find((c) => c.action.id === actionId && c.status === "conflicted");
    if (entry === undefined) return;
    await deps.store.delete(actionId);
    entries = entries.filter((c) => c.action.id !== actionId);
    emit();
  };

  const matchEcho = async (action: Action): Promise<boolean> => {
    // gsn 0 means the server has not accepted the Action, so it cannot be
    // this client's own echo.
    if (action.gsn <= 0) return false;
    // An echo can arrive before a caller has awaited rehydration (SSE is
    // live from construction), so match against the loaded buffer rather
    // than whatever happens to be in memory already.
    try {
      await rehydrate();
    } catch {
      // The echo match is best-effort: the Action is already durable in
      // the log when this runs, so a store read failure must not break the
      // inbound funnel. The entry stays for a later echo or reload.
      return false;
    }

    const echo = entries.find(
      (entry) =>
        entry.action.id === action.id &&
        (entry.status === "pending" || entry.status === "acknowledged"),
    );
    if (echo === undefined) return false;
    try {
      await deps.store.delete(action.id);
    } catch {
      // Keep memory and the store agreeing: the row survives until a
      // later attempt can delete both.
      return false;
    }
    entries = entries.filter((entry) => entry.action.id !== action.id);
    emit();
    return true;
  };

  /**
   * Stamp one detected loser `conflicted` with its payload. Memory
   * transitions before the durable write, so a failed write cannot leave
   * the entry flushable: `pending()` and `runFlush` read the in-memory
   * status, which is the gate. The durable write is best-effort so one
   * store fault does not abort the rest of the sweep; the fault is
   * surfaced through `storeFaults` (the row keeps its prior durable
   * status, so the hold lasts only this session).
   */
  const markConflicted = async (actionId: string, conflict: OutboxConflict): Promise<void> => {
    const entry = entries.find((candidate) => candidate.action.id === actionId);
    if (entry === undefined) return;
    entries = entries.map((candidate) =>
      candidate.action.id === actionId
        ? { ...candidate, status: "conflicted" as const, conflict }
        : candidate,
    );
    emit();
    try {
      await deps.store.put({ ...entry, status: "conflicted", conflict });
    } catch (error) {
      // The in-memory hold keeps the loser off the wire for this session;
      // the durable row keeps its prior status, so the fault is surfaced
      // for telemetry rather than silently lost.
      reportStoreFault(actionId, error);
    }
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
    const candidates = entries.filter(
      (entry) => entry.status === "pending" || entry.status === "acknowledged",
    );
    if (candidates.length === 0) return [];
    const folded = foldInboundWindow(actions);
    if (folded.size === 0) return [];
    // Fold every missed Action once; concurrency is judged per entry.
    const window = actions.map((action) => ({ action, subjects: inboundSubjects(action) }));

    // Classify each loser first, then group. Every losing Action in one
    // connected set of subjects shares one `conflictId`, stamped here so
    // grouping survives a reload and a partial resolution. A later pass
    // that shares a subject with an already-conflicted row is a distinct
    // conflict: a new pass mints a fresh id.
    const losers: Loser[] = [];
    for (const entry of candidates) {
      if (!window.some(({ action }) => action.gsn > entry.basedOnGsn)) continue;
      const subjects: string[] = [];
      const subjectStates: LoserSubject[] = [];
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
          subjectStates.push({
            subjectId,
            subjectType: inbound.subjectType,
            before: deps.preSyncRow(catchUpId, subjectId),
          });
          slots.push(...overlap);
        }
      }
      if (subjects.length === 0) continue;
      losers.push({ id: entry.action.id, subjects, subjectStates, slots });
    }
    if (losers.length === 0) return [];

    const grouped = groupLosers(losers, deps.conflictId);
    const detected: DetectedConflict[] = [];
    for (const { loser, conflictId } of grouped) {
      // `after` is measured once, at detection. The inbound window has
      // already replaced the optimistic row, so no log-emptiness check is
      // needed to know the materialized row is the server's view.
      const subjectStates: ConflictSubjectState[] = await Promise.all(
        loser.subjectStates.map(async (state) => ({
          ...state,
          after: await deps.readEntity(state.subjectId),
        })),
      );
      const conflict: OutboxConflict = {
        subjects: loser.subjects,
        subjectStates,
        slots: loser.slots,
        catchUpId,
        conflictId,
        detectedAtHlc: deps.hlc(),
      };
      await markConflicted(loser.id, conflict);
      detected.push({ actionId: loser.id, subjects: loser.subjects, slots: loser.slots });
    }
    emit();
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
    conflicts: () => entries.filter(isConflicted),
    size: (status: OutboxStatus = "pending") => counts()[status],
    counts,
    onChange: (listener) => countsSource.subscribe(listener),
    storeFaults: () => storeFaultCount,
    onStoreFault: (listener) => {
      storeFaultListeners.add(listener);
      return () => storeFaultListeners.delete(listener);
    },
    flush,
    retry,
    retryConflicted,
    clearError,
    clearConflict,
    matchEcho,
    detectConflicts,
  };
}
