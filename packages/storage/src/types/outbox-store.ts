import type { Action } from "@ebbjs/core";

/**
 * Lifecycle status of a buffered local Action. The store persists
 * whatever status the writer assigns; which transitions are legal, and
 * when they happen, is the client outbox's concern, not storage's.
 *
 * `conflicted` is a terminal-until-resolved hold: a catch-up pass
 * classified the Action as a loser, so it is structurally excluded from
 * `pending()` and never submitted. The application resolves it by
 * retrying (back to `pending`) or discarding (removed).
 */
export type OutboxStatus = "pending" | "acknowledged" | "error" | "conflicted";

/**
 * One side of a contested slot: the buffered local write, or the value
 * the server holds once the catch-up window is applied. A leaf carries
 * its LWW triple; a whole-field map replacement has no single leaf, so
 * `update_id` / `hlc` are absent and `value` is the projected map. A
 * field an inbound `put` or `delete` reverted also has no triple, and
 * `value` is `undefined` because the server holds no value.
 */
export interface ConflictSide {
  /** Projected leaf or map value. `undefined` when the server holds nothing. */
  readonly value: unknown;
  /** `update_id` of the FieldValue; absent for a map side or a reverted field. */
  readonly update_id?: string;
  /** HLC carried by the FieldValue; absent for a map side or a reverted field. */
  readonly hlc?: string;
}

/**
 * One contested position on a losing Action: a field plus the map-key
 * path from the field root to the position. `path` is empty for a plain
 * leaf field, an entity-level touch that overlaps no position, or a
 * field an inbound `put` / `delete` reverted. Concurrent writes to
 * different keys are different slots and so are not conflicts.
 */
export interface ConflictSlot {
  /** The `subject_id` of the Update that carried the write. */
  readonly subjectId: string;
  /** The field name on that subject. */
  readonly field: string;
  /** Ordered map keys from the field root to the position; empty at the root. */
  readonly path: readonly string[];
  /** The buffered local value at the position. */
  readonly local: ConflictSide;
  /** The value the server holds at the position after the missed window. */
  readonly remote: ConflictSide;
}

/**
 * The conflict payload detection stamps onto a losing Action's outbox
 * row. It travels with the row rather than in a second store, so the
 * hold and the record are the same durable write and cannot disagree.
 */
export interface OutboxConflict {
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
  readonly slots: readonly ConflictSlot[];
  /** The catch-up pass that produced this entry. */
  readonly catchUpId: string;
  /**
   * Stamped at detection and persisted, so it survives a reload and
   * partial resolution. Grouping is the connected set of losing
   * subjects within one `catchUpId`.
   */
  readonly conflictId: string;
  /** Client HLC stamped at detection. The conflict view's ordering key. */
  readonly detectedAtHlc: string;
}

/**
 * One locally-authored Action awaiting acknowledgement, plus the HLC at
 * which it entered the outbox. A `conflicted` entry carries its
 * {@link OutboxConflict} payload; the field is absent for every other
 * status.
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
  /**
   * Highest server GSN the client had applied when the Action was
   * authored. Catch-up detection treats an inbound Action as concurrent
   * when its GSN is greater; `0` means "always concurrent", so a legacy
   * or base-less entry is never silently dropped.
   */
  readonly basedOnGsn: number;
  /** Present iff `status === "conflicted"`. */
  readonly conflict?: OutboxConflict;
}

/**
 * OutboxStore — durable buffer of pending local Actions.
 *
 * Entries are keyed by `action.id`. Re-`put`ting an id replaces the
 * whole row, which is how a status transition — including a detection
 * that stamps a conflict payload — is persisted; `list()` returns
 * entries in ascending `enqueuedAtHlc` order so a rehydrating client
 * replays them in authoring order.
 */
export interface OutboxStore {
  put(entry: OutboxEntry): Promise<void>;
  /**
   * Persist `entry` and delete `deleteId` in one durable operation. Used
   * to resolve a conflict by retrying: the fresh re-assert must never
   * exist without the conflicted row being gone, nor the row be gone
   * without the re-assert persisted.
   */
  putAndDelete(entry: OutboxEntry, deleteId: string): Promise<void>;
  list(): Promise<readonly OutboxEntry[]>;
  get(actionId: string): Promise<OutboxEntry | null>;
  delete(actionId: string): Promise<void>;
  clear(): Promise<void>;
}
