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
 * The system entities are built with the unchecked factories
 * (`buildEntityDef` / `buildRelationshipDef`) because `defineEntity`
 * and `defineRelationship` reject the reserved system names and the
 * injected `groups` accessor.
 */

import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox/type";

import { buildEntityDef, e, type EntityDef } from "./entity";
import { buildRelationshipDef, type RelationshipDef } from "./relationship";

/**
 * Wire shape of a `Relationship` record. The server stores
 * relationship edges as `Relationship` entities carrying
 * `{source_id, target_id, type, field, kind}` as field values;
 * `target_id` is nullable because the `delete` method uses `data:
 * null` (no fields) and a one-cardinality delete leaves the FK
 * cleared. `kind` is `"member"` for an entity↔Group membership edge
 * and `"link"` for a domain edge; the server treats an absent kind as
 * `"link"`.
 */
export const relationshipSystemEntity = buildEntityDef("relationship", {
  source_id: e.string(),
  target_id: e.string().nullable(),
  type: e.string(),
  field: e.string(),
  kind: e.string(),
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

/** Field map of the client-side `group` entity. */
export type GroupFields = typeof groupSystemEntity extends EntityDef<infer F> ? F : never;

/** Accessor name the injected membership relationship carries. */
export const GROUPS_ACCESSOR = "groups";

/** Wire kind marking an entity↔Group membership edge. */
export const MEMBERSHIP_KIND = "member";

/**
 * The canonical membership relationship for `source`: `as`/wire
 * `field: "groups"`, target the `group` system entity, many-cardinality,
 * `kind: "member"`. Injected for every declared entity by
 * `defineSchema`; apps never author it.
 */
export function groupsRelationshipFor<S extends EntityDef<Record<string, TSchema>>>(
  source: S,
): RelationshipDef<S, typeof groupSystemEntity, typeof GROUPS_ACCESSOR, "many"> {
  return buildRelationshipDef({
    source,
    target: groupSystemEntity,
    as: GROUPS_ACCESSOR,
    sourceCardinality: "many",
    kind: MEMBERSHIP_KIND,
  });
}
