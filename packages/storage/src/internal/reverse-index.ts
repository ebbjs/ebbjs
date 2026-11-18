import {
  EBB_COMPONENTS,
  GROUPS_ACCESSOR,
  linkEdges,
  systemValueString,
  type Entity,
} from "@ebbjs/core";
import type { MembershipLink } from "../types/entity-store";

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
 * - the **forward** index answers "which groups is this entity filed
 *   into?", the entity-keyed membership read.
 *
 * Two components contribute: a row's `ebb/link` component keys one entry per
 * live edge on `(field, type, target_id)` and yields its own id, and
 * `ebb/membership` keys on its `group_id` (group side) or `entity_id` (member
 * side) under a synthetic membership accessor.
 *
 * A link is a key of the source row's component, so one source holds at most
 * one entry per `(field, type, target)` and the entry's identity is the source
 * id. A membership is a row, and two rows may name the same `(entity, group)`
 * pair, so a membership entry keeps the row id and yields the id it is filed
 * with; the distinct ids are derived from the live rows at read time.
 */

/**
 * One live entry under one composite key.
 *
 * `id` is the entry's identity within the key: the source row id for a link,
 * the membership row id for a membership. `value` is the id the key yields: a
 * link yields its source, a membership yields the member (group side) or the
 * group (member side).
 */
export interface IndexEntry {
  readonly key: string;
  readonly id: string;
  readonly value: string;
}

/** Live entries under one composite key: entry id → yielded id. */
export type IndexRows = Readonly<Record<string, string>>;

/** Live entries per composite key — the shape both adapters persist. */
export type ReverseIndex = Readonly<Record<string, IndexRows>>;

export const MEMBERSHIP_COMPONENT = EBB_COMPONENTS.membership;

/**
 * Synthetic accessor name under which membership rows are indexed.
 * `queryByMembership` owns this key, so it is the same name
 * `@ebbjs/core` reserves; a real relationship accessor can never collide
 * with it.
 */
const MEMBERSHIP_ACCESSOR = GROUPS_ACCESSOR;

/**
 * Composite index key. NUL is outside the nanoid alphabet, so it is
 * safe as a separator for the ids and accessor names that make up a
 * key.
 */
export const reverseIndexKey = (field: string, type: string, targetId: string): string =>
  `${field}\u0000${type}\u0000${targetId}`;

/**
 * The entity-keyed counterpart of {@link reverseIndexKey}. The leading
 * `\u0001` keeps it out of the reverse key space — the two directions share one
 * index map and one IndexedDB store, and a `(field, type, id)` triple can name
 * a source in one row and a target in another. NUL and the control chars
 * around it are outside the nanoid alphabet and accessor names, so neither
 * separator can occur in a key component.
 */
const forwardIndexKey = (field: string, type: string, sourceId: string): string =>
  `\u0001${reverseIndexKey(field, type, sourceId)}`;

/** The reverse-index key a membership row with this group id contributes. */
export const membershipIndexKey = (groupId: string): string =>
  reverseIndexKey(MEMBERSHIP_ACCESSOR, MEMBERSHIP_COMPONENT, groupId);

/** The forward-index key a membership row with this member entity id contributes. */
export const forwardMembershipIndexKey = (entityId: string): string =>
  forwardIndexKey(MEMBERSHIP_ACCESSOR, MEMBERSHIP_COMPONENT, entityId);

/**
 * The reverse index entries a row's `ebb/link` component contributes: one per
 * live edge, keyed on the edge and yielding the row that carries it. A
 * tombstoned key is not an edge, so it indexes nothing.
 */
export const relationshipEntriesFor = (entity: Entity): readonly IndexEntry[] => {
  if (entity.deleted_hlc !== null) return [];
  return linkEdges(entity).map((edge) => ({
    key: reverseIndexKey(edge.as, edge.type, edge.targetId),
    id: entity.id,
    value: entity.id,
  }));
};

/**
 * The index entry a row carrying `ebb/membership` contributes, or `null`. Its
 * source is the member (`entity_id`) and its target the group (`group_id`), so a
 * group-keyed lookup returns members.
 */
export const membershipEntryFor = (entity: Entity): IndexEntry | null => {
  if (entity.deleted_hlc !== null) return null;

  const groupId = systemValueString(entity, "membership", "group_id");
  const entityId = systemValueString(entity, "membership", "entity_id");
  if (groupId === null || entityId === null) return null;

  return { key: membershipIndexKey(groupId), id: entity.id, value: entityId };
};

/** The entity-keyed entry an `ebb/membership` row contributes, or `null`. */
export const forwardMembershipEntryFor = (entity: Entity): IndexEntry | null => {
  if (entity.deleted_hlc !== null) return null;

  const groupId = systemValueString(entity, "membership", "group_id");
  const entityId = systemValueString(entity, "membership", "entity_id");
  if (groupId === null || entityId === null) return null;

  return { key: forwardMembershipIndexKey(entityId), id: entity.id, value: groupId };
};

/** Every reverse index entry a row contributes: its live edges, then membership. */
export const indexEntriesFor = (entity: Entity): readonly IndexEntry[] => {
  const membership = membershipEntryFor(entity);
  return membership === null
    ? relationshipEntriesFor(entity)
    : [...relationshipEntriesFor(entity), membership];
};

/** Every forward index entry a row contributes. Only membership has one. */
export const forwardIndexEntriesFor = (entity: Entity): readonly IndexEntry[] => {
  const entry = forwardMembershipEntryFor(entity);
  return entry === null ? [] : [entry];
};

/**
 * Ascending id order, so both adapters return the same sequence for
 * the same rows regardless of insertion order.
 */
export const sortSourceIds = (ids: Iterable<string>): string[] => [...ids].sort();

/**
 * Distinct ids one key yields, ascending. Deduplicated because several
 * membership rows may carry the same member.
 */
export const liveSourceIds = (rows: IndexRows | undefined): string[] =>
  sortSourceIds(new Set(Object.values(rows ?? {})));

/**
 * Live entries under one key as `{ id, value }`, ascending by value then id.
 * Deterministic regardless of insertion order, so both adapters return the
 * same sequence for the same rows.
 */
const liveIndexRows = (
  rows: IndexRows | undefined,
): readonly { readonly id: string; readonly value: string }[] =>
  Object.entries(rows ?? {})
    .map(([id, value]) => ({ id, value }))
    .sort((a, b) =>
      a.value === b.value ? a.id.localeCompare(b.id) : a.value.localeCompare(b.value),
    );

/** Live entity-keyed membership rows under one key. */
export const liveMembershipLinks = (rows: IndexRows | undefined): readonly MembershipLink[] =>
  liveIndexRows(rows).map(({ id, value }) => ({ membershipId: id, groupId: value }));

const applyRow = (
  rows: IndexRows | undefined,
  entry: IndexEntry,
  present: boolean,
): Record<string, string> => {
  const next: Record<string, string> = { ...rows };
  if (present) next[entry.id] = entry.value;
  else delete next[entry.id];
  return next;
};

/**
 * Record one live entry under its key. Never empty: the added entry is
 * always present.
 */
export const addIndexRow = (rows: IndexRows | undefined, entry: IndexEntry): IndexRows =>
  applyRow(rows, entry, true);

/**
 * Drop one entry from its key, returning the next map. A `null` return
 * means no live entries remain, so the caller drops the key.
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
  a.key === b.key && a.id === b.id && a.value === b.value;

/** The entries `next` adds and `previous` removes; an unchanged one yields nothing. */
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

/** The reverse index change a previous→next write implies, for both entry kinds. */
export const reverseIndexDelta = indexDeltaFor(indexEntriesFor);

/** The forward (entity-keyed membership) index change a previous→next write implies. */
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
