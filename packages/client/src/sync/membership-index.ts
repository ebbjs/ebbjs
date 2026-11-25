/**
 * The `membership` index (#961, #1003).
 *
 * Row subscriptions watch the membership row that files the entity they read,
 * so this index is keyed by the member entity id and resolves a membership row
 * change to it. It has no query-side declaration: `structuralReads` describes
 * query reads, and a row subscription declares this dependency itself.
 */

import { EBB_COMPONENTS, systemValueString } from "@ebbjs/core";
import type { Replica, ReplicaChange } from "@ebbjs/storage/replica";

import type { IndexResolver } from "./dependency-index";

/** Row subscriptions: the member entity id a membership row files. */
export const MEMBERSHIP_INDEX = "membership";

/**
 * The member entity a membership row files, or `null` when the changed row is
 * not a membership row this index answers for.
 */
const membershipSubject = (replica: Replica, change: ReplicaChange): string | null => {
  // A membership row files a different row than the one it is, so the member
  // is only reachable by reading the changed row — once per change, not once
  // per subscription. A membership row arriving or leaving is a membership
  // change that names no component, so the row itself says what it files.
  if (change.kind === "content" && !change.components.includes(EBB_COMPONENTS.membership)) {
    return null;
  }
  const changed = replica.get(change.id);
  if (changed === undefined) return null;
  const id = systemValueString(changed, "membership", "entity_id");
  return id !== null && id.length > 0 ? id : null;
};

/** The resolver serving row subscriptions against a replica's membership rows. */
export const membershipResolver =
  (replica: Replica): IndexResolver =>
  (change) => {
    const subject = membershipSubject(replica, change);
    return subject === null ? [] : [subject];
  };
