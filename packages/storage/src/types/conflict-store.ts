import type { Action } from "@ebbjs/core";

/**
 * The server-side value that beat a losing Action for one field.
 * Mirrors the `FieldValue` triple the LWW comparison uses, so the
 * entry is self-describing across a reload.
 */
export interface ConflictWinner {
  /** `update_id` of the FieldValue that won. */
  readonly update_id: string;
  /** HLC carried by the winning FieldValue. */
  readonly hlc: string;
  readonly value: unknown;
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
   * Winning value per conflicting field, keyed by field name. The keys
   * are exactly the fields in `fields`.
   */
  readonly winners: Readonly<Record<string, ConflictWinner>>;
  /**
   * Conflicting field names in detection order. This is the entry's
   * only cross-field ordering promise — map key order carries no
   * meaning.
   */
  readonly fields: readonly string[];
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
