/**
 * The committer: turn a batch of operations into one Action.
 *
 * It builds the single {@link OpContext} the batch shares, runs every
 * operation in order, and submits the flattened Updates as one Action.
 * The server delivers each Update by its own group scope (#473), so a
 * batch may span groups: a content write and a membership delta into
 * different groups compose without a client-side gate. The returned
 * `groups` is the sorted union of every operation's scope, for callers
 * that report the batch's visibility.
 *
 * Server rejections are *not* thrown here: an imperative caller reads
 * `response.rejected` so it can decide what to do. Only
 * `client.atomic` / `defineAction` promote a rejection to
 * {@link AtomicActionError}.
 */

import { generateId, type Update } from "@ebbjs/core";

import type { EntityRegistry } from "../schema/entity-registry";
import { type OperationCall, type OpContext } from "./operations";
import type { WriteResponse } from "./types";

/** What the committer needs from the client. */
export interface CommitCapability {
  readonly registry: EntityRegistry;
  submitRelationshipUpdates(updates: readonly Update[]): Promise<WriteResponse>;
  freshHlc(): string;
  generateUpdateId(): string;
  /** Local actor id; collaborative-text run ids embed it. */
  readonly actorId: string;
}

/** The committed batch, as observed by the caller. */
export interface CommitResult {
  readonly response: WriteResponse;
  /** Sorted union of every operation's group set. */
  readonly groups: readonly string[];
}

const sortedGroups = (groups: readonly string[]): readonly string[] => [...new Set(groups)].sort();

/**
 * Run every call under one shared context and submit the flattened
 * Updates as one Action.
 */
export async function commit(
  calls: readonly OperationCall[],
  cap: CommitCapability,
): Promise<CommitResult> {
  const ctx: OpContext = {
    registry: cap.registry,
    ids: {
      entityId: () => generateId("e"),
      updateId: () => cap.generateUpdateId(),
      hlc: () => cap.freshHlc(),
    },
    actorId: cap.actorId,
  };

  const results = calls.map((entry) => entry.operation(ctx, entry.input));

  const updates = results.flatMap((result) => result.updates);
  const groups = sortedGroups(results.flatMap((result) => result.groups));
  if (updates.length === 0) {
    return { response: { rejected: [] }, groups };
  }
  const response = await cap.submitRelationshipUpdates(updates);
  return { response, groups };
}
