/**
 * The `membership` index (#961, #1003, #1010).
 *
 * Row subscriptions watch the membership row that files the entity they read,
 * so this index is keyed by the member entity id and resolves a membership row
 * change to it. It has no query-side declaration: `structuralReads` describes
 * query reads, and a row subscription declares this dependency itself.
 *
 * The resolver answers in three terms:
 *
 * - `[]` — the change names no key here: it is not a membership row this index
 *   answers for, or its delta names no member on either side. Dispatch touches
 *   nobody.
 * - the keys it names — exactly the member entities the row filed on either
 *   side of the change. A readable row states its own side (a tombstone still
 *   states the entity it filed), and the journal's `delta.membership` states
 *   the membership pair on each side, so the entity a row that is gone, or one
 *   that stopped filing, can no longer state is still named.
 * - `null` — the change carries no delta at all, so the journal cannot say
 *   whose filing moved. Dispatch then touches every entry that declared the
 *   index: the fallback breadth, never a miss.
 */

import { EBB_COMPONENTS, systemValueString, type Entity } from "@ebbjs/core";
import type { Replica, ReplicaChange } from "@ebbjs/storage/replica";

import type { IndexResolver } from "./dependency-index";

/** Row subscriptions: the member entity id a membership row files. */
export const MEMBERSHIP_INDEX = "membership";

/** The member entity a membership row files, or `null` when it files nobody. */
const filedEntity = (row: Entity): string | null => {
  const entityId = systemValueString(row, "membership", "entity_id");
  return entityId === null || entityId.length === 0 ? null : entityId;
};

/**
 * The member entities a change moved a membership row between, or `null` when
 * the change is a membership row the journal cannot name.
 */
const membershipSubjects = (replica: Replica, change: ReplicaChange): readonly string[] | null => {
  // A value write elsewhere, or a row entering or leaving a model: not a
  // membership row this index answers for.
  if (change.kind === "content" && !change.components.includes(EBB_COMPONENTS.membership)) {
    return [];
  }
  // A membership row files a different row than the one it is, so the member is
  // only reachable by reading the changed row — once per change, not once per
  // subscription.
  const changed = replica.get(change.id);
  const filed = changed === undefined ? null : filedEntity(changed);
  const { before = null, after = null } = change.delta?.membership ?? {};
  const keys = [...new Set([before?.entityId ?? null, after?.entityId ?? null, filed])].filter(
    (key): key is string => key !== null,
  );
  if (keys.length > 0) return keys;
  // A delta that names no member on either side says no filing moved, so no
  // key exists for this change. Without one, the journal cannot say whether a
  // filing did move — the row only proves the side it is on now.
  return change.delta === undefined ? null : [];
};

/** The resolver serving row subscriptions against a replica's membership rows. */
export const membershipResolver =
  (replica: Replica): IndexResolver =>
  (change) =>
    membershipSubjects(replica, change);
