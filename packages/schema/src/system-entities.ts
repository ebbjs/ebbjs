/**
 * The platform's own components: the `ebb` model's four atomic values.
 *
 * Its components may sit on any row, are authorized by their own permission, and
 * never change the row's committed model. Each is atomic — one Update replaces
 * the whole value — and the membership and link keys are immutable after create,
 * so a move is a delete plus a create.
 *
 * `defineSchema` registers this model alongside the app's models, so the public
 * write paths can submit their Updates without callers hand-registering
 * anything. Kept out of `schema.ts` to avoid a cyclic import with `client.ts`,
 * and built with `buildModelDef` because `defineModel` rejects the reserved
 * name.
 */

import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox/type";

import { EBB_COMPONENTS, EBB_MODEL_NAME, type EbbComponentKind } from "@ebbjs/core";

import { buildModelDef, defineComponent, e, type ModelDef } from "./model";

export {
  EBB_COMPONENT_KINDS,
  EBB_COMPONENTS,
  EBB_MODEL_NAME,
  ebbComponent,
  ebbComponentField,
  ebbComponentKind,
  isEbbComponent,
  type EbbComponentKind,
} from "@ebbjs/core";

/**
 * A group's name and the apps it is in scope for. Absent means unscoped (every
 * app) and an empty list means no app, so the two must stay distinct. It is a
 * list because an atomic value may not contain a map: a nested map would lose
 * its per-key merge, which `e.object` refuses at definition time.
 */
const groupShape = e.object({
  name: e.string(),
  // Optional so absence (every app) stays distinct from an empty list (no app).
  apps: Type.Optional(e.array(e.string())),
});

/** One actor's permissions in one group. */
const grantShape = e.object({
  actor_id: e.string(),
  group_id: e.string(),
  permissions: e.array(e.string()),
});

/** One entity's membership of one group. */
const membershipShape = e.object({
  entity_id: e.string(),
  group_id: e.string(),
});

/** One edge from a source entity. */
const linkShape = e.object({
  source_id: e.string(),
  target_id: e.string(),
  type: e.string(),
  field: e.string(),
});

const groupComponent = defineComponent(EBB_COMPONENTS.group, groupShape, {
  optional: true,
  permission: "own",
});

const grantComponent = defineComponent(EBB_COMPONENTS.grant, grantShape, {
  optional: true,
  structural: true,
  permission: "own",
});

const membershipComponent = defineComponent(EBB_COMPONENTS.membership, membershipShape, {
  optional: true,
  structural: true,
  permission: "own",
});

const linkComponent = defineComponent(EBB_COMPONENTS.link, linkShape, {
  optional: true,
  structural: true,
  permission: "own",
});

/**
 * The platform model. Every component is optional because a row carries the one
 * that names its kind, not all four.
 */
export const ebbSystemEntity: ModelDef<Record<string, TSchema>> = buildModelDef(EBB_MODEL_NAME, {
  group: groupComponent,
  grant: grantComponent,
  membership: membershipComponent,
  link: linkComponent,
});

/** The value map of a group row: what `ebb/group` carries. */
export type GroupFields = Static<typeof groupShape>;

/** The value map of a grant row. */
export type GroupMemberFields = Static<typeof grantShape>;

/** Accessor name the built-in membership surface carries on every row. */
export const GROUPS_ACCESSOR = "groups";
