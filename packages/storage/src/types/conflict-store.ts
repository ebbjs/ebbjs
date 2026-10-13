import type { Action } from "@ebbjs/core";

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
 * One losing local Action and the catch-up pass that detected it.
 * Written by detection and read back by the application's resolution
 * surface. Keyed by `action.id`.
 */
export interface ConflictEntry {
  /** The losing Action, moved whole out of the Outbox so the write stays atomic. */
  readonly action: Action;
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
  /** Highest server GSN the client had applied when the Action was authored. */
  readonly basedOnGsn: number;
  /** The catch-up pass that produced this entry. */
  readonly catchUpId: string;
  /**
   * Stamped at detection and persisted, so it survives a reload and
   * partial resolution. Grouping is the connected set of losing
   * subjects within one `catchUpId`.
   */
  readonly conflictId: string;
  /** Client HLC stamped at detection. The `list()` ordering key. */
  readonly detectedAtHlc: string;
}

/**
 * ConflictStore — durable table of offline conflicts awaiting
 * application resolution.
 *
 * Entries are keyed by the losing `action.id`; re-`put`ting an id
 * replaces the whole row. `list()` returns entries in ascending
 * `detectedAtHlc` order (packed BigInt HLC strings do not sort
 * numerically under IndexedDB's default comparator, so ordering is
 * done in memory with `@ebbjs/core`'s `compare`, same as OutboxStore).
 */
export interface ConflictStore {
  put(entry: ConflictEntry): Promise<void>;
  list(): Promise<readonly ConflictEntry[]>;
  get(actionId: string): Promise<ConflictEntry | null>;
  delete(actionId: string): Promise<void>;
  clear(): Promise<void>;
}
