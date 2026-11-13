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
 *               │
 *               ├(flush rejected)─► error ─(retry)─► pending
 *               │
 *               └(a catch-up race)─► conflicted ─(send)─► pending
 *                                        │
 *                                        └(clear)─► removed
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
 * durable record and the hold are the same write, so a detected loser
 * can never be submitted even when that write fails. A read view over
 * the conflicted rows is the application's `client.conflicts`.
 *
 * The hold outlives the losing Action. Every position an open conflict
 * names is held until the application resolves it — the contested component
 * for a field- or component-scope loss, the whole subject for an
 * entity-scope loss — and a `pending` write to a held position is buffered
 * (so local reads keep working) but never submitted. Sending the conflicted
 * Action unchanged or clearing it releases those positions. The hold is
 * derived from the durable rows, so it survives a reload with no second
 * store.
 *
 * The module depends only on injected seams: the store, an HLC source
 * for the ordering key, `applyOptimistic` (the client wires it to the
 * replica + shim), and `submit` (the network write).
 * The client remains the only place that knows about the concrete
 * storage adapter and fetch.
 */

import { compare, componentField, componentName, type Action, type Entity } from "@ebbjs/core";
import { DOC_CONTENT_FIELD, DOC_VERSION_FIELD, type ConflictScope } from "@ebbjs/schema";
import type {
  ConflictHold,
  ConflictRemoteAction,
  ConflictSlot,
  ConflictSubjectState,
  OutboxConflict,
  OutboxStore,
} from "@ebbjs/storage/types";

import type { Rejection, WriteResponse } from "./types";
import {
  actionTouchesHolds,
  actionWrites,
  coarsestScope,
  conflictHolds,
  conflictSlot,
  foldInboundWindow,
  holdKey,
  inboundSubjects,
  overlappingPaths,
  slotKey,
  type InboundSubject,
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

/** Every position an open conflict holds, deduped by subject and component. */
const heldPositions = (entries: readonly OutboxEntry[]): readonly ConflictHold[] => {
  const byKey = new Map<string, ConflictHold>();
  for (const entry of entries) {
    if (!isConflicted(entry)) continue;
    for (const hold of conflictHolds(entry.conflict)) byKey.set(holdKey(hold), hold);
  }
  return [...byKey.values()];
};

/** Whether a missed Action out-dates a buffered write — the concurrency rule. */
const isConcurrent = (entry: OutboxEntry, action: Action): boolean => action.gsn > entry.basedOnGsn;

/** A loser subject's pre-detection state; `after` is read at detection. */
interface LoserSubject {
  readonly subjectId: string;
  /** The model the row is committed under. */
  readonly model: string;
  readonly before: Entity | null;
}

/** One losing entry classified by a detection pass, before grouping. */
interface Loser {
  readonly id: string;
  readonly subjects: string[];
  readonly subjectStates: readonly LoserSubject[];
  readonly slots: ConflictSlot[];
  readonly holds: readonly ConflictHold[];
  readonly scope: ConflictScope;
  readonly remoteActions: readonly ConflictRemoteAction[];
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
   * Optimistically apply an Action's Updates to the local read model
   * so local reads reflect the write before the server echo.
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
   * Conflict granularity declared by a component: `"field"` surfaces a
   * same-position race, `"component"` any concurrent touch of that
   * component, `"entity"` any concurrent touch of the row. Unknown
   * components default to `"field"`.
   */
  conflictScope: (model: string, component: string) => ConflictScope;
  /**
   * Whether a component opts out of detection entirely. Structural
   * components converge last-writer-wins and never surface or hold. Defaults
   * to every declared component being detectable.
   */
  isStructural?: (model: string, component: string) => boolean;
  /**
   * Component-kind oracle: `true` when `component` merges last-writer-wins,
   * so an inbound write can silently overwrite a buffered local one. A keyed
   * component (a document's `content`) is LWW per leaf, so slot comparison
   * still gates on the leaf. Counter components return `false`. Defaults to
   * every declared component being LWW.
   */
  isLwwField?: (model: string, component: string) => boolean;
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
   * Still-flushable entries in authoring order: `pending` entries that
   * write no position an open conflict holds. A snapshot: callers cannot
   * mutate the queue through it.
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
   * Clear a conflicted row's hold: return it to `pending` with its Action
   * unchanged — same action id, same Update ids, same field HLCs. The
   * application chose to send what it wrote; re-stamping would fabricate
   * provenance on an append-only log. A no-op for an unknown or
   * non-conflicted id.
   */
  releaseConflict(actionId: string): Promise<void>;
  /**
   * Delete a conflicted entry from memory and the store without
   * touching the local cache. `clearLocalActions` re-materializes
   * first; this is the row removal both verbs end with. A no-op for an
   * unknown or non-conflicted id.
   */
  clearConflict(actionId: string): Promise<void>;
  /**
   * Snapshot the `pending` rows whose Action writes one of `holds` — the
   * local writes the current component hold excludes from `pending()`.
   * Read it *before* a verb moves the conflicted rows: a write enqueued
   * after that point was never held, so dropping it later would discard
   * an edit the hold never covered. An Action writing several positions is
   * held whole; an Action cannot be sent in part.
   */
  heldPending(holds: readonly ConflictHold[]): readonly OutboxEntry[];
  /**
   * Delete the named `pending` rows and return their Actions so the caller
   * can revert their optimistic overlays. Only rows still `pending` are
   * removed: an `acknowledged` row is already on the server and an echoed
   * or re-conflicted row has a newer state. Callers pass ids from
   * {@link heldPending}, so a write made after the hold lifted is safe.
   */
  dropHeld(actionIds: readonly string[]): Promise<readonly Action[]>;
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
   * touches the same position (declared `"field"` scope), the same
   * component (declared `"component"` scope), or the same entity (declared
   * `"entity"` scope). A structural component never surfaces. `pending`
   * entries are candidates;
   * `acknowledged`, `error`, and already-`conflicted` entries are not —
   * an acknowledged write is already on the server and must never be
   * re-held. A conflict is recorded even when the local value would win
   * the merge — the application decides.
   *
   * The payload reports the `scope` of the loss (the looser of the losing
   * subjects' declared scopes) and the `remoteActions` that out-dated the
   * write, so the application can build a policy without diffing itself.
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

  /**
   * Entries a flush may submit: `pending` and writing no held position.
   * `pending()` and `runFlush` read this one filter, so an entry held by
   * an open conflict can never reach the wire.
   */
  const flushableEntries = (): readonly OutboxEntry[] => {
    const held = heldPositions(entries);
    return entries.filter(
      (entry) => entry.status === "pending" && !actionTouchesHolds(entry.action, held),
    );
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
   * Return a conflicted row to `pending` with its Action untouched. The
   * store commits first: a failed write leaves the row conflicted and
   * resolvable. Nothing is re-applied optimistically — the overlay for
   * this action id is already in the replica — and nothing is re-stamped:
   * the entry is the write the application made.
   */
  const releaseConflict = async (actionId: string): Promise<void> => {
    await rehydrate();
    const entry = entries.find(
      (candidate) => candidate.action.id === actionId && candidate.status === "conflicted",
    );
    if (entry === undefined) return;
    const released: OutboxEntry = {
      action: entry.action,
      status: "pending",
      enqueuedAtHlc: entry.enqueuedAtHlc,
      basedOnGsn: entry.basedOnGsn,
    };
    await deps.store.put(released);
    entries = entries.map((candidate) => (candidate.action.id === actionId ? released : candidate));
    emit();
  };

  const runFlush = async (): Promise<FlushOutcome> => {
    // The first flush must include persisted entries even before a
    // caller has observed rehydration complete.
    await rehydrate();
    const batch = flushableEntries();
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

  /**
   * The `pending` writes the current component hold is keeping off the wire,
   * snapshotted before a verb moves the conflicted rows.
   */
  const heldPending = (holds: readonly ConflictHold[]): readonly OutboxEntry[] => {
    if (holds.length === 0) return [];
    return entries.filter(
      (entry) => entry.status === "pending" && actionTouchesHolds(entry.action, holds),
    );
  };

  /**
   * Delete the named `pending` writes, returning them so the caller can
   * revert their optimistic overlays. Each row is deleted from the store
   * before it leaves memory, so a failed delete leaves the row pending
   * rather than live in one place only. Rows whose status moved on are
   * left alone.
   */
  const dropHeld = async (actionIds: readonly string[]): Promise<readonly Action[]> => {
    if (actionIds.length === 0) return [];
    await rehydrate();
    const wanted = new Set(actionIds);
    const dropped: Action[] = [];
    for (const entry of entries) {
      if (entry.status !== "pending" || !wanted.has(entry.action.id)) continue;
      await deps.store.delete(entry.action.id);
      entries = entries.filter((candidate) => candidate.action.id !== entry.action.id);
      dropped.push(entry.action);
    }
    if (dropped.length > 0) emit();
    return dropped;
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
    // An acknowledged row is already on the server: only `pending` writes
    // can still be held off the wire, so only they are candidates.
    const candidates = entries.filter((entry) => entry.status === "pending");
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
      if (!window.some(({ action }) => isConcurrent(entry, action))) continue;
      const subjects: string[] = [];
      const subjectStates: LoserSubject[] = [];
      const slots: ConflictSlot[] = [];
      const holds: ConflictHold[] = [];
      const seen = new Set<string>();
      const scopes: ConflictScope[] = [];
      for (const [subjectId, pending] of actionWrites(entry.action)) {
        const inbound = folded.get(subjectId);
        if (inbound === undefined) continue;
        // A subject is at risk only when an Action that out-dates this
        // write touches it. `folded` covers the whole window, including a
        // touch already applied at authoring time (`gsn <= basedOnGsn`),
        // which is a deliberate override rather than a conflict.
        const concurrent: InboundSubject[] = [];
        for (const { action, subjects: actionSubjects } of window) {
          if (!isConcurrent(entry, action)) continue;
          const actionInbound = actionSubjects.get(subjectId);
          if (actionInbound !== undefined) concurrent.push(actionInbound);
        }
        if (concurrent.length === 0) continue;
        const overlap: ConflictSlot[] = [];
        const heldComponents = new Set<string>();
        const subjectScopes: ConflictScope[] = [];
        let holdsWholeSubject = false;
        for (const [component, pendingValue] of pending.components) {
          const declared = deps.conflictScope(inbound.model, component);
          // A structural component's writes converge and are never surfaced.
          if (deps.isStructural?.(inbound.model, component) ?? false) continue;
          if (declared === "entity") {
            // An entity-scope component surfaces any concurrent touch of the
            // row, whatever component the peer wrote.
            holdsWholeSubject = true;
            subjectScopes.push("entity");
            continue;
          }
          // A non-LWW component never surfaces a position.
          if (!(deps.isLwwField?.(inbound.model, component) ?? true)) continue;
          // A text body's `version` component declares its cell format; it
          // is metadata, not state, so a concurrent write never contests it.
          if (
            componentField(component) === DOC_VERSION_FIELD &&
            pending.components.has(componentName(inbound.model, DOC_CONTENT_FIELD))
          ) {
            continue;
          }
          for (const actionInbound of concurrent) {
            const remoteField = inbound.components.get(component);
            const winner = actionInbound.components.get(component);
            if (declared === "component") {
              // Any concurrent touch of this component contests it, even a
              // write to a different map key.
              if (winner === undefined && !actionInbound.deleted) continue;
              const key = slotKey({ subjectId, component, path: [] });
              if (!seen.has(key)) {
                seen.add(key);
                overlap.push(
                  conflictSlot({
                    subjectId,
                    component,
                    path: [],
                    pending: pendingValue,
                    remote: remoteField,
                  }),
                );
              }
              heldComponents.add(component);
              subjectScopes.push("component");
              continue;
            }
            const paths = winner !== undefined ? overlappingPaths(pendingValue, winner) : [];
            // A concurrent delete reverts every component the entry writes,
            // even one it omits.
            if (winner === undefined && actionInbound.deleted) paths.push([]);
            for (const path of paths) {
              const key = slotKey({ subjectId, component, path });
              if (seen.has(key)) continue;
              seen.add(key);
              overlap.push(
                conflictSlot({
                  subjectId,
                  component,
                  path,
                  pending: pendingValue,
                  remote: winner === undefined ? undefined : remoteField,
                }),
              );
            }
            if (paths.length > 0) {
              heldComponents.add(component);
              subjectScopes.push("field");
            }
          }
        }
        if (!holdsWholeSubject && heldComponents.size === 0) continue;
        subjects.push(subjectId);
        subjectStates.push({
          subjectId,
          model: inbound.model,
          before: deps.preSyncRow(catchUpId, subjectId),
        });
        slots.push(...overlap);
        if (holdsWholeSubject) holds.push({ subjectId });
        else for (const component of heldComponents) holds.push({ subjectId, component });
        // The conflict is as coarse as its loosest losing position.
        scopes.push(coarsestScope(subjectScopes));
      }
      if (subjects.length === 0) continue;
      // The remote half of the report: every concurrent missed Action that
      // touched a losing subject, in window order, one entry per Action.
      const losing = new Set(subjects);
      const remoteActions: ConflictRemoteAction[] = [];
      const reported = new Set<string>();
      for (const { action, subjects: actionSubjects } of window) {
        if (!isConcurrent(entry, action) || reported.has(action.id)) continue;
        if (![...losing].some((subjectId) => actionSubjects.has(subjectId))) continue;
        reported.add(action.id);
        remoteActions.push({ actorId: action.actor_id, actionId: action.id, gsn: action.gsn });
      }
      losers.push({
        id: entry.action.id,
        subjects,
        subjectStates,
        slots,
        holds,
        scope: coarsestScope(scopes),
        remoteActions,
      });
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
        holds: loser.holds,
        scope: loser.scope,
        remoteActions: loser.remoteActions,
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
    pending: () => flushableEntries(),
    errors: () => entries.filter((entry) => entry.status === "error"),
    heldPending,
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
    releaseConflict,
    clearError,
    clearConflict,
    dropHeld,
    matchEcho,
    detectConflicts,
  };
}
