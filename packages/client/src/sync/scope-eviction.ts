/**
 * Group-scope eviction for the materialized replica (#499).
 *
 * Residency follows the subscription: rows of a group no longer
 * subscribed stop being materialized, so their metadata and indices are
 * released. An entity held by several groups
 * stays while any one of them is subscribed. A row with no membership at
 * all is not attributable to a group, so it is never evicted here.
 *
 * Membership and the platform rows it names are read from the row index
 * (#978), never from a component value, so removing a value cannot change
 * which groups a row is in.
 *
 * The functions are pure over the replica's current index. The caller applies
 * the result with {@link Replica.evict} and owns the durable base.
 */

import { systemValueString } from "@ebbjs/core";
import type { Replica } from "@ebbjs/storage/replica";
import type { ReplicaRecord } from "@ebbjs/storage/types";

interface GrantRow {
  readonly grantId: string;
  readonly groupId: string;
}

/**
 * The replica's grant rows with their group. The grant's `ebb/grant` value is
 * an index field, so the answer cannot change while the row is resident.
 */
const grantRows = (replica: Replica): readonly GrantRow[] =>
  replica.components("ebb/grant").flatMap((grantId) => {
    const groupId = systemValueString(replica.get(grantId), "grant", "group_id");
    return groupId === null ? [] : [{ grantId, groupId }];
  });

/**
 * The ids to evict so only `groupIds` remain resident. Group, grant, and
 * membership rows follow their own `group_id`; every other row follows the
 * live membership rows the index files under it. An edge needs no rule of its
 * own: it is a keyed component of its source, so evicting the source takes it
 * along (#820).
 */
export const evictableRowIds = (
  replica: Replica,
  groupIds: readonly string[],
): readonly string[] => {
  const subscribed = new Set(groupIds);
  const evicted = new Set<string>();
  const members = new Set<string>();
  const subscribedMembers = new Set<string>();

  for (const membership of replica.membershipRows()) {
    members.add(membership.entityId);
    if (subscribed.has(membership.groupId)) subscribedMembers.add(membership.entityId);
    else evicted.add(membership.membershipId);
  }
  for (const entityId of members) {
    if (!subscribedMembers.has(entityId)) evicted.add(entityId);
  }

  // A group's scope is itself, so a group row's id is the group id.
  for (const groupId of replica.components("ebb/group")) {
    if (!subscribed.has(groupId)) evicted.add(groupId);
  }

  for (const { grantId, groupId } of grantRows(replica)) {
    if (!subscribed.has(groupId)) evicted.add(grantId);
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
  const present = new Set<string>([
    ...replica.components("ebb/group"),
    ...replica.membershipRows().map((membership) => membership.groupId),
    ...grantRows(replica).map((grant) => grant.groupId),
  ]);
  return [...present].filter((groupId) => !subscribed.has(groupId)).sort();
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
