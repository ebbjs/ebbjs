/**
 * The built-in membership row shape. One `entityGroup` row per
 * (entity, group) pair; both the `groups` query predicate and the
 * `doc.groups` accessor need the live row's two ids, so the read
 * lives here rather than being hand-rolled at each call site.
 */

import type { Entity } from "@ebbjs/core";

/** A live `entityGroup` row, reduced to the two ids it carries. */
export interface LiveMembership {
  readonly entityId: string;
  readonly groupId: string;
}

/**
 * Read a membership row. Returns `null` for a tombstoned row or a row
 * whose `entity_id` / `group_id` is missing or not a string.
 */
export function liveMembership(row: Entity): LiveMembership | null {
  if (row.deleted_hlc !== null) return null;
  const groupId = row.data?.fields?.["group_id"]?.value;
  const entityId = row.data?.fields?.["entity_id"]?.value;
  if (typeof groupId !== "string" || typeof entityId !== "string") return null;
  return { entityId, groupId };
}
