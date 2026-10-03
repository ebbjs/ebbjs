/**
 * Wire-level system entities the SDK owns. `defineSchema` registers
 * these alongside user entities, and the per-client registry seeds
 * them too — so the public relationship-write path (`link` /
 * `unlink` / `setLinks`) can submit Relationship Updates without
 * callers hand-registering the system entity.
 *
 * Kept separate from `schema.ts` to avoid a cyclic import with
 * `client.ts` (the client seeds its per-client registry from a
 * schema, but also imports the system entity for the seed).
 *
 * The system entities are built with the unchecked factory
 * (`buildEntityDef`) because `defineEntity` rejects the reserved
 * system names.
 */

import { Type } from "@sinclair/typebox";

import { buildEntityDef, e, type EntityDef } from "./entity";

/**
 * Wire shape of a `Relationship` record. The server stores
 * relationship edges as `Relationship` entities carrying
 * `{source_id, target_id, type, field}` as field values; `target_id`
 * is nullable because the `delete` method uses `data: null` (no
 * fields) and a one-cardinality delete leaves the FK cleared.
 */
export const relationshipSystemEntity = buildEntityDef("relationship", {
  source_id: e.string(),
  target_id: e.string().nullable(),
  type: e.string(),
  field: e.string(),
});

/** Wire shape of a `Group` record, mirroring `@ebbjs/core`'s `GroupSchema`. */
export const groupSystemEntity = buildEntityDef("group", {
  name: e.string(),
});

/** Wire shape of a `GroupMember` record, mirroring `@ebbjs/core`'s `GroupMemberSchema`. */
export const groupMemberSystemEntity = buildEntityDef("groupMember", {
  group_id: e.string(),
  actor_id: e.string(),
  permissions: Type.Array(Type.String()),
});

/**
 * Wire shape of an `EntityGroup` record: one row per (entity, group)
 * membership, scoping an entity's writes to a group. Distinct from
 * `groupMember`, which carries actor permissions.
 */
export const entityGroupSystemEntity = buildEntityDef("entityGroup", {
  entity_id: e.string(),
  group_id: e.string(),
});

/** Field map of the client-side `group` entity. */
export type GroupFields = typeof groupSystemEntity extends EntityDef<infer F> ? F : never;

/** Field map of the `entityGroup` system entity. */
export type EntityGroupFields =
  typeof entityGroupSystemEntity extends EntityDef<infer F> ? F : never;

/** Accessor name the built-in membership surface carries on every row. */
export const GROUPS_ACCESSOR = "groups";
