/**
 * Outbox — the local write buffer sitting between callers and the
 * `/sync/actions` network path.
 *
 * Every locally-authored Action is `enqueue`d (optimistically applied
 * to the local cache) and then `flush`ed to the server. Today the
 * buffer is in-memory only: there is no durability, retry, or ack
 * tracking yet. The seam exists so those stages can land without
 * touching every write caller.
 *
 * The module is storage- and transport-agnostic. `applyOptimistic`
 * performs the optimistic local apply (the client wires it to the
 * entity cache + change emitter); `submit` performs the network write.
 * Both are injected so the pending-list logic is testable in isolation
 * and the client remains the only place that knows about storage and
 * fetch.
 */

import type { Action } from "@ebbjs/core";

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
   * Submit every currently-buffered Action as one batch. Resolves
   * with the server's response on success; the submitted entries are
   * removed. Rejects (and keeps the entries pending) when the
   * request throws. Entries enqueued while the request is in flight
   * stay pending.
   */
  flush(): Promise<WriteResponse>;
}

/**
 * Build an in-memory Outbox. Each `flush()` submits exactly the
 * entries pending when it was called and removes those entries by
 * identity on success, so an `enqueue` racing a flush is never
 * dropped by the flush's cleanup.
 */
export function createOutbox(deps: OutboxDependencies): Outbox {
  let entries: readonly OutboxEntry[] = [];

  const enqueue = async (action: Action): Promise<void> => {
    // Buffer before applying: a slow optimistic apply must not let a
    // concurrent flush miss the entry.
    entries = [...entries, { action, status: "pending" }];
    await deps.applyOptimistic(action);
  };

  const flush = async (): Promise<WriteResponse> => {
    const batch = entries;
    if (batch.length === 0) return { rejected: [] };
    const response = await deps.submit(batch.map((entry) => entry.action));
    const submitted = new Set(batch);
    entries = entries.filter((entry) => !submitted.has(entry));
    return response;
  };

  return {
    enqueue,
    pending: () => [...entries],
    size: () => entries.length,
    flush,
  };
}
