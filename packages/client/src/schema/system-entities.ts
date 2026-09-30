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
 */

import { defineEntity, e } from "./entity";

/**
 * Wire shape of a `Relationship` record. The server stores
 * relationship edges as `Relationship` entities carrying
 * `{source_id, target_id, type, field}` as field values; `target_id`
 * is nullable because the `delete` method uses `data: null` (no
 * fields) and a one-cardinality delete leaves the FK cleared.
 */
export const relationshipSystemEntity = defineEntity("relationship", {
  source_id: e.string(),
  target_id: e.string().nullable(),
  type: e.string(),
  field: e.string(),
});
