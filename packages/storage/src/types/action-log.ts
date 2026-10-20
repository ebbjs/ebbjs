import type { Action, Update } from "@ebbjs/core";

/**
 * One entry in the append-ordered action log.
 *
 * `position` is the log's own monotonic append cursor. It exists because
 * the server `gsn` is not a total log cursor: an Action can arrive once
 * per group (#473), `gsn: 0` is legal (#475 backfill), and a `gsn` cannot
 * distinguish "already folded into the persisted replica" from
 * "appended after it". The replica loads a persisted base at `position`
 * and replays `readTail(position)`.
 */
export interface LoggedAction {
  /**
   * The merged Action. A repeated id (#473) reports the union of every
   * Update delivered for that id, not just this delivery's slice.
   */
  readonly action: Action;
  /** The log-local append cursor for this Action. Stable across re-delivery. */
  readonly position: number;
  /**
   * The Updates to fold. For `append`, only those not already logged for
   * this id — a repeated Action id (`#473`) can carry disjoint per-group
   * copies, and folding a whole re-delivered copy would re-apply an older
   * `put` and revert a newer `patch`. For `readTail`, every Update of the
   * merged Action.
   */
  readonly added: readonly Update[];
}

/**
 * ActionLog — the append-ordered, id-keyed source of truth.
 *
 * The replica's durable log. `append` returns the newly-added Updates and
 * the log-local position; `readTail` replays the entries after a
 * watermark. `getAll` / `getForEntity` remain for the entity store that
 * still backs the pre-replica read path.
 *
 * ## Methods
 * - `append(action)` — stores or merges an Action, returns the delta + position
 * - `appendMany(actions)` — `append` for a batch, in one durable write
 * - `readTail(afterPosition)` — every entry with `position > afterPosition`, in order
 * - `lastPosition()` — the log's current append cursor
 * - `getAll()` — returns all merged Actions
 * - `getForEntity(entityId)` — returns all Actions affecting an entity, sorted by gsn
 * - `clear()` — removes all actions (used for reset)
 */
export interface ActionLog {
  append(action: Action): Promise<LoggedAction>;
  /**
   * Append every Action in one durable write (one IndexedDB transaction), in
   * order, returning the same entries `append` would. A listing seed writes a
   * page this way: the page is the unit that must land whole or not at all
   * (#476).
   */
  appendMany(actions: readonly Action[]): Promise<readonly LoggedAction[]>;
  readTail(afterPosition: number): Promise<readonly LoggedAction[]>;
  lastPosition(): Promise<number>;
  getAll(): Promise<readonly Action[]>;
  getForEntity(entityId: string): Promise<readonly Action[]>;
  clear(): Promise<void>;
}
