import { EBB_COMPONENTS, systemValueString, type Entity } from "@ebbjs/core";
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
 * Two components contribute: a row carrying `ebb/link` keys on its
 * `(field, type, target_id)` / `(field, type, source_id)` pair, and a row
 * carrying `ebb/membership` keys on its `group_id` (group side) or
 * `entity_id` (member side) under a synthetic membership accessor. A row
 * carries at most one of them today, but a row is not assumed to: a row
 * carrying both yields both entries, which is what the overlay case (#820)
 * needs.
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

/**
 * The component a link row carries. Its value is what the adjacency keys are
 * derived from; the row's model is `ebb`.
 */
export const LINK_COMPONENT = EBB_COMPONENTS.link;

/** The component a membership row carries. */
export const MEMBERSHIP_COMPONENT = EBB_COMPONENTS.membership;

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
  reverseIndexKey(MEMBERSHIP_ACCESSOR, MEMBERSHIP_COMPONENT, groupId);

/** The forward-index key a membership row with this member entity id contributes. */
export const forwardMembershipIndexKey = (entityId: string): string =>
  forwardIndexKey(MEMBERSHIP_ACCESSOR, MEMBERSHIP_COMPONENT, entityId);

/**
 * The index entry a row carrying `ebb/link` contributes, or `null` when
 * it contributes none. Tombstoned rows, rows of another kind, and rows
 * whose component value is missing part of its key all index nothing —
 * the last case keeps a malformed row from poisoning the index with a
 * partial key.
 */
export const relationshipEntryFor = (entity: Entity): IndexEntry | null => {
  if (entity.deleted_hlc !== null) return null;

  const field = systemValueString(entity, "link", "field");
  const type = systemValueString(entity, "link", "type");
  const targetId = systemValueString(entity, "link", "target_id");
  const sourceId = systemValueString(entity, "link", "source_id");
  if (field === null || type === null || targetId === null || sourceId === null) return null;

  return { key: reverseIndexKey(field, type, targetId), rowId: entity.id, value: sourceId };
};

/**
 * The forward (source-keyed) index entry a row carrying `ebb/link`
 * contributes, or `null` when it contributes none. Yields the target id
 * so `forwardOne` / `forwardMany` resolve without scanning the model.
 */
export const forwardRelationshipEntryFor = (entity: Entity): IndexEntry | null => {
  if (entity.deleted_hlc !== null) return null;

  const field = systemValueString(entity, "link", "field");
  const type = systemValueString(entity, "link", "type");
  const sourceId = systemValueString(entity, "link", "source_id");
  const targetId = systemValueString(entity, "link", "target_id");
  if (field === null || type === null || sourceId === null || targetId === null) return null;

  return { key: forwardIndexKey(field, type, sourceId), rowId: entity.id, value: targetId };
};

/**
 * The index entry a row carrying `ebb/membership` contributes, or `null`
 * when it contributes none. Its source is the member entity (`entity_id`)
 * and its target the group (`group_id`), so a group-keyed lookup returns
 * members.
 */
export const membershipEntryFor = (entity: Entity): IndexEntry | null => {
  if (entity.deleted_hlc !== null) return null;

  const groupId = systemValueString(entity, "membership", "group_id");
  const entityId = systemValueString(entity, "membership", "entity_id");
  if (groupId === null || entityId === null) return null;

  return { key: membershipIndexKey(groupId), rowId: entity.id, value: entityId };
};

/**
 * The forward (member-keyed) index entry a row carrying `ebb/membership`
 * contributes, or `null` when it contributes none. Yields the group id so
 * the entity-keyed membership read resolves without scanning the model.
 */
export const forwardMembershipEntryFor = (entity: Entity): IndexEntry | null => {
  if (entity.deleted_hlc !== null) return null;

  const groupId = systemValueString(entity, "membership", "group_id");
  const entityId = systemValueString(entity, "membership", "entity_id");
  if (groupId === null || entityId === null) return null;

  return { key: forwardMembershipIndexKey(entityId), rowId: entity.id, value: groupId };
};

const isEntry = (entry: IndexEntry | null): entry is IndexEntry => entry !== null;

/**
 * Every reverse index entry a materialized row contributes. One entry per
 * component kind the row carries, so a row carrying both derives both —
 * the two kinds are no longer mutually exclusive.
 */
export const indexEntriesFor = (entity: Entity): readonly IndexEntry[] =>
  [relationshipEntryFor(entity), membershipEntryFor(entity)].filter(isEntry);

/** Every forward index entry a materialized row contributes. */
export const forwardIndexEntriesFor = (entity: Entity): readonly IndexEntry[] =>
  [forwardRelationshipEntryFor(entity), forwardMembershipEntryFor(entity)].filter(isEntry);

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
  readonly remove: readonly IndexEntry[];
  readonly add: readonly IndexEntry[];
}

const sameEntry = (a: IndexEntry, b: IndexEntry): boolean =>
  a.key === b.key && a.rowId === b.rowId && a.value === b.value;

/**
 * The entries `next` adds and `previous` removes. Both sides derive from two
 * versions of the SAME row, so an unchanged index identity yields an empty
 * delta.
 */
const entryDelta = (previous: readonly IndexEntry[], next: readonly IndexEntry[]): IndexDelta => ({
  remove: previous.filter((before) => !next.some((after) => sameEntry(before, after))),
  add: next.filter((after) => !previous.some((before) => sameEntry(before, after))),
});

/**
 * Build the delta function for one index direction. Both sides derive
 * from two versions of the SAME row, so an unchanged index identity
 * yields an empty delta. The adapters share these so the previous/next
 * reconciliation cannot drift.
 */
const indexDeltaFor =
  (
    entriesFor: (entity: Entity) => readonly IndexEntry[],
  ): ((previous: Entity | undefined, next: Entity | undefined) => IndexDelta) =>
  (previous, next) =>
    entryDelta(
      previous === undefined ? [] : entriesFor(previous),
      next === undefined ? [] : entriesFor(next),
    );

/**
 * The reverse index change a previous→next write implies. A single
 * delta path maintains both relationship edges and membership rows
 * because it routes through {@link indexEntriesFor}.
 */
export const reverseIndexDelta = indexDeltaFor(indexEntriesFor);

/**
 * The forward index change a previous→next write implies, derived from
 * the same two row versions as {@link reverseIndexDelta}. A row carrying
 * neither platform component yields an empty delta on both sides.
 */
export const forwardIndexDelta = indexDeltaFor(forwardIndexEntriesFor);

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
  if (delta.remove.length === 0 && delta.add.length === 0) return index;

  let next = index;
  for (const entry of delta.remove) {
    next = withEntry(next, entry, removeIndexRow(next[entry.key], entry));
  }
  for (const entry of delta.add) {
    next = withEntry(next, entry, addIndexRow(next[entry.key], entry));
  }
  return next;
};
