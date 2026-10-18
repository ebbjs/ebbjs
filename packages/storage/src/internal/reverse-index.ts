import type { Entity } from "@ebbjs/core";
import { isFieldLeaf } from "@ebbjs/core";
import type { MembershipLink, RelationshipLink } from "../types/entity-store";

/**
 * Derivation of the adjacency indices shared by every EntityStore
 * adapter. The adapters own the storage medium; this module owns the
 * mapping from a materialized row to its index entries so the two
 * implementations cannot drift.
 *
 * Each row contributes to two directions:
 *
 * - the **reverse** index answers "which sources point at this target
 *   through this accessor?", the read behind a relationship-aware
 *   `.where` predicate AND the read behind built-in group membership;
 * - the **forward** index answers "what does this source point at?",
 *   the read behind `forwardOne` / `forwardMany` and the entity-keyed
 *   membership read.
 *
 * Two row kinds contribute: a `relationship` row keys on its
 * `(field, type, target_id)` / `(field, type, source_id)` pair, and an
 * `entityGroup` row keys on its `group_id` (group side) or `entity_id`
 * (member side) under a synthetic membership accessor.
 *
 * It keys on the row, not the source: two rows may share a natural key
 * (same source, field, type, target), and dropping one must not erase a
 * source the other still supplies. The distinct ids are derived from
 * the live rows at read time.
 */

export interface IndexEntry {
  readonly key: string;
  readonly rowId: string;
  /**
   * The id the entry yields for its key: the source of a reverse entry,
   * the target of a forward one.
   */
  readonly value: string;
}

/** Live rows under one composite key: rowId → yielded id. */
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

/**
 * The forward (source-keyed) counterpart of {@link reverseIndexKey}.
 * The leading `\u0001` keeps it out of the reverse key space — the two
 * directions share one index map and one IndexedDB store, and a
 * `(field, type, id)` triple can name a source in one row and a target
 * in another. NUL and the control chars around it are outside the
 * nanoid alphabet and accessor names, so neither separator can occur in
 * a key component.
 */
export const forwardIndexKey = (field: string, type: string, sourceId: string): string =>
  `\u0001${reverseIndexKey(field, type, sourceId)}`;

/** The reverse-index key a membership row with this group id contributes. */
export const membershipIndexKey = (groupId: string): string =>
  reverseIndexKey(MEMBERSHIP_ACCESSOR, MEMBERSHIP_ENTITY_TYPE, groupId);

/** The forward-index key a membership row with this member entity id contributes. */
export const forwardMembershipIndexKey = (entityId: string): string =>
  forwardIndexKey(MEMBERSHIP_ACCESSOR, MEMBERSHIP_ENTITY_TYPE, entityId);

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

  return { key: reverseIndexKey(field, type, targetId), rowId: entity.id, value: sourceId };
};

/**
 * The forward (source-keyed) index entry a materialized Relationship row
 * contributes, or `null` when it contributes none. Yields the target id
 * so `forwardOne` / `forwardMany` resolve without scanning the type.
 */
export const forwardRelationshipEntryFor = (entity: Entity): IndexEntry | null => {
  if (entity.type !== RELATIONSHIP_ENTITY_TYPE) return null;
  if (entity.deleted_hlc !== null) return null;

  const field = readStringField(entity, "field");
  const type = readStringField(entity, "type");
  const sourceId = readStringField(entity, "source_id");
  const targetId = readStringField(entity, "target_id");
  if (field === null || type === null || sourceId === null || targetId === null) return null;

  return { key: forwardIndexKey(field, type, sourceId), rowId: entity.id, value: targetId };
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

  return { key: membershipIndexKey(groupId), rowId: entity.id, value: entityId };
};

/**
 * The forward (member-keyed) index entry a materialized `entityGroup`
 * row contributes, or `null` when it contributes none. Yields the group
 * id so the entity-keyed membership read resolves without scanning the
 * type.
 */
export const forwardMembershipEntryFor = (entity: Entity): IndexEntry | null => {
  if (entity.type !== MEMBERSHIP_ENTITY_TYPE) return null;
  if (entity.deleted_hlc !== null) return null;

  const groupId = readStringField(entity, "group_id");
  const entityId = readStringField(entity, "entity_id");
  if (groupId === null || entityId === null) return null;

  return { key: forwardMembershipIndexKey(entityId), rowId: entity.id, value: groupId };
};

/** The entity field each accessor-affecting row type names its subject with. */
const ACCESSOR_SUBJECT_FIELD: Readonly<Record<string, string>> = {
  [RELATIONSHIP_ENTITY_TYPE]: "source_id",
  [MEMBERSHIP_ENTITY_TYPE]: "entity_id",
};

/**
 * The entity whose accessors a materialized `relationship` /
 * `entityGroup` row affects, or `null` for any other row. Unlike
 * {@link relationshipEntryFor} this does NOT skip tombstones: an unlink /
 * removal must still notify the entity whose accessors it changes, and the
 * tombstone retains the fields.
 */
export const accessorAffectedEntityId = (entity: Entity): string | null => {
  const field = ACCESSOR_SUBJECT_FIELD[entity.type];
  return field === undefined ? null : readStringField(entity, field);
};

/**
 * Every index entry a materialized row contributes. Both entry kinds
 * derive from distinct entity types, so at most one applies.
 */
export const indexEntryFor = (entity: Entity): IndexEntry | null =>
  relationshipEntryFor(entity) ?? membershipEntryFor(entity);

/**
 * Every forward index entry a materialized row contributes. Both entry
 * kinds derive from distinct entity types, so at most one applies.
 */
export const forwardIndexEntryFor = (entity: Entity): IndexEntry | null =>
  forwardRelationshipEntryFor(entity) ?? forwardMembershipEntryFor(entity);

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

/**
 * Live rows under one key as `{ rowId, value }`, ascending by value then
 * row id. Deterministic regardless of insertion order, so both adapters
 * return the same sequence for the same rows and a source's duplicate
 * edges keep a stable first row.
 */
export const liveIndexRows = (
  rows: IndexRows | undefined,
): readonly { readonly rowId: string; readonly value: string }[] =>
  Object.entries(rows ?? {})
    .map(([rowId, value]) => ({ rowId, value }))
    .sort((a, b) =>
      a.value === b.value ? a.rowId.localeCompare(b.rowId) : a.value.localeCompare(b.value),
    );

/** Live forward relationship edges under one key. */
export const liveRelationshipLinks = (rows: IndexRows | undefined): readonly RelationshipLink[] =>
  liveIndexRows(rows).map(({ rowId, value }) => ({ relationshipId: rowId, targetId: value }));

/** Live entity-keyed membership rows under one key. */
export const liveMembershipLinks = (rows: IndexRows | undefined): readonly MembershipLink[] =>
  liveIndexRows(rows).map(({ rowId, value }) => ({ membershipId: rowId, groupId: value }));

const applyRow = (
  rows: IndexRows | undefined,
  entry: IndexEntry,
  present: boolean,
): Record<string, string> => {
  const next: Record<string, string> = { ...rows };
  if (present) next[entry.rowId] = entry.value;
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
  a?.key === b?.key && a?.rowId === b?.rowId && a?.value === b?.value;

/**
 * Build the delta function for one index direction. Both sides derive
 * from two versions of the SAME row, so an unchanged index identity
 * yields an empty delta. The adapters share these so the previous/next
 * reconciliation cannot drift.
 */
const indexDeltaFor =
  (
    entryFor: (entity: Entity) => IndexEntry | null,
  ): ((previous: Entity | undefined, next: Entity | undefined) => IndexDelta) =>
  (previous, next) => {
    const remove = previous === undefined ? null : entryFor(previous);
    const add = next === undefined ? null : entryFor(next);
    return sameEntry(remove, add) ? { remove: null, add: null } : { remove, add };
  };

/**
 * The reverse index change a previous→next write implies. A single
 * delta path maintains both relationship edges and membership rows
 * because it routes through {@link indexEntryFor}.
 */
export const reverseIndexDelta = indexDeltaFor(indexEntryFor);

/**
 * The forward index change a previous→next write implies, derived from
 * the same two row versions as {@link reverseIndexDelta}. A row that is
 * not a relationship / membership row yields an empty delta on both
 * sides.
 */
export const forwardIndexDelta = indexDeltaFor(forwardIndexEntryFor);

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
