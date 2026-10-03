import type { Entity } from "@ebbjs/core";

/**
 * Derivation of the `(field, type, target_id) → relationship row`
 * reverse index shared by every EntityStore adapter. The adapters own
 * the storage medium; this module owns the mapping from a materialized
 * Relationship row to its index entry so the two implementations
 * cannot drift.
 *
 * The index answers "which sources point at this target through this
 * accessor?", the read behind a relationship-aware `.where` predicate.
 * It keys on the relationship ROW, not the source: two rows may share a
 * natural key (same source, field, type, target), and dropping one must
 * not erase a source the other still supplies. The distinct source ids
 * are derived from the live rows at read time.
 */

export interface RelationshipEntry {
  readonly key: string;
  readonly rowId: string;
  readonly sourceId: string;
}

/** Live relationship rows under one composite key: rowId → sourceId. */
export type RelationshipRows = Readonly<Record<string, string>>;

/** The entity type carried by a materialized Relationship row. */
export const RELATIONSHIP_ENTITY_TYPE = "relationship";

/**
 * Composite index key. NUL is outside the nanoid alphabet, so it is
 * safe as a separator for the ids and accessor names that make up a
 * key.
 */
export const relationshipIndexKey = (field: string, type: string, targetId: string): string =>
  `${field}\u0000${type}\u0000${targetId}`;

const readStringField = (entity: Entity, name: string): string | null => {
  const value = entity.data?.fields?.[name]?.value;
  return typeof value === "string" ? value : null;
};

/**
 * The index entry a materialized entity contributes, or `null` when
 * it contributes none. Non-relationship rows, tombstoned rows, and
 * rows missing part of the Relationship field envelope all index
 * nothing — the last case keeps a malformed row from poisoning the
 * index with a partial key.
 */
export const relationshipEntryFor = (entity: Entity): RelationshipEntry | null => {
  if (entity.type !== RELATIONSHIP_ENTITY_TYPE) return null;
  if (entity.deleted_hlc !== null) return null;

  const field = readStringField(entity, "field");
  const type = readStringField(entity, "type");
  const targetId = readStringField(entity, "target_id");
  const sourceId = readStringField(entity, "source_id");
  if (field === null || type === null || targetId === null || sourceId === null) return null;

  return { key: relationshipIndexKey(field, type, targetId), rowId: entity.id, sourceId };
};

/**
 * Ascending id order, so both adapters return the same sequence for
 * the same rows regardless of insertion order.
 */
export const sortSourceIds = (ids: Iterable<string>): string[] => [...ids].sort();

/**
 * Distinct source ids of the live rows under one key, ascending.
 * Deduplicated because several rows may carry the same source.
 */
export const liveSourceIds = (rows: RelationshipRows | undefined): string[] =>
  sortSourceIds(new Set(Object.values(rows ?? {})));

/**
 * Apply one row to a key's live-row map, returning the next map. A
 * `null` return means no live rows remain, so the caller drops the key.
 */
export const applyRelationshipEntry = (
  rows: RelationshipRows | undefined,
  entry: RelationshipEntry,
  present: boolean,
): RelationshipRows | null => {
  const next: Record<string, string> = { ...rows };
  if (present) next[entry.rowId] = entry.sourceId;
  else delete next[entry.rowId];
  return Object.keys(next).length === 0 ? null : next;
};

export interface RelationshipIndexDelta {
  readonly remove: RelationshipEntry | null;
  readonly add: RelationshipEntry | null;
}

const sameEntry = (a: RelationshipEntry | null, b: RelationshipEntry | null): boolean =>
  a?.key === b?.key && a?.rowId === b?.rowId && a?.sourceId === b?.sourceId;

/**
 * The index change a previous→next write implies. Both sides derive
 * from two versions of the SAME row, so an unchanged index identity
 * yields an empty delta. The adapters share this so the previous/next
 * reconciliation cannot drift.
 */
export const relationshipIndexDelta = (
  previous: Entity | undefined,
  next: Entity | undefined,
): RelationshipIndexDelta => {
  const remove = previous === undefined ? null : relationshipEntryFor(previous);
  const add = next === undefined ? null : relationshipEntryFor(next);
  return sameEntry(remove, add) ? { remove: null, add: null } : { remove, add };
};
