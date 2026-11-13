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
import { Static } from "@sinclair/typebox";

import { buildModelDef, defineComponent, e } from "./model";
import { PLATFORM_NAMESPACE } from "./reserved";

/** The model every platform row is committed under. */
export const EBB_MODEL_NAME = PLATFORM_NAMESPACE;

/**
 * The four platform components, as `<model>/<leaf>` names. Every caller that
 * has to name one asks here rather than writing the string, so a fifth one is
 * one registration and no dispatch site.
 */
export const EBB_COMPONENTS = Object.freeze({
  group: "ebb/group",
  grant: "ebb/grant",
  membership: "ebb/membership",
  link: "ebb/link",
} as const);

/** A platform component's kind: `"group" | "grant" | "membership" | "link"`. */
export type EbbComponentKind = keyof typeof EBB_COMPONENTS;

/** The component name for one kind. */
export const ebbComponent = (kind: EbbComponentKind): string => EBB_COMPONENTS[kind];

/** The kinds, in declaration order. */
export const EBB_COMPONENT_KINDS = Object.freeze(Object.keys(EBB_COMPONENTS) as EbbComponentKind[]);

const PLATFORM_COMPONENTS = new Set<string>(Object.values(EBB_COMPONENTS));

/** Whether a `<model>/<leaf>` component name belongs to a platform component. */
export const isEbbComponent = (name: string): boolean => PLATFORM_COMPONENTS.has(name);

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

const groupComponent = defineComponent(EBB_COMPONENTS.group, groupShape, { optional: true });

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
export const ebbSystemEntity = buildModelDef(EBB_MODEL_NAME, {
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
