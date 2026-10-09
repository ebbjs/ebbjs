import type { Entity } from "@ebbjs/core";
import { isFieldLeaf } from "@ebbjs/core";

/**
 * Derivation of the `(field, type, target_id) → source row`
 * reverse index shared by every EntityStore adapter. The adapters own
 * the storage medium; this module owns the mapping from a materialized
 * row to its index entry so the two implementations cannot drift.
 *
 * The index answers "which sources point at this target through this
 * accessor?", the read behind a relationship-aware `.where` predicate
 * AND the read behind built-in group membership. Two row kinds
 * contribute: a `relationship` row keys on `(field, type, target_id)`,
 * and an `entityGroup` row keys on its `group_id` under a synthetic
 * membership accessor.
 *
 * It keys on the row, not the source: two rows may share a natural key
 * (same source, field, type, target), and dropping one must not erase a
 * source the other still supplies. The distinct source ids are derived
 * from the live rows at read time.
 */

export interface IndexEntry {
  readonly key: string;
  readonly rowId: string;
  readonly sourceId: string;
}

/** Live rows under one composite key: rowId → sourceId. */
export type IndexRows = Readonly<Record<string, string>>;

/** Live rows per composite key — the shape both adapters persist. */
export type ReverseIndex = Readonly<Record<string, IndexRows>>;

/** The entity type carried by a materialized Relationship row. */
export const RELATIONSHIP_ENTITY_TYPE = "relationship";

/** The entity type carried by a materialized `entityGroup` row. */
export const MEMBERSHIP_ENTITY_TYPE = "entityGroup";

/**
 * Synthetic accessor name under which membership rows are indexed.
 * `queryByMembership` owns this key, so it must stay in step with the
 * client's reserved `GROUPS_ACCESSOR`; a real relationship accessor can
 * never collide with it because `groups` is reserved there.
 */
const MEMBERSHIP_ACCESSOR = "groups";

/**
 * Composite index key. NUL is outside the nanoid alphabet, so it is
 * safe as a separator for the ids and accessor names that make up a
 * key.
 */
export const reverseIndexKey = (field: string, type: string, targetId: string): string =>
  `${field}\u0000${type}\u0000${targetId}`;

/** The reverse-index key a membership row with this group id contributes. */
export const membershipIndexKey = (groupId: string): string =>
  reverseIndexKey(MEMBERSHIP_ACCESSOR, MEMBERSHIP_ENTITY_TYPE, groupId);

const readStringField = (entity: Entity, name: string): string | null => {
  const field = entity.data?.fields?.[name];
  if (field === undefined || !isFieldLeaf(field)) return null;
  const value = field.value;
  return typeof value === "string" ? value : null;
};

/**
 * The index entry a materialized Relationship row contributes, or
 * `null` when it contributes none. Non-relationship rows, tombstoned
 * rows, and rows missing part of the Relationship field envelope all
 * index nothing — the last case keeps a malformed row from poisoning
 * the index with a partial key.
 */
export const relationshipEntryFor = (entity: Entity): IndexEntry | null => {
  if (entity.type !== RELATIONSHIP_ENTITY_TYPE) return null;
  if (entity.deleted_hlc !== null) return null;

  const field = readStringField(entity, "field");
  const type = readStringField(entity, "type");
  const targetId = readStringField(entity, "target_id");
  const sourceId = readStringField(entity, "source_id");
  if (field === null || type === null || targetId === null || sourceId === null) return null;

  return { key: reverseIndexKey(field, type, targetId), rowId: entity.id, sourceId };
};

/**
 * The index entry a materialized `entityGroup` row contributes, or
 * `null` when it contributes none. Its source is the member entity
 * (`entity_id`) and its target the group (`group_id`), so a group-keyed
 * lookup returns members.
 */
export const membershipEntryFor = (entity: Entity): IndexEntry | null => {
  if (entity.type !== MEMBERSHIP_ENTITY_TYPE) return null;
  if (entity.deleted_hlc !== null) return null;

  const groupId = readStringField(entity, "group_id");
  const entityId = readStringField(entity, "entity_id");
  if (groupId === null || entityId === null) return null;

  return { key: membershipIndexKey(groupId), rowId: entity.id, sourceId: entityId };
};

/**
 * Every index entry a materialized row contributes. Both entry kinds
 * derive from distinct entity types, so at most one applies.
 */
export const indexEntryFor = (entity: Entity): IndexEntry | null =>
  relationshipEntryFor(entity) ?? membershipEntryFor(entity);

/**
 * Ascending id order, so both adapters return the same sequence for
 * the same rows regardless of insertion order.
 */
export const sortSourceIds = (ids: Iterable<string>): string[] => [...ids].sort();

/**
 * Distinct source ids of the live rows under one key, ascending.
 * Deduplicated because several rows may carry the same source.
 */
export const liveSourceIds = (rows: IndexRows | undefined): string[] =>
  sortSourceIds(new Set(Object.values(rows ?? {})));

const applyRow = (
  rows: IndexRows | undefined,
  entry: IndexEntry,
  present: boolean,
): Record<string, string> => {
  const next: Record<string, string> = { ...rows };
  if (present) next[entry.rowId] = entry.sourceId;
  else delete next[entry.rowId];
  return next;
};

/**
 * Record one live row under its key. Never empty: the added row is
 * always present.
 */
export const addIndexRow = (rows: IndexRows | undefined, entry: IndexEntry): IndexRows =>
  applyRow(rows, entry, true);

/**
 * Drop one row from its key, returning the next map. A `null` return
 * means no live rows remain, so the caller drops the key.
 */
export const removeIndexRow = (
  rows: IndexRows | undefined,
  entry: IndexEntry,
): IndexRows | null => {
  const next = applyRow(rows, entry, false);
  return Object.keys(next).length === 0 ? null : next;
};

export interface IndexDelta {
  readonly remove: IndexEntry | null;
  readonly add: IndexEntry | null;
}

const sameEntry = (a: IndexEntry | null, b: IndexEntry | null): boolean =>
  a?.key === b?.key && a?.rowId === b?.rowId && a?.sourceId === b?.sourceId;

/**
 * The index change a previous→next write implies. Both sides derive
 * from two versions of the SAME row, so an unchanged index identity
 * yields an empty delta. The adapters share this so the previous/next
 * reconciliation cannot drift. A single delta path maintains both
 * relationship edges and membership rows because it routes through
 * {@link indexEntryFor}.
 */
export const reverseIndexDelta = (
  previous: Entity | undefined,
  next: Entity | undefined,
): IndexDelta => {
  const remove = previous === undefined ? null : indexEntryFor(previous);
  const add = next === undefined ? null : indexEntryFor(next);
  return sameEntry(remove, add) ? { remove: null, add: null } : { remove, add };
};

const withEntry = (
  index: ReverseIndex,
  entry: IndexEntry,
  rows: IndexRows | null,
): ReverseIndex => {
  if (rows === null) {
    const rest = { ...index };
    delete rest[entry.key];
    return rest;
  }
  return { ...index, [entry.key]: rows };
};

/**
 * Apply a row delta to a whole index, returning the next index. An
 * empty delta returns the input unchanged; a key the delta emptied is
 * dropped.
 */
export const applyIndexDelta = (index: ReverseIndex, delta: IndexDelta): ReverseIndex => {
  if (delta.remove === null && delta.add === null) return index;

  let next = index;
  if (delta.remove !== null) {
    next = withEntry(next, delta.remove, removeIndexRow(next[delta.remove.key], delta.remove));
  }
  if (delta.add !== null) {
    next = withEntry(next, delta.add, addIndexRow(next[delta.add.key], delta.add));
  }
  return next;
};
