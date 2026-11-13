/**
 * The built-in membership row shape. One `ebb/membership` row per
 * (entity, group) pair; both the `groups` query predicate and the
 * `doc.groups` accessor need the live row's two ids, so the read
 * lives here rather than being hand-rolled at each call site.
 */

import { carriesComponent, systemValueString, type Entity } from "@ebbjs/core";
import type { StorageAdapter } from "@ebbjs/storage/types";

/** A live `ebb/membership` row, reduced to the ids it carries. */
export interface LiveMembership {
  /** The membership row's own id — the `subject_id` a delete names. */
  readonly membershipId: string;
  readonly entityId: string;
  readonly groupId: string;
}

/**
 * Read a membership row. Returns `null` for a tombstoned row or a row
 * whose `entity_id` / `group_id` is missing or not a string.
 */
export function liveMembership(row: Entity): LiveMembership | null {
  if (row.deleted_hlc !== null) return null;
  if (!carriesComponent(row, "membership")) return null;
  const groupId = systemValueString(row, "membership", "group_id");
  const entityId = systemValueString(row, "membership", "entity_id");
  if (groupId === null || entityId === null) return null;
  return { membershipId: row.id, entityId, groupId };
}

/**
 * Read the live membership rows out of a batch of rows, dropping rows of
 * another kind, tombstoned rows, and malformed ones.
 */
export function liveMemberships(rows: readonly Entity[]): readonly LiveMembership[] {
  return rows.flatMap((row) => {
    const membership = liveMembership(row);

    return membership === null ? [] : [membership];
  });
}

/**
 * The live membership rows owned by `entityId`. A membership mutation
 * needs the row id a delete addresses, which the `groups` accessor's
 * projected group entities do not carry.
 *
 * Reads the member-keyed membership index, so the cost is the row's
 * membership count rather than the size of the `ebb` model.
 */
export async function readEntityMemberships(
  storage: StorageAdapter,
  entityId: string,
): Promise<readonly LiveMembership[]> {
  const links = await storage.entities.queryByMembershipEntity(entityId);
  return links.map((link) => ({
    membershipId: link.membershipId,
    entityId,
    groupId: link.groupId,
  }));
}

/**
 * Read a single membership row by the `subject_id` a membership delete names.
 * Returns `null` when the id is missing, carries no `ebb/membership`, or the row
 * is tombstoned / malformed.
 */
export async function readMembership(
  storage: StorageAdapter,
  membershipId: string,
): Promise<LiveMembership | null> {
  const row = await storage.entities.get(membershipId);
  if (row === null) return null;
  return liveMembership(row);
}
