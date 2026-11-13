/**
 * The platform's own components.
 *
 * `ebb/` is the platform namespace. Its components may sit on any row, are
 * authorized by their own permission, and never determine or change the row's
 * committed model — a row that carries only platform components is committed
 * under the model `ebb`.
 *
 * The four are atomic: one Update replaces the whole value, so an edge,
 * membership, or grant whose fields disagree with each other is
 * unrepresentable. Membership and link keys are immutable after create; a
 * move is a delete plus a create.
 *
 * `defineSchema` registers this model alongside the app's models, so the
 * public write paths (`link` / `unlink` / `setLinks`, `share`, `createGroup`,
 * membership writes) can submit their Updates without callers
 * hand-registering anything.
 *
 * Kept separate from `schema.ts` to avoid a cyclic import with `client.ts`
 * (the client seeds its per-client registry from a schema, but also imports
 * this model for the seed).
 *
 * Built with the unchecked factory (`buildModelDef`) because `defineModel`
 * rejects the reserved `ebb` name.
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
 * A group's name and the apps it is in scope for.
 *
 * `apps` is the list of app ids the group is in scope for. Absent means
 * unscoped (every app); an empty list means no app, so absence must not
 * collapse to `[]`. It is a list rather than the map the wire carried before
 * #805 because an atomic value may not contain a map: a map nested inside an
 * object loses its per-key merge, which `e.object` refuses at definition time.
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

/** One entity's membership of one group. The pair is immutable after create. */
const membershipShape = e.object({
  entity_id: e.string(),
  group_id: e.string(),
});

/** One edge from a source entity. The source is immutable after create. */
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
 * The platform model: four atomic components, of which a row carries the one
 * that names its kind. Every component is optional because a row carries one,
 * not all four.
 */
export const ebbSystemEntity: ModelDef<Record<string, TSchema>> = buildModelDef(EBB_MODEL_NAME, {
  group: groupComponent,
  grant: grantComponent,
  membership: membershipComponent,
  link: linkComponent,
});

/**
 * The value map of a group row: what the row's `ebb/group` component carries,
 * and what a group namespace projects.
 */
export type GroupFields = Static<typeof groupShape>;

/** The value map of a grant row (today's `groupMember`). */
export type GroupMemberFields = Static<typeof grantShape>;

/** The value map of a membership row (today's `entityGroup`). */
export type EntityGroupFields = Static<typeof membershipShape>;

/** The value map of a link row (today's `relationship`). */
export type RelationshipFields = Static<typeof linkShape>;

/** Accessor name the built-in membership surface carries on every row. */
export const GROUPS_ACCESSOR = "groups";
