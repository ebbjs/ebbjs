/**
 * Group-scope eviction for the materialized replica (#499).
 *
 * Residency follows the subscription: rows of a group no longer
 * subscribed stop being materialized, so their metadata and indices are
 * released. An entity held by several groups
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
 * The replica's rows of one platform kind. A row's kind is the `ebb/*` component
 * it carries, not its model; a row carrying two lands in both buckets, which is
 * what an overlay row (#820) needs.
 */
const platformRows = (replica: Replica, kind: EbbComponentKind): readonly Entity[] =>
  replica.iterate(EBB_MODEL_NAME).filter((row) => carriesComponent(row, kind));

/**
 * The ids to evict so only `groupIds` remain resident. Group, grant, and
 * membership rows follow their own `group_id`; every other row follows its
 * live `ebb/membership` rows. An edge needs no rule of its own: it is a keyed
 * component of its source, so evicting the source takes it along (#820).
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

  // Every other model's rows follow their memberships. `ebb` was bucketed by
  // component above; an overlay row is committed under its host model.
  for (const type of Object.keys(replica.stats().byModel)) {
    if (type === EBB_MODEL_NAME) continue;
    for (const row of replica.iterate(type)) {
      const groups = memberGroups.get(row.id);
      if (groups === undefined) continue;
      if (![...groups].some((groupId) => subscribed.has(groupId))) evicted.add(row.id);
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

/** Fold `extra`'s rows into `base` by id, `base` winning an overlap. */
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
  const componentVersions = { ...extra.componentVersions, ...base.componentVersions };
  if (Object.keys(componentVersions).length > 0) merged.componentVersions = componentVersions;
  return merged;
};

/** Keep the rows the resident record no longer carries, preferring its current row. */
export const withRetainedRows = (record: ReplicaRecord, durable: ReplicaRecord): ReplicaRecord => {
  const current = new Set(record.entities.map((entity) => entity.id));
  const retained = durable.entities.filter((entity) => !current.has(entity.id));
  const componentVersions: Record<string, Readonly<Record<string, number>>> = {};
  for (const [id, stamps] of Object.entries(durable.componentVersions)) {
    if (!current.has(id)) componentVersions[id] = stamps;
  }
  Object.assign(componentVersions, record.componentVersions);
  const merged = { ...record, entities: [...record.entities, ...retained] } as {
    -readonly [K in keyof ReplicaRecord]: ReplicaRecord[K];
  };
  if (Object.keys(componentVersions).length > 0) merged.componentVersions = componentVersions;
  return merged;
};
