import type { Action } from "@ebbjs/core";

/**
 * Lifecycle status of a buffered local Action. The store persists
 * whatever status the writer assigns; which transitions are legal, and
 * when they happen, is the client outbox's concern, not storage's.
 */
export type OutboxStatus = "pending" | "acknowledged" | "error";

/**
 * One locally-authored Action awaiting acknowledgement, plus the HLC at
 * which it entered the outbox.
 */
export interface OutboxEntry {
  readonly action: Action;
  readonly status: OutboxStatus;
  /**
   * Client HLC stamped when the Action was buffered. The ordering key
   * for `list()` — Actions must flush in the order they were authored,
   * independent of object-store iteration order.
   */
  readonly enqueuedAtHlc: string;
}

/**
 * OutboxStore — durable buffer of pending local Actions.
 *
 * Entries are keyed by `action.id`. Re-`put`ting an id replaces the
 * whole row, which is how a status transition is persisted; `list()`
 * returns entries in ascending `enqueuedAtHlc` order so a rehydrating
 * client replays them in authoring order.
 */
export interface OutboxStore {
  put(entry: OutboxEntry): Promise<void>;
  list(): Promise<readonly OutboxEntry[]>;
  get(actionId: string): Promise<OutboxEntry | null>;
  delete(actionId: string): Promise<void>;
  clear(): Promise<void>;
}
