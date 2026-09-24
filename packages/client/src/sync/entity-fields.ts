/**
 * Field-access helpers for the sync layer.
 *
 * Centralizes the `entity.data?.fields?.[field]?.value` dance shared
 * by the relationship traversal helpers, the namespace read paths,
 * and the eventual collaborative-text wire layer. Today it owns:
 *
 * - `getFieldValue(entity, field)` — read a field's typed value,
 *   returning `undefined` when absent.
 * - `hasField(entity, field)` — boolean presence check; useful for
 *   distinguishing "field exists with value `undefined`" (rare; the
 *   materializer would need to enforce an explicit `undefined`) from
 *   "field absent from the data map" (the common case for unset
 *   `lww` pointers, missing counter increments, etc.).
 * - `stripField(update, field)` — internal helper that returns a new
 *   Update with `field` removed from `data.fields`. Used by
 *   `buildRelationshipWrite` so the wire doesn't carry the FK twice
 *   (entity update + relationship update), and reusable elsewhere
 *   when callers want to peel a field off a write.
 *
 * The helpers intentionally return `unknown` / booleans rather than
 * narrowing the type: the `FieldValueFor<FieldMarker>` mapping
 * (defined in `schema/entity.ts`) lives at the `QueryBuilder` and
 * handle read sites where the schema's `TFields` is in scope. This
 * file stays storage-shape-agnostic on purpose.
 */

import type { Entity, Update } from "@ebbjs/core";

/**
 * Read a field's value from a materialized entity. Returns
 * `undefined` when the entity has no data map, no `fields` envelope,
 * or the named field isn't present. Mirrors the behavior the old
 * `fieldValue(entity, field)` helper had before extraction; callers
 * that need to distinguish "absent" from "explicitly null" should
 * use `hasField` first.
 */
export function getFieldValue(entity: Entity, field: string): unknown {
  const fv = entity.data?.fields?.[field];
  if (fv === undefined) return undefined;
  return fv.value;
}

/**
 * True when the entity's `data.fields` map carries the named field.
 * Use before `getFieldValue` when the caller needs to distinguish
 * "absent" from "present with falsy value" — the materializer doesn't
 * populate absent fields, so the common reading path is just
 * `getFieldValue(...)` and the result is `undefined` either way.
 */
export function hasField(entity: Entity, field: string): boolean {
  return entity.data?.fields?.[field] !== undefined;
}

/**
 * Strip a field from an Update's `data.fields` map. Returns a new
 * Update object when the field is present; returns the input as-is
 * when there's no data envelope or the field isn't carried. Used by
 * `buildRelationshipWrite` so the relationship pointer doesn't ride
 * on both the entity Update and the Relationship Update (the wire
 * carries the FK once, on the Relationship side).
 *
 * Note: the field name passed here is the relationship's `as` name
 * (the entity field that holds the FK), which is the same key the
 * developer would address in `entity.data.fields[as]`. The caller is
 * responsible for knowing which fields to strip — this helper just
 * performs the array-key surgery.
 */
export function stripField(update: Update, field: string): Update {
  if (update.data === null) return update;
  const fields = update.data.fields;
  if (!(field in fields)) return update;
  const next: Record<string, (typeof fields)[string]> = {};
  for (const k of Object.keys(fields)) {
    if (k === field) continue;
    next[k] = fields[k]!;
  }
  return { ...update, data: { fields: next } };
}
