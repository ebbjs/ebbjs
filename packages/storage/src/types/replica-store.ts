import type { Entity } from "@ebbjs/core";

/**
 * The persisted form of the materialized replica — the replica at rest.
 *
 * `position` is the `ActionLog` append cursor the record was taken at:
 * load is `record ⊕ readTail(record.position)`. `revision` is the
 * replica's observable-content version at that point. `entities` is the
 * row-shaped entity set; derived indices are rebuilt on load, never
 * persisted, because IndexedDB cannot index nested `FieldValue` paths,
 * express live-row filtering, or query a stored map.
 */
export interface ReplicaRecord {
  /** Shape version of this record. A record of an unknown format reads as absent. */
  readonly format: number;
  /** The log position the record was taken at. */
  readonly position: number;
  /** The replica's revision when the record was taken. */
  readonly revision: number;
  readonly entities: readonly Entity[];
}

/**
 * ReplicaStore — single-slot persistence for the materialized replica.
 *
 * Only ever a fast path. Correctness never depends on the record
 * existing: an absent or corrupt record reads as `null` so the caller
 * falls back to full log replay rather than hydrating a partial base.
 */
export interface ReplicaStore {
  load(): Promise<ReplicaRecord | null>;
  save(record: ReplicaRecord): Promise<void>;
  clear(): Promise<void>;
}
