/**
 * Browser-safe seed layer — one builder shared by `client.seed()` and the
 * `@ebbjs/testing` test harness.
 *
 * Seeds are schema-less plain data: rows carry explicit ids and plain
 * field values. {@link buildSeedAction} turns a {@link SeedData} into a
 * single wire `Action`, stamping every field with a uniform
 * `{ value, update_id, hlc }` envelope. Both submit paths apply the same
 * rejection-tolerance policy via {@link assertSeedAccepted}.
 *
 * The only runtime dependencies are sibling `@ebbjs/core` modules, so
 * this subpath stays usable from a browser.
 */

import { createAction } from "../action";
import { createClock, localEvent } from "../hlc";
import type { Action, FieldValue } from "../types/action";
import type { HLCState } from "../hlc/types";

export type { Action };

export interface GroupSeed {
  id: string;
  name: string;
  /** App scope; omitted leaves the group unscoped (every app sees it). */
  apps?: Record<string, boolean>;
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
  /** Ordered field patches; values are plain, stamped by the builder. */
  patches: Array<{ fields: Record<string, unknown> }>;
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
  /** Reserved; the builder stamps HLCs per field and does not read this. */
  baseHlc?: number;
}

/**
 * Per-action rejection, mirroring the client's `Rejection` so
 * `WriteResponse.rejected` passes straight through. Within core it
 * duplicates the client type on purpose: this module cannot depend on
 * `@ebbjs/client`.
 */
export interface SeedRejection {
  readonly id: string;
  readonly reason: string;
  readonly details?: string | null;
}

/** Stamp a plain value into the wire's per-field envelope. */
const stamp = (value: unknown, clock: HLCState) => ({
  value,
  update_id: "seed_update",
  hlc: localEvent(clock),
});

/**
 * Stamp a plain map into the wire's map envelope. A map's entries are
 * leaves, so each key merges on its own HLC.
 */
const stampMap = (entries: Record<string, unknown>, clock: HLCState) => ({
  map: Object.fromEntries(
    Object.entries(entries).map(([key, value]) => [key, stamp(value, clock)]),
  ),
});

export function buildSeedAction(actorId: string, data: SeedData): Action {
  const clock = createClock();

  const updates = [];

  for (const group of data.groups) {
    const fields: Record<string, FieldValue> = { name: stamp(group.name, clock) };
    if (group.apps !== undefined) fields["apps"] = stampMap(group.apps, clock);
    updates.push({
      subject_id: group.id,
      subject_type: "group",
      method: "put" as const,
      data: { fields },
    });
  }

  for (const member of data.groupMembers) {
    updates.push({
      subject_id: member.id,
      subject_type: "groupMember",
      method: "put" as const,
      data: {
        fields: {
          actor_id: stamp(member.actorId, clock),
          group_id: stamp(member.groupId, clock),
          permissions: stamp(member.permissions, clock),
        },
      },
    });
  }

  for (const entity of data.entities ?? []) {
    const fields: Record<string, ReturnType<typeof stamp>> = {};
    for (const patch of entity.patches) {
      for (const [key, value] of Object.entries(patch.fields)) {
        fields[key] = stamp(value, clock);
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
          source_id: stamp(rel.sourceId, clock),
          target_id: stamp(rel.targetId, clock),
          type: stamp(rel.type, clock),
          field: stamp(rel.field, clock),
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
          entity_id: stamp(membership.entityId, clock),
          group_id: stamp(membership.groupId, clock),
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
  readonly rejections: readonly SeedRejection[];

  constructor(rejections: readonly SeedRejection[]) {
    super(`Seed rejected: ${rejections.map((r) => r.reason).join(", ")}`);
    this.name = "SeedRejectedError";
    this.rejections = rejections;
  }
}

/** Throw {@link SeedRejectedError} if any rejection is not tolerated. */
export function assertSeedAccepted(rejections: readonly SeedRejection[]): void {
  const fatal = rejections.filter((rejection) => !isToleratedSeedRejection(rejection.reason));
  if (fatal.length > 0) {
    throw new SeedRejectedError(fatal);
  }
}
