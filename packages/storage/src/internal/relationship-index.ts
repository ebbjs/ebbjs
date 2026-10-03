import type { Entity } from "@ebbjs/core";

/**
 * Derivation of the `(field, type, target_id) → source_id` reverse
 * index shared by every EntityStore adapter. The adapters own the
 * storage medium; this module owns the mapping from a materialized
 * Relationship row to its index entry so the two implementations
 * cannot drift.
 *
 * The index answers "which sources point at this target through this
 * accessor?", the read behind a relationship-aware `.where` predicate.
 * It is a reverse index only: a source with many targets contributes
 * one entry per target, keyed by that target.
 */

export interface RelationshipEntry {
  readonly key: string;
  readonly sourceId: string;
}

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
  if (entity.type !== "relationship") return null;
  if (entity.deleted_hlc !== null) return null;

  const field = readStringField(entity, "field");
  const type = readStringField(entity, "type");
  const targetId = readStringField(entity, "target_id");
  const sourceId = readStringField(entity, "source_id");
  if (field === null || type === null || targetId === null || sourceId === null) return null;

  return { key: relationshipIndexKey(field, type, targetId), sourceId };
};

/**
 * Ascending id order, so both adapters return the same sequence for
 * the same rows regardless of insertion order.
 */
export const sortSourceIds = (ids: Iterable<string>): string[] => [...ids].sort();
