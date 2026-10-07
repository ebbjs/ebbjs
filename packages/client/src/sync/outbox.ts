/**
 * Outbox — the local write buffer sitting between callers and the
 * `/sync/actions` network path.
 *
 * Every locally-authored Action is `enqueue`d — persisted to the
 * injected `OutboxStore`, appended to the in-memory queue, and
 * optimistically applied to the local cache — and then `flush`ed to
 * the server. The store is durable, so construction rehydrates the
 * pending entries back into the queue; removing entries from the store
 * lands with the ack/error sub-issue.
 *
 * The module depends only on injected seams: the store, an HLC source
 * for the ordering key, `applyOptimistic` (the client wires it to the
 * entity cache + change emitter), and `submit` (the network write).
 * The client remains the only place that knows about the concrete
 * storage adapter and fetch.
 */

import { compare, type Action } from "@ebbjs/core";
import type { OutboxStore } from "@ebbjs/storage/types";

import type { WriteResponse } from "./types";

/**
 * Entry status. Only `pending` exists in this stage; `acknowledged`
 * and `error` arrive with the ack sub-issue of the parent.
 */
export type OutboxStatus = "pending";

/** One buffered Action and its lifecycle status. */
export interface OutboxEntry {
  readonly action: Action;
  readonly status: OutboxStatus;
  /** HLC stamped when the Action was buffered; the durable ordering key. */
  readonly enqueuedAtHlc: string;
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
   * source rehydration reads pending entries back from. Entries are
   * written status `pending`; removal is the ack/error stage's job.
   */
  store: OutboxStore;
  /** Stamp a fresh HLC for an entry's `enqueuedAtHlc` ordering key. */
  hlc: () => string;
}

/**
 * The write-buffer surface. `pending()` and `size()` are the
 * observability hooks the later telemetry sub-issue builds on.
 */
export interface Outbox {
  enqueue(action: Action): Promise<void>;
  /** Entries in submission order. A snapshot: callers cannot mutate the queue through it. */
  pending(): readonly OutboxEntry[];
  size(): number;
  /**
   * Load persisted pending entries into the in-memory queue. Runs
   * eagerly at construction as a single-flight operation (idempotent);
   * returns that same promise so callers can await it. Rehydrated
   * entries are seeded only — never optimistically re-applied, since
   * they were already applied before the reload.
   */
  rehydrate(): Promise<void>;
  /**
   * Submit every currently-buffered Action as one batch. Resolves
   * with the server's response on success; the submitted entries are
   * removed. Rejects (and keeps the entries pending) when the
   * request throws. Entries enqueued while the request is in flight
   * stay pending.
   */
  flush(): Promise<WriteResponse>;
}

/**
 * Build an Outbox backed by a durable store. Each `flush()` submits
 * exactly the entries pending when it was called and removes those
 * entries by identity on success, so an `enqueue` racing a flush is
 * never dropped by the flush's cleanup.
 */
export function createOutbox(deps: OutboxDependencies): Outbox {
  let entries: readonly OutboxEntry[] = [];
  let rehydration: Promise<void> | null = null;

  const rehydrate = (): Promise<void> => {
    rehydration ??= deps.store.list().then((persisted) => {
      entries = persisted
        .filter((entry) => entry.status === "pending")
        .sort((a, b) => compare(a.enqueuedAtHlc, b.enqueuedAtHlc))
        .map((entry) => ({
          action: entry.action,
          status: "pending" as const,
          enqueuedAtHlc: entry.enqueuedAtHlc,
        }));
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

  const flush = async (): Promise<WriteResponse> => {
    // The first flush must include persisted entries even before a
    // caller has observed rehydration complete.
    await rehydrate();
    const batch = entries;
    if (batch.length === 0) return { rejected: [] };
    const response = await deps.submit(batch.map((entry) => entry.action));
    const submitted = new Set(batch);
    entries = entries.filter((entry) => !submitted.has(entry));
    return response;
  };

  // Rehydrate without caller involvement. A rejected `list()` must not
  // surface as an unhandled rejection; awaiting callers still see it.
  void rehydrate().catch(() => {});

  return {
    enqueue,
    rehydrate,
    pending: () => [...entries],
    size: () => entries.length,
    flush,
  };
}
