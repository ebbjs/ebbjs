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
 *
 * Residency is per component (#802): `entities` carry only the components the
 * policy holds, and `notResident` names the components a persisted row still
 * has without its value. A row whose every component is on demand is not
 * persisted at all.
 */
export interface ReplicaRecord {
  /** Shape version of this record. A record of an unknown format reads as absent. */
  readonly format: number;
  /** The log position the record was taken at. */
  readonly position: number;
  /** The replica's revision when the record was taken. */
  readonly revision: number;
  /** Rows with their held components only. */
  readonly entities: readonly Entity[];
  /**
   * Component names present on a persisted row whose value is not resident,
   * keyed by entity id. Existence survives a restart without the value.
   */
  readonly notResident?: Readonly<Record<string, readonly string[]>>;
  /** The declared version each persisted component was materialized at (#804). */
  readonly componentVersions: Readonly<Record<string, Readonly<Record<string, number>>>>;
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
