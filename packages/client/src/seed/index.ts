/**
 * Browser-safe seed layer — one code path for browser demos and the
 * `@ebbjs/server` test harness.
 *
 * Seeds are schema-less plain data: explicit ids, explicit field
 * envelopes. {@link buildSeedAction} turns a {@link SeedData} into a
 * single wire `Action`; {@link seed} submits it directly over HTTP, and
 * `SyncClient.seed()` submits it through the public write path. Both
 * apply the same rejection-tolerance policy via
 * {@link assertSeedAccepted}.
 *
 * The three allowed imports from `@ebbjs/core` are the only runtime
 * dependencies, so this module stays usable from a browser.
 */

import { createAction, createClock, encodeSync, localEvent } from "@ebbjs/core";
import type { Action } from "@ebbjs/core";
import type { Rejection } from "../sync/types";

export type { Action };

export interface GroupSeed {
  id: string;
  name: string;
}

export interface GroupMemberSeed {
  id: string;
  actorId: string;
  groupId: string;
  permissions: string[];
}

export interface EntitySeed {
  id: string;
  type: string;
  patches: Array<{
    fields: Record<string, { value: unknown; hlc: string; update_id: string }>;
  }>;
}

export interface RelationshipSeed {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  field: string;
}

/** One entity↔Group membership row, submitted as an `entityGroup` put. */
export interface EntityGroupSeed {
  id: string;
  entityId: string;
  groupId: string;
}

export interface SeedData {
  groups: GroupSeed[];
  groupMembers: GroupMemberSeed[];
  entities: EntitySeed[];
  relationships?: RelationshipSeed[];
  entityGroups?: EntityGroupSeed[];
  baseHlc?: number;
}

export function buildSeedAction(actorId: string, data: SeedData): Action {
  const clock = createClock();

  const updates = [];

  for (const group of data.groups) {
    updates.push({
      subject_id: group.id,
      subject_type: "group",
      method: "put" as const,
      data: {
        fields: {
          name: { value: group.name, update_id: "seed_update", hlc: localEvent(clock) },
        },
      },
    });
  }

  for (const member of data.groupMembers) {
    updates.push({
      subject_id: member.id,
      subject_type: "groupMember",
      method: "put" as const,
      data: {
        fields: {
          actor_id: { value: member.actorId, update_id: "seed_update", hlc: localEvent(clock) },
          group_id: { value: member.groupId, update_id: "seed_update", hlc: localEvent(clock) },
          permissions: {
            value: member.permissions,
            update_id: "seed_update",
            hlc: localEvent(clock),
          },
        },
      },
    });
  }

  for (const entity of data.entities ?? []) {
    const fields: Record<string, { value: unknown; hlc: string; update_id: string }> = {};
    for (const patch of entity.patches) {
      for (const [key, val] of Object.entries(patch.fields)) {
        fields[key] = val;
      }
    }

    updates.push({
      subject_id: entity.id,
      subject_type: entity.type,
      method: "put" as const,
      data: { fields },
    });
  }

  for (const rel of data.relationships ?? []) {
    updates.push({
      subject_id: rel.id,
      subject_type: "relationship",
      method: "put" as const,
      data: {
        fields: {
          source_id: { value: rel.sourceId, update_id: "seed_update", hlc: localEvent(clock) },
          target_id: { value: rel.targetId, update_id: "seed_update", hlc: localEvent(clock) },
          type: { value: rel.type, update_id: "seed_update", hlc: localEvent(clock) },
          field: { value: rel.field, update_id: "seed_update", hlc: localEvent(clock) },
        },
      },
    });
  }

  for (const membership of data.entityGroups ?? []) {
    updates.push({
      subject_id: membership.id,
      subject_type: "entityGroup",
      method: "put" as const,
      data: {
        fields: {
          entity_id: {
            value: membership.entityId,
            update_id: "seed_update",
            hlc: localEvent(clock),
          },
          group_id: {
            value: membership.groupId,
            update_id: "seed_update",
            hlc: localEvent(clock),
          },
        },
      },
    });
  }

  const { action } = createAction({ actorId, updates, clock });
  return action;
}

/**
 * Rejection reasons a seed tolerates. Current servers emit neither —
 * duplicate Actions are deduped in `cf_action_dedup`, and
 * `already_exists` is not a validation rejection — but a seed is
 * idempotent by intent, so the policy is explicit and testable rather
 * than an accident of the current server.
 */
export const TOLERATED_SEED_REJECTIONS: readonly string[] = ["already_exists", "duplicate_action"];

export function isToleratedSeedRejection(reason: unknown): boolean {
  return typeof reason === "string" && TOLERATED_SEED_REJECTIONS.includes(reason);
}

export class SeedRejectedError extends Error {
  readonly rejections: readonly Rejection[];

  constructor(rejections: readonly Rejection[]) {
    super(`Seed rejected: ${rejections.map((r) => r.reason).join(", ")}`);
    this.name = "SeedRejectedError";
    this.rejections = rejections;
  }
}

/** Throw {@link SeedRejectedError} if any rejection is not tolerated. */
export function assertSeedAccepted(rejections: readonly Rejection[]): void {
  const fatal = rejections.filter((rejection) => !isToleratedSeedRejection(rejection.reason));
  if (fatal.length > 0) {
    throw new SeedRejectedError(fatal);
  }
}

/**
 * `POST /sync/actions` with a pre-built Action, used by {@link seed}.
 */
async function postSeedAction(serverUrl: string, actorId: string, action: Action): Promise<void> {
  const baseUrl = serverUrl.replace(/\/$/, "");
  const body = encodeSync({ actions: [action] });

  const res = await fetch(`${baseUrl}/sync/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/msgpack",
      "x-ebb-actor-id": actorId,
    },
    body: body as BodyInit,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Seed failed: ${res.status} ${text}`);
  }

  let parsed: { rejected?: Rejection[] } = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // A tolerant server may answer with an empty body on success.
  }
  assertSeedAccepted(parsed.rejected ?? []);
}

/** Build and submit a seed Action in one call. */
export async function seed(serverUrl: string, actorId: string, data: SeedData): Promise<void> {
  await postSeedAction(serverUrl, actorId, buildSeedAction(actorId, data));
}
