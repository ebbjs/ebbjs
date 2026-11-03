/**
 * Project a wire field value to its application-facing value.
 *
 * The rule is purely structural: no field-kind dispatch, mirroring the
 * merge rule.
 */

import { isFieldMap, type FieldValue } from "@ebbjs/core";

/**
 * A map field is immutable per version, so its projection is cached by the
 * field's identity. A merge or a new snapshot produces a new field object; a
 * no-op reuses the old one, which is exactly when the cached projection is
 * still valid. The projection is shared, so callers must treat it as
 * read-only, like the field it came from.
 */
const projectedMaps = new WeakMap<FieldValue, Record<string, unknown>>();

/**
 * Project one wire field value.
 *
 * - leaf → its `.value`
 * - map → each entry projected, recursively, with tombstoned entries
 *   (`value: null`) omitted so a deleted key disappears from the
 *   projected object while its storage entry is retained.
 */
export const projectFieldValue = (field: FieldValue): unknown => {
  if (!isFieldMap(field)) return field.value;
  const cached = projectedMaps.get(field);
  if (cached !== undefined) return cached;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(field.map)) {
    const projected = projectFieldValue(entry);
    if (projected === null) continue;
    out[key] = projected;
  }
  projectedMaps.set(field, out);
  return out;
};
