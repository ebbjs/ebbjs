/**
 * The platform's own components: the `ebb` model's four declarations.
 *
 * Its components may sit on any row, are authorized under their own component
 * name, and never change the row's committed model. Three are atomic values on
 * a row of their own — one Update carries the whole value — and their keys are
 * immutable, so a grant or membership move is a delete plus a create.
 *
 * `ebb/link` is a **keyed** component of its source row: `{<as>: {<type>:
 * {<target_id>: boolean}}}`. Its whole key is the edge's identity, so one
 * Update writes one edge and removing one tombstones that key. It is declared
 * here because a component's declaration is where its merge granularity lives,
 * and it declares no scope owner: it inherits its host row's membership, since
 * the row carrying it *is* the source.
 *
 * The three row kinds declare their *scope owner*, the entity a write's group
 * set resolves against: `ebb/group` is `self`, and `ebb/grant` and
 * `ebb/membership` name `group_id`. Declared here because only the `ebb/`
 * namespace may name a group.
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
  GROUPS_ACCESSOR,
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

/**
 * Every edge from one source: accessor, then type label, then target id. The
 * three levels are the key, so the innermost value is presence alone.
 */
const linkShape = e.map(e.map(e.map(e.boolean())));

const groupComponent = defineComponent(EBB_COMPONENTS.group, groupShape, {
  optional: true,
  scope: "self",
});

const grantComponent = defineComponent(EBB_COMPONENTS.grant, grantShape, {
  optional: true,
  structural: true,
  scope: "group_id",
});

const membershipComponent = defineComponent(EBB_COMPONENTS.membership, membershipShape, {
  optional: true,
  structural: true,
  scope: "group_id",
});

const linkComponent = defineComponent(EBB_COMPONENTS.link, linkShape, {
  optional: true,
  structural: true,
});

/**
 * The platform model. Every component is optional because a row carries the one
 * that names its kind, not all four.
 */
export const ebbModel: ModelDef<Record<string, TSchema>> = buildModelDef(EBB_MODEL_NAME, {
  group: groupComponent,
  grant: grantComponent,
  membership: membershipComponent,
  link: linkComponent,
});

/** The value map of a group row: what `ebb/group` carries. */
export type GroupFields = Static<typeof groupShape>;

/** The value map of a grant row. */
export type GrantFields = Static<typeof grantShape>;
