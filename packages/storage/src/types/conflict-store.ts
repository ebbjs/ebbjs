import type { Action } from "@ebbjs/core";

/**
 * The server-side value that beat a losing Action for one slot. Mirrors
 * the `FieldValue` the LWW comparison uses, so the entry is
 * self-describing across a reload. A whole-field replacement by an
 * incoming map has no single leaf triple, so `update_id` / `hlc` are
 * absent and `value` is the projected map.
 */
export interface ConflictWinner {
  /** `update_id` of the winning FieldValue; absent for a whole-field map winner. */
  readonly update_id?: string;
  /** HLC carried by the winning FieldValue; absent for a whole-field map winner. */
  readonly hlc?: string;
  readonly value: unknown;
}

/**
 * One conflicting slot on a losing Action: a field plus the map-key path
 * from the field root to the lost leaf. `path` is empty for a plain leaf
 * field. Concurrent writes to different keys are different slots and so
 * are not conflicts; concurrent writes to the same slot are.
 */
export interface ConflictSlot {
  /** The `subject_id` of the Update that carried the write. */
  readonly subjectId: string;
  /** The field name on that subject. */
  readonly field: string;
  /** Ordered map keys from the field root to the leaf; empty for a leaf field. */
  readonly path: readonly string[];
}

/** One lost slot on a losing Action, plus the server value that beat it. */
export interface ConflictLoss {
  readonly slot: ConflictSlot;
  readonly winner: ConflictWinner;
}

/**
 * One losing pending Action plus the server state that beat it. Written
 * by the rebase/detection phase and read back by the application's
 * resolution surface.
 */
export interface ConflictEntry {
  /**
   * The losing Action, moved whole out of the Outbox so the write
   * stays atomic. Its `id` is the store key.
   */
  readonly action: Action;
  /**
   * Losing slots and their winners, in detection order. This is the
   * entry's only cross-slot ordering promise — map key order carries no
   * meaning.
   */
  readonly losses: readonly ConflictLoss[];
  /** Client HLC stamped at detection. The `list()` ordering key. */
  readonly detectedAtHlc: string;
}

/**
 * ConflictStore — durable table of LWW conflicts awaiting application
 * resolution.
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
