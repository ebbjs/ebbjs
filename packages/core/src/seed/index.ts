/**
 * Browser-safe seed layer — one builder shared by `client.seed()` and the
 * `@ebbjs/testing` test harness.
 *
 * Seeds are schema-less plain data: rows carry explicit ids and plain
 * field values. {@link buildSeedAction} turns a {@link SeedData} into a
 * single wire `Action`, stamping every component value with a uniform
 * `{ value, update_id, hlc }` envelope. Every row opens with its create, so a
 * seeded row exists whether or not it carries any component: an entity seed
 * with `patches: []` is a complete row. A platform row is one atomic
 * component, so it seeds as its create plus one Update carrying its whole
 * value; an edge is a keyed component of its source, so it seeds as one
 * `ebb/link` merge on that row. Both submit paths apply the same
 * rejection-tolerance policy via {@link assertSeedAccepted}.
 *
 * The only runtime dependencies are sibling `@ebbjs/core` modules, so
 * this subpath stays usable from a browser.
 */

import { createAction } from "../action";
import { createClock, localEvent } from "../hlc";
import { EBB_COMPONENTS, EBB_MODEL_NAME, type EbbComponentKind } from "../system";
import type { Action, FieldValue, UpdateInput } from "../types/action";
import type { HLCState } from "../hlc/types";

export type { Action };

export interface GroupSeed {
  id: string;
  name: string;
  /**
   * The app ids the group is in scope for. Omitted leaves it unscoped (every
   * app sees it); an empty list means no app, so the two are distinct.
   */
  apps?: readonly string[];
}

export interface GrantSeed {
  id: string;
  actorId: string;
  groupId: string;
  permissions: string[];
}

export interface EntitySeed {
  id: string;
  model: string;
  /**
   * Ordered field patches; values are plain, stamped by the builder. Empty
   * patches seed a zero-component row, which the row's create alone makes
   * exist.
   */
  patches: Array<{ fields: Record<string, unknown> }>;
}

/** One edge: a key on its source row's `ebb/link` component, not a row of its own. */
export interface RelationshipSeed {
  sourceId: string;
  targetId: string;
  type: string;
  field: string;
}

/** One entity↔Group membership row, submitted as an `ebb/membership` put. */
export interface MembershipSeed {
  id: string;
  entityId: string;
  groupId: string;
}

export interface SeedData {
  groups: GroupSeed[];
  grants: GrantSeed[];
  entities: EntitySeed[];
  relationships?: RelationshipSeed[];
  memberships?: MembershipSeed[];
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
 * The create every seeded row opens with: the row's existence and its creation
 * time, both from the builder's own clock so the row's creation time never
 * trails the data written to it.
 */
const rowCreate = (subjectId: string, model: string, clock: HLCState): UpdateInput => ({
  subject_id: subjectId,
  model,
  method: "create",
  hlc: localEvent(clock),
  data: null,
});

/**
 * One component Update: `data` is the component's own value, and the
 * component is `<model>/<field>` because a seed row names its model and
 * fields directly.
 */
const componentUpdate = (
  subjectId: string,
  model: string,
  field: string,
  data: FieldValue,
  method: "merge" | "replace" = "replace",
): UpdateInput => ({ subject_id: subjectId, component: `${model}/${field}`, method, data });

/**
 * One `ebb/link` edge: the three key levels, then the presence leaf. The edge
 * is a key of the source row's keyed component, so a seed adds a key rather
 * than creating a row.
 */
const linkEdgeValue = (edge: RelationshipSeed, clock: HLCState): FieldValue => ({
  map: {
    [edge.field]: {
      map: { [edge.type]: { map: { [edge.targetId]: stamp(true, clock) } } },
    },
  },
});

/** One platform row: its create, then its one atomic component's whole value. */
const platformRow = (
  kind: EbbComponentKind,
  subjectId: string,
  value: Record<string, unknown>,
  clock: HLCState,
): UpdateInput[] => [
  rowCreate(subjectId, EBB_MODEL_NAME, clock),
  {
    subject_id: subjectId,
    component: EBB_COMPONENTS[kind],
    method: "replace",
    data: stamp(value, clock),
  },
];

export function buildSeedAction(actorId: string, data: SeedData): Action {
  const clock = createClock();

  const updates: UpdateInput[] = [];

  for (const group of data.groups) {
    updates.push(
      ...platformRow(
        "group",
        group.id,
        group.apps === undefined
          ? { name: group.name }
          : { name: group.name, apps: [...group.apps] },
        clock,
      ),
    );
  }

  for (const member of data.grants) {
    updates.push(
      ...platformRow(
        "grant",
        member.id,
        {
          actor_id: member.actorId,
          group_id: member.groupId,
          permissions: [...member.permissions],
        },
        clock,
      ),
    );
  }

  for (const entity of data.entities ?? []) {
    updates.push(rowCreate(entity.id, entity.model, clock));
    for (const patch of entity.patches) {
      for (const [key, value] of Object.entries(patch.fields)) {
        updates.push(componentUpdate(entity.id, entity.model, key, stamp(value, clock)));
      }
    }
  }

  for (const edge of data.relationships ?? []) {
    updates.push({
      subject_id: edge.sourceId,
      component: EBB_COMPONENTS.link,
      method: "merge",
      data: linkEdgeValue(edge, clock),
    });
  }

  for (const membership of data.memberships ?? []) {
    updates.push(
      ...platformRow(
        "membership",
        membership.id,
        { entity_id: membership.entityId, group_id: membership.groupId },
        clock,
      ),
    );
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
