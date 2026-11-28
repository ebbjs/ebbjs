/**
 * The `membership` index (#961, #1003, #1010).
 *
 * Row subscriptions watch the membership row that files the entity they read,
 * so this index is keyed by the member entity id and resolves a membership row
 * change to it. It has no query-side declaration: `structuralReads` describes
 * query reads, and a row subscription declares this dependency itself.
 *
 * The resolver answers in two terms:
 *
 * - `[]` — the change names no key here: it is not a membership row this index
 *   answers for, or its delta names no member on either side. Dispatch touches
 *   nobody.
 * - the keys it names — exactly the member entities the row filed on either
 *   side of the change. The journal's `delta.membership` states the pair on each
 *   side, so the entity a row that is gone, or one that stopped filing, can no
 *   longer state is still named. That is why the resolver never reads the
 *   changed row back.
 */

import { EBB_COMPONENTS } from "@ebbjs/core";
import type { ReplicaChange } from "@ebbjs/storage/replica";

import type { IndexResolver } from "./dependency-index";

/** Row subscriptions: the member entity id a membership row files. */
export const MEMBERSHIP_INDEX = "membership";

/**
 * The member entities a change moved a membership row between. The delta is
 * complete (ADR 0006), so the pair it names is the whole movement and nothing
 * here has to fall back to a broader touch.
 */
const membershipSubjects = (change: ReplicaChange): readonly string[] => {
  // A value write elsewhere, or a row entering or leaving a model: not a
  // membership row this index answers for.
  if (change.kind === "content" && !change.components.includes(EBB_COMPONENTS.membership)) {
    return [];
  }
  const { before, after } = change.delta.membership;
  const keys = [before?.entityId, after?.entityId].filter(
    (key): key is string => key !== undefined && key.length > 0,
  );
  return [...new Set(keys)];
};

/** The resolver serving row subscriptions against a change's membership pair. */
export const membershipResolver: IndexResolver = (change) => membershipSubjects(change);
