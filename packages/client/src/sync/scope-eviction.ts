/**
 * Group-scope eviction for the materialized replica (#499).
 *
 * Residency follows the subscription: rows of a group no longer
 * subscribed stop being materialized, so its page/relationship/membership
 * metadata and indices are released. An entity held by several groups
 * stays while any one of them is subscribed. A row with no membership at
 * all is not attributable to a group, so it is never evicted here.
 *
 * The functions are pure over the replica's current rows. The caller applies
 * the result with {@link Replica.evict} and owns the durable base.
 */

import type { Entity } from "@ebbjs/core";
import type { Replica } from "@ebbjs/storage/replica";
import type { ReplicaRecord } from "@ebbjs/storage/types";

import {
  entityGroupSystemEntity,
  groupMemberSystemEntity,
  groupSystemEntity,
  relationshipSystemEntity,
} from "@ebbjs/schema";

const systemTypes = new Set<string>([
  entityGroupSystemEntity.name,
  groupMemberSystemEntity.name,
  groupSystemEntity.name,
  relationshipSystemEntity.name,
]);

/** A leaf string field; envelopes are not part of this read. */
const stringField = (row: Entity, field: string): string | null => {
  const entry = row.data?.fields?.[field];
  if (entry === undefined || !("value" in entry)) return null;
  return typeof entry.value === "string" ? entry.value : null;
};

const addGroup = (map: Map<string, Set<string>>, entityId: string, groupId: string): void => {
  const groups = map.get(entityId);
  if (groups === undefined) map.set(entityId, new Set([groupId]));
  else groups.add(groupId);
};

/**
 * The ids to evict so only `groupIds` remain resident. Group rows,
 * group-member rows, and membership rows follow their own `group_id`;
 * content rows follow their live `entityGroup` memberships; a
 * relationship row follows an evicted endpoint.
 */
export const evictableRowIds = (
  replica: Replica,
  groupIds: readonly string[],
): readonly string[] => {
  const subscribed = new Set(groupIds);
  const evicted = new Set<string>();
  const memberGroups = new Map<string, Set<string>>();

  for (const row of replica.iterate(entityGroupSystemEntity.name)) {
    const entityId = stringField(row, "entity_id");
    const groupId = stringField(row, "group_id");
    if (entityId !== null && groupId !== null) addGroup(memberGroups, entityId, groupId);
    if (groupId !== null && !subscribed.has(groupId)) evicted.add(row.id);
  }

  for (const row of replica.iterate(groupSystemEntity.name)) {
    if (!subscribed.has(row.id)) evicted.add(row.id);
  }

  for (const row of replica.iterate(groupMemberSystemEntity.name)) {
    const groupId = stringField(row, "group_id");
    if (groupId !== null && !subscribed.has(groupId)) evicted.add(row.id);
  }

  for (const type of Object.keys(replica.stats().byType)) {
    if (systemTypes.has(type)) continue;
    for (const row of replica.iterate(type)) {
      const groups = memberGroups.get(row.id);
      if (groups === undefined) continue;
      if (![...groups].some((groupId) => subscribed.has(groupId))) evicted.add(row.id);
    }
  }

  for (const row of replica.iterate(relationshipSystemEntity.name)) {
    const source = stringField(row, "source_id");
    const target = stringField(row, "target_id");
    if ((source !== null && evicted.has(source)) || (target !== null && evicted.has(target))) {
      evicted.add(row.id);
    }
  }

  return [...evicted];
};

/**
 * Group ids present in the replica but not in `groupIds`. Marking these
 * before eviction lets a later subscribe restore their rows from the
 * durable base instead of treating them as first-time groups.
 */
export const scopeEvictedGroupIds = (
  replica: Replica,
  groupIds: readonly string[],
): readonly string[] => {
  const subscribed = new Set(groupIds);
  const evicted = new Set<string>();
  const collect = (row: Entity, field: string | null): void => {
    const groupId = field === null ? row.id : stringField(row, field);
    if (groupId !== null && !subscribed.has(groupId)) evicted.add(groupId);
  };
  for (const row of replica.iterate(groupSystemEntity.name)) collect(row, null);
  for (const row of replica.iterate(entityGroupSystemEntity.name)) collect(row, "group_id");
  for (const row of replica.iterate(groupMemberSystemEntity.name)) collect(row, "group_id");
  return [...evicted];
};

/**
 * Fold `extra`'s rows into `base` by id, `base` winning an overlap. Residency
 * and version metadata merge by id too; an all-on-demand row exists only there.
 */
export const mergeReplicaRecords = (
  extra: ReplicaRecord | null,
  base: ReplicaRecord,
): ReplicaRecord => {
  if (extra === null) return base;
  const rows = new Map(base.entities.map((entity) => [entity.id, entity]));
  for (const entity of extra.entities) {
    if (!rows.has(entity.id)) rows.set(entity.id, entity);
  }
  const merged = { ...base, entities: [...rows.values()] } as {
    -readonly [K in keyof ReplicaRecord]: ReplicaRecord[K];
  };
  const notResident = { ...extra.notResident, ...base.notResident };
  const componentVersions = { ...extra.componentVersions, ...base.componentVersions };
  if (Object.keys(notResident).length > 0) merged.notResident = notResident;
  if (Object.keys(componentVersions).length > 0) merged.componentVersions = componentVersions;
  return merged;
};

/** Keep the rows the resident record no longer carries, preferring its current row. */
export const withRetainedRows = (record: ReplicaRecord, durable: ReplicaRecord): ReplicaRecord => {
  const current = new Set(record.entities.map((entity) => entity.id));
  const retained = durable.entities.filter((entity) => !current.has(entity.id));
  const notResident: Record<string, readonly string[]> = {};
  if (durable.notResident !== undefined) {
    for (const [id, components] of Object.entries(durable.notResident)) {
      if (!current.has(id)) notResident[id] = components;
    }
  }
  const componentVersions: Record<string, Readonly<Record<string, number>>> = {};
  for (const [id, stamps] of Object.entries(durable.componentVersions)) {
    if (!current.has(id)) componentVersions[id] = stamps;
  }
  if (record.notResident !== undefined) Object.assign(notResident, record.notResident);
  Object.assign(componentVersions, record.componentVersions);
  const merged = { ...record, entities: [...record.entities, ...retained] } as {
    -readonly [K in keyof ReplicaRecord]: ReplicaRecord[K];
  };
  if (Object.keys(notResident).length > 0) merged.notResident = notResident;
  if (Object.keys(componentVersions).length > 0) merged.componentVersions = componentVersions;
  return merged;
};
