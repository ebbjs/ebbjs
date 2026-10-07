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
 * `noteInbound` drives the sync-echo leg: the single inbound funnel
 * (`SyncClient._applyAction`) hands every received Action here, and an
 * Action that matches a buffered entry with a server GSN proves the
 * entry is in the canonical log and removes it.
 *
 * The module depends only on injected seams: the store, an HLC source
 * for the ordering key, `applyOptimistic` (the client wires it to the
 * entity cache + change emitter), and `submit` (the network write).
 * The client remains the only place that knows about the concrete
 * storage adapter and fetch.
 */

import { compare, type Action } from "@ebbjs/core";
import type { OutboxStore } from "@ebbjs/storage/types";

import type { Rejection, WriteResponse } from "./types";

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
 * `conflict` is the seam the conflict layer fills in (#308). #230 only
 * ever produces `echo` or `none`.
 */
export type InboundOutcome =
  | { kind: "echo"; actionId: string }
  | { kind: "conflict"; actionId: string; fields: readonly string[] }
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
   * removes an entry.
   */
  store: OutboxStore;
  /** Stamp a fresh HLC for an entry's `enqueuedAtHlc` ordering key. */
  hlc: () => string;
}

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
   * Match an inbound Action against the buffer. An Action whose id
   * matches a `pending` / `acknowledged` entry and that carries a
   * server GSN (`gsn > 0`) is this client's own echo: it is removed
   * from memory and the store, and reported as `echo`. Anything else
   * is `none`. The `conflict` branch is reserved for #308.
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
    // an echo removed while the submit was in flight — re-`put`ting after
    // that `delete` would resurrect a row no future echo can clear.
    for (const entry of batch) {
      if (!entries.some((candidate) => candidate.action.id === entry.action.id)) continue;
      const status = statusFor(entry);
      await deps.store.put({ action: entry.action, status, enqueuedAtHlc: entry.enqueuedAtHlc });
      if (!entries.some((candidate) => candidate.action.id === entry.action.id)) {
        // The echo's `delete` interleaved with this `put`. Re-delete so the
        // row stays gone even if the put landed last and resurrected it.
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
    // this client's own echo.
    if (action.gsn <= 0) return { kind: "none" };
    // An echo can arrive before a caller has awaited rehydration (SSE is
    // live from construction), so match against the loaded buffer rather
    // than whatever happens to be in memory already.
    let match: OutboxEntry | undefined;
    try {
      await rehydrate();
      match = entries.find(
        (entry) =>
          entry.action.id === action.id &&
          (entry.status === "pending" || entry.status === "acknowledged"),
      );
    } catch {
      // The receipt hook is best-effort: the Action is already durable in
      // the log when this runs, so a store read failure must not break the
      // inbound funnel. The entry stays for a later echo or reload.
      return { kind: "none" };
    }
    // #308 extends this hook with the `conflict` branch: an inbound
    // Action that is not this client's echo but whose Updates out-date a
    // pending entry's LWW fields moves that entry to the ConflictStore.
    // A documented no-op here — the seam is frozen, the policy is not.
    if (match === undefined) return { kind: "none" };
    try {
      await deps.store.delete(action.id);
    } catch {
      // Keep memory and the store agreeing: the row survives until a
      // later attempt can delete both.
      return { kind: "none" };
    }
    entries = entries.filter((entry) => entry.action.id !== action.id);
    return { kind: "echo", actionId: action.id };
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
