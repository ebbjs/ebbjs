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
 * `noteInbound` drives the receipt leg: the single inbound funnel
 * (`SyncClient._applyAction`) hands every received Action here. An
 * Action that matches a buffered entry with a server GSN proves the
 * entry is in the canonical log and removes it (echo); a peer Action
 * that out-dates a pending entry's LWW field moves that entry to the
 * Conflicts store so it is never posted.
 *
 * The module depends only on injected seams: the store, an HLC source
 * for the ordering key, `applyOptimistic` (the client wires it to the
 * entity cache + change emitter), and `submit` (the network write).
 * The client remains the only place that knows about the concrete
 * storage adapter and fetch.
 */

import {
  compare,
  isFieldMap,
  mergeFieldValue,
  type Action,
  type FieldValue,
  type Update,
} from "@ebbjs/core";
import type {
  ConflictEntry,
  ConflictLoss,
  ConflictSlot,
  ConflictStore,
  ConflictWinner,
  OutboxStore,
} from "@ebbjs/storage/types";

import type { Rejection, WriteResponse } from "./types";
import { projectFieldValue } from "./query-builder";

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
 * `echo` is this client's own Action returning over the sync stream;
 * `conflict` names a pending Action an inbound LWW write out-dated and
 * that was moved to the Conflicts store. When one inbound Action moves
 * several entries, `actionId` is the first moved and the store is the
 * source of truth for the rest.
 */
export type InboundOutcome =
  | { kind: "echo"; actionId: string }
  | { kind: "conflict"; actionId: string; slots: readonly ConflictSlot[] }
  | { kind: "none" };

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
   * Durable table of LWW conflicts awaiting application resolution.
   * A pending Action the inbound stream out-dates on one of its LWW
   * fields is moved here whole, so the write survives the sweep.
   */
  conflicts: ConflictStore;
  /**
   * Field-kind oracle: `true` when `field` on `subjectType` merges
   * last-writer-wins, so an inbound write can silently overwrite a
   * pending local one. Counter and collaborative-text fields return
   * `false`. Structural edge subject types are excluded regardless.
   * Defaults to every non-structural field being LWW.
   */
  isLwwField?: (subjectType: string, field: string) => boolean;
  /** Stamp a fresh HLC for an entry's `enqueuedAtHlc` ordering key. */
  hlc: () => string;
}

/**
 * Subject types whose Updates carry structural edges, not LWW field
 * writes: a `relationship` edge, an `entityGroup` membership, and a
 * `groupMember` permission row. Concurrent writes to edges are never
 * surfaced as LWW conflicts.
 */
const STRUCTURAL_SUBJECT_TYPES: ReadonlySet<string> = new Set([
  "relationship",
  "entityGroup",
  "groupMember",
]);

/** A pending Action an inbound Action out-dates, with its losing slots. */
interface LosingEntry {
  readonly entry: OutboxEntry;
  readonly losses: readonly ConflictLoss[];
}

/**
 * The field map an Update carries. Tolerates a peer's unwrapped
 * envelope: a missing `fields` map means the Update writes no field.
 */
const updateFields = (update: Update): Record<string, FieldValue> | undefined =>
  update.data?.fields as Record<string, FieldValue> | undefined;

/** The effective FieldValue a pending Action wrote to `field` on `subjectId`. */
const pendingFieldValue = (
  action: Action,
  subjectId: string,
  field: string,
): FieldValue | undefined => {
  let merged: FieldValue | undefined;
  for (const update of action.updates) {
    if (update.subject_id !== subjectId) continue;
    const value = updateFields(update)?.[field];
    if (value === undefined) continue;
    merged = merged === undefined ? value : mergeFieldValue(merged, value);
  }
  return merged;
};

/**
 * Whether the inbound FieldValue beats the pending one under the
 * per-field LWW rule the server and the local materializer share:
 * higher HLC wins, equal HLC breaks toward the lexicographically
 * greater `update_id`.
 */
const inboundWins = (inbound: FieldValue, pending: FieldValue): boolean => {
  const order = compare(inbound.hlc ?? "", pending.hlc ?? "");
  if (order !== 0) return order > 0;
  return (inbound.update_id ?? "") >= (pending.update_id ?? "");
};

/** True when an inbound write to `field` can silently overwrite a local one. */
const isConflictableField = (
  isLwwField: OutboxDependencies["isLwwField"],
  subjectType: string,
  field: string,
): boolean =>
  !STRUCTURAL_SUBJECT_TYPES.has(subjectType) && (isLwwField?.(subjectType, field) ?? true);

/** The winner reported for one lost slot. */
const winnerFor = (value: FieldValue): ConflictWinner =>
  isFieldMap(value)
    ? { value: projectFieldValue(value) }
    : { update_id: value.update_id, hlc: value.hlc ?? "", value: value.value };

/**
 * The slots an inbound value out-dates in a pending one, in map-key
 * order. Maps recurse key by key, so a write to a key the pending
 * Action never wrote is not a loss. A kind change replaces the whole
 * field, so it is attributed to the path where the kinds diverge (the
 * field root for a top-level change).
 */
const compareFieldValues = (
  pending: FieldValue,
  inbound: FieldValue,
  subjectId: string,
  field: string,
  path: readonly string[],
): ConflictLoss[] => {
  if (isFieldMap(pending) && isFieldMap(inbound)) {
    const losses: ConflictLoss[] = [];
    for (const [key, inboundChild] of Object.entries(inbound.map)) {
      const pendingChild = pending.map[key];
      if (pendingChild === undefined) continue;
      losses.push(
        ...compareFieldValues(pendingChild, inboundChild, subjectId, field, [...path, key]),
      );
    }
    return losses;
  }
  if (isFieldMap(pending) !== isFieldMap(inbound)) {
    return [{ slot: { subjectId, field, path }, winner: winnerFor(inbound) }];
  }
  if (!inboundWins(inbound, pending)) return [];
  return [{ slot: { subjectId, field, path }, winner: winnerFor(inbound) }];
};

/**
 * Find the pending entries an inbound Action out-dates, in buffer
 * order. An entry loses when the Action writes a slot the entry also
 * targets with a weaker FieldValue; the whole entry moves, so one
 * losing slot is enough. A repeated inbound write per `(subject,
 * field)` is folded before comparison, so a malformed Action that
 * repeats a field is still judged on its effective state.
 */
const findLosingEntries = (
  entries: readonly OutboxEntry[],
  action: Action,
  isLwwField: OutboxDependencies["isLwwField"],
): LosingEntry[] => {
  const writes = new Map<
    string,
    { subjectType: string; subjectId: string; field: string; value: FieldValue }
  >();
  for (const update of action.updates) {
    const fields = updateFields(update);
    if (fields === undefined) continue;
    for (const [field, value] of Object.entries(fields)) {
      const key = `${update.subject_id}\u0000${field}`;
      const previous = writes.get(key);
      writes.set(key, {
        subjectType: update.subject_type,
        subjectId: update.subject_id,
        field,
        value: previous === undefined ? value : mergeFieldValue(previous.value, value),
      });
    }
  }

  const losers: LosingEntry[] = [];
  for (const entry of entries) {
    if (entry.status !== "pending") continue;
    const losses: ConflictLoss[] = [];
    for (const write of writes.values()) {
      if (!isConflictableField(isLwwField, write.subjectType, write.field)) continue;
      const pending = pendingFieldValue(entry.action, write.subjectId, write.field);
      if (pending === undefined) continue;
      losses.push(...compareFieldValues(pending, write.value, write.subjectId, write.field, []));
    }
    if (losses.length > 0) losers.push({ entry, losses });
  }
  return losers;
};

/**
 * The write-buffer surface. `size()` and `errors()` are the
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
   * Depth of the entries carrying `status`, defaulting to `pending`
   * (the flushable backlog). The pending / acknowledged / error
   * counters #125 consumes.
   */
  size(status?: OutboxStatus): number;
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
   * - An Action whose id matches a `pending` / `acknowledged` entry and
   *   that carries a server GSN (`gsn > 0`) is this client's own echo:
   *   it is removed from memory and the store, and reported as `echo`.
   * - Otherwise, a `gsn > 0` Action that out-dates an LWW field a
   *   `pending` entry also targets moves the whole losing Action to the
   *   Conflicts store and reports `conflict`. Counter,
   *   collaborative-text, and structural edge fields never conflict.
   * - Anything else is `none`.
   */
  noteInbound(action: Action): Promise<InboundOutcome>;
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
          }));
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
    // Persist before buffering: a store failure must not leave the
    // in-memory queue holding an entry the store never saw.
    await deps.store.put({ action, status: "pending", enqueuedAtHlc });
    entries = [...entries, { action, status: "pending", enqueuedAtHlc }];
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
    for (const entry of batch) {
      if (!entries.some((candidate) => candidate.action.id === entry.action.id)) continue;
      const status = statusFor(entry);
      await deps.store.put({ action: entry.action, status, enqueuedAtHlc: entry.enqueuedAtHlc });
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
    });
    entries = entries.map((c) => (c.action.id === actionId ? { ...c, status: "pending" } : c));
  };

  const clearError = async (actionId: string): Promise<void> => {
    await rehydrate();
    const entry = entries.find((c) => c.action.id === actionId && c.status === "error");
    if (entry === undefined) return;
    await deps.store.delete(actionId);
    entries = entries.filter((c) => c.action.id !== actionId);
  };

  const noteInbound = async (action: Action): Promise<InboundOutcome> => {
    // gsn 0 means the server has not accepted the Action, so it cannot be
    // this client's own echo and cannot out-date a local write.
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

    // Own echo removes the entry once the server proves it canonical.
    const echo = entries.find(
      (entry) =>
        entry.action.id === action.id &&
        (entry.status === "pending" || entry.status === "acknowledged"),
    );
    if (echo !== undefined) {
      try {
        await deps.store.delete(action.id);
      } catch {
        // Keep memory and the store agreeing: the row survives until a
        // later attempt can delete both.
        return { kind: "none" };
      }
      entries = entries.filter((entry) => entry.action.id !== action.id);
      return { kind: "echo", actionId: action.id };
    }

    // A peer's Action out-dating a pending entry's LWW field moves the
    // whole losing Action to the Conflicts store, never the wire. Keeping
    // a flush already in flight off the entry is #309's gating concern.
    const losers = findLosingEntries(entries, action, deps.isLwwField);
    if (losers.length === 0) return { kind: "none" };

    const detectedAtHlc = deps.hlc();
    let first: LosingEntry | undefined;
    for (const loser of losers) {
      const conflict: ConflictEntry = {
        action: loser.entry.action,
        losses: loser.losses,
        detectedAtHlc,
      };
      try {
        await deps.conflicts.put(conflict);
      } catch {
        // Durable buffer first: leave the entry pending rather than
        // dropping the write; the next inbound Action re-runs detection.
        continue;
      }
      try {
        await deps.store.delete(loser.entry.action.id);
      } catch {
        // Roll the conflict row back so the two durable stores agree and
        // the entry stays flushable for a later sweep.
        await deps.conflicts.delete(loser.entry.action.id).catch(() => {});
        continue;
      }
      entries = entries.filter((entry) => entry.action.id !== loser.entry.action.id);
      first ??= loser;
    }

    if (first === undefined) return { kind: "none" };
    return {
      kind: "conflict",
      actionId: first.entry.action.id,
      slots: first.losses.map((loss) => loss.slot),
    };
  };

  // Rehydrate without caller involvement. A rejected `list()` must not
  // surface as an unhandled rejection; awaiting callers still see it.
  void rehydrate().catch(() => {});

  return {
    enqueue,
    rehydrate,
    pending: () => entries.filter((entry) => entry.status === "pending"),
    errors: () => entries.filter((entry) => entry.status === "error"),
    size: (status: OutboxStatus = "pending") =>
      entries.filter((entry) => entry.status === status).length,
    flush,
    retry,
    clearError,
    noteInbound,
  };
}
