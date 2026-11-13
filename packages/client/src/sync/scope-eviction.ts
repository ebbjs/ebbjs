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

import {
  carriesComponent,
  EBB_MODEL_NAME,
  systemValueString,
  type EbbComponentKind,
  type Entity,
} from "@ebbjs/core";
import type { Replica } from "@ebbjs/storage/replica";
import type { ReplicaRecord } from "@ebbjs/storage/types";

const addGroup = (map: Map<string, Set<string>>, entityId: string, groupId: string): void => {
  const groups = map.get(entityId);
  if (groups === undefined) map.set(entityId, new Set([groupId]));
  else groups.add(groupId);
};

/**
 * Split the platform rows out of the replica in one scan. A row's kind is the
 * `ebb/*` component it carries, not its model — every platform row is an
 * `ebb` row. A row carrying two platform components lands in both buckets,
 * which is what an overlay row (#820) needs.
 *
 * A zero-component `ebb` row (a row whose last component was dropped) belongs
 * to no group and no endpoint, so it contributes nothing here.
 */
const platformRows = (replica: Replica, kind: EbbComponentKind): readonly Entity[] =>
  replica.iterate(EBB_MODEL_NAME).filter((row) => carriesComponent(row, kind));

/**
 * The ids to evict so only `groupIds` remain resident. Group rows,
 * grant rows, and membership rows follow their own `group_id`; content
 * rows follow their live `ebb/membership` rows; a link row follows an
 * evicted endpoint.
 */
export const evictableRowIds = (
  replica: Replica,
  groupIds: readonly string[],
): readonly string[] => {
  const subscribed = new Set(groupIds);
  const evicted = new Set<string>();
  const memberGroups = new Map<string, Set<string>>();

  const memberships = platformRows(replica, "membership");
  for (const row of memberships) {
    const entityId = systemValueString(row, "membership", "entity_id");
    const groupId = systemValueString(row, "membership", "group_id");
    if (entityId !== null && groupId !== null) addGroup(memberGroups, entityId, groupId);
    if (groupId !== null && !subscribed.has(groupId)) evicted.add(row.id);
  }

  for (const row of platformRows(replica, "group")) {
    if (!subscribed.has(row.id)) evicted.add(row.id);
  }

  for (const row of platformRows(replica, "grant")) {
    const groupId = systemValueString(row, "grant", "group_id");
    if (groupId !== null && !subscribed.has(groupId)) evicted.add(row.id);
  }

  // Every other model's rows follow their memberships. `ebb` is skipped
  // because its rows were bucketed by component above; an overlay row is
  // committed under its host model, so this loop still reaches it.
  for (const type of Object.keys(replica.stats().byType)) {
    if (type === EBB_MODEL_NAME) continue;
    for (const row of replica.iterate(type)) {
      const groups = memberGroups.get(row.id);
      if (groups === undefined) continue;
      if (![...groups].some((groupId) => subscribed.has(groupId))) evicted.add(row.id);
    }
  }

  for (const row of platformRows(replica, "link")) {
    const source = systemValueString(row, "link", "source_id");
    const target = systemValueString(row, "link", "target_id");
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
  const collect = (groupId: string | null): void => {
    if (groupId !== null && !subscribed.has(groupId)) evicted.add(groupId);
  };
  for (const row of replica.iterate(EBB_MODEL_NAME)) {
    if (carriesComponent(row, "group")) {
      collect(row.id);
      continue;
    }
    for (const kind of ["membership", "grant"] as const) {
      if (carriesComponent(row, kind)) collect(systemValueString(row, kind, "group_id"));
    }
  }
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
