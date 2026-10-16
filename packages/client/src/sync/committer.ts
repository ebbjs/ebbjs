/**
 * The committer: turn a batch of operations into one Action.
 *
 * It builds the single {@link OpContext} the batch shares, runs every
 * operation in order, and enforces #127's coherence rule — if any
 * operation resolves to a group set other than the batch's union, the
 * whole thing is refused before a single Update reaches the wire. The
 * server accepts a mixed-group Action (#461), so this client-side gate
 * is the contract, not a nicety.
 *
 * Server rejections are *not* thrown here: an imperative caller reads
 * `response.rejected` so it can decide what to do. Only
 * `client.atomic` / `defineAction` promote a rejection to
 * {@link AtomicActionError}.
 */

import { generateId, type Update } from "@ebbjs/core";

import type { EntityRegistry } from "../schema/entity-registry";
import {
  AtomicActionError,
  type AtomicRejection,
  type OperationCall,
  type OperationHandle,
  type OperationHandles,
  type OperationResult,
  type OpContext,
} from "./operations";
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
  readonly updates: readonly Update[];
  /** Sorted union of every operation's group set. */
  readonly groups: readonly string[];
  readonly handles: readonly unknown[];
}

const sameGroups = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((group, index) => group === b[index]);

const formatGroups = (groups: readonly string[]): string => `[${groups.join(", ")}]`;

const sortedGroups = (groups: readonly string[]): readonly string[] => [...new Set(groups)].sort();

const subjectOf = (result: OperationResult): OperationResult["subject"] => {
  if (result.subject !== undefined) return result.subject;
  const first = result.updates[0];
  return first === undefined ? undefined : { id: first.subject_id, type: first.subject_type };
};

/**
 * Coherence rejections for the batch. The batch's group set is the
 * union of every operation's groups; any operation whose own sorted,
 * de-duplicated set differs is reported, naming its subject and both
 * sets. Order-independent, so a declaration and the equivalent
 * callback refuse the same writes.
 */
const coherenceRejections = (results: readonly OperationResult[]): readonly AtomicRejection[] => {
  const grouped = results.map((result) => ({ result, groups: sortedGroups(result.groups) }));
  const actionGroups = sortedGroups(grouped.flatMap(({ groups }) => groups));
  return grouped.flatMap(({ result, groups }) => {
    if (sameGroups(groups, actionGroups)) return [];
    const subject = subjectOf(result);
    return [
      {
        id: subject?.id ?? "",
        subjectType: subject?.type,
        reason: "group_mismatch",
        details: `belongs to group(s) ${formatGroups(groups)}; the Action writes to ${formatGroups(actionGroups)}`,
      },
    ];
  });
};

/**
 * Run every call in order under one context, enforce coherence, and
 * submit the flattened Updates once. An empty batch submits nothing.
 */
export async function commit(
  calls: readonly OperationCall[],
  cap: CommitCapability,
): Promise<CommitResult> {
  const registered = new Map<OperationHandle, string>();
  const handles: OperationHandle[] = [];
  const handleRegistry: OperationHandles = {
    register(handle) {
      registered.set(handle, handle.id);
    },
    idOf(value) {
      if (typeof value !== "object" || value === null) return null;
      return registered.get(value as OperationHandle) ?? null;
    },
  };
  const ctx: OpContext = {
    registry: cap.registry,
    ids: {
      entityId: () => generateId("e"),
      updateId: () => cap.generateUpdateId(),
      hlc: () => cap.freshHlc(),
    },
    handles: handleRegistry,
    actorId: cap.actorId,
  };

  const results = calls.map((entry) => entry.operation(ctx, entry.input));
  for (const result of results) {
    if (result.handle === undefined) continue;
    handles.push(result.handle);
    handleRegistry.register(result.handle);
  }

  const rejections = coherenceRejections(results);
  if (rejections.length > 0) {
    throw new AtomicActionError(rejections);
  }

  const updates = results.flatMap((result) => result.updates);
  const groups = sortedGroups(results.flatMap((result) => result.groups));
  if (updates.length === 0) {
    return { response: { rejected: [] }, updates, groups, handles };
  }
  const response = await cap.submitRelationshipUpdates(updates);
  return { response, updates, groups, handles };
}
