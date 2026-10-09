import type { Entity, FieldValue, HLCTimestamp, Update } from "@ebbjs/core";
import { compare, isFieldMap, latestHlc } from "@ebbjs/core";

/**
 * Shared materialization helpers used by every EntityStore implementation.
 *
 * Both the in-memory adapter and the IndexedDB adapter replay the same
 * action sequence into an entity state. LWW merge semantics, BigInt
 * HLC handling, and the field-envelope unwrap all live here so the
 * two adapters cannot drift.
 */

/**
 * Pull the field map off an Update's `data`.
 */
export const readFields = (update: Update): Record<string, FieldValue> => {
  return update.data?.fields ?? {};
};

/**
 * Merge one incoming field value over an existing one, recursively.
 *
 * - leaf over leaf: higher HLC wins; equal HLC breaks toward the
 *   lexicographically greater `update_id`.
 * - map over map: the key sets are unioned and each key merges by the
 *   same rule, so a write to one key leaves its siblings untouched.
 * - a mismatched kind (a leaf replacing a map or vice versa) replaces
 *   the whole value; a field's kind is fixed by its schema, so this
 *   only happens for a schema violation and the patch is the newer
 *   intent.
 *
 * A leaf `value: null` is a tombstone: it participates in the merge
 * like any other leaf so a late write can still beat it, and the
 * projection is what hides a tombstoned map key.
 */
export const mergeFieldValue = (
  existing: FieldValue | undefined,
  incoming: FieldValue,
): FieldValue => {
  if (existing === undefined) return incoming;
  if (!isFieldMap(existing) || !isFieldMap(incoming)) {
    if (isFieldMap(existing) || isFieldMap(incoming)) return incoming;
    const hlcCmp = compare(existing.hlc ?? "", incoming.hlc ?? "");
    if (hlcCmp < 0) return incoming;
    if (hlcCmp > 0) return existing;
    return incoming.update_id >= existing.update_id ? incoming : existing;
  }

  const merged: Record<string, FieldValue> = { ...existing.map };
  for (const [key, value] of Object.entries(incoming.map)) {
    merged[key] = mergeFieldValue(merged[key], value);
  }
  return { map: merged };
};

/**
 * Merges patch fields into existing entity data using LWW semantics.
 * Higher HLC wins; equal HLC breaks toward the lexicographically
 * greater `update_id`. A map field merges key by key.
 */
export const mergeFields = (existing: Entity["data"], update: Update): Entity["data"] => {
  const patch = readFields(update);
  const merged: Record<string, FieldValue> = { ...existing.fields };

  for (const [field, patchValue] of Object.entries(patch)) {
    merged[field] = mergeFieldValue(merged[field], patchValue);
  }

  return { fields: merged };
};

/**
 * Applies a single update to an entity during materialization.
 *
 * - PUT: full replacement
 * - PATCH: field-level LWW merge; ignored on a soft-deleted entity
 * - DELETE: soft delete (sets `deleted_hlc`); bumps `last_gsn` and
 *   `updated_hlc`
 */
export const applyUpdate = (
  entity: Entity | null,
  update: Update,
  gsn: number,
  hlc: HLCTimestamp,
): Entity => {
  switch (update.method) {
    case "put":
      return {
        id: update.subject_id,
        type: update.subject_type,
        data: { fields: readFields(update) },
        created_hlc: hlc,
        updated_hlc: hlc,
        deleted_hlc: null,
        last_gsn: gsn,
      };

    case "patch":
      if (!entity) throw new Error("Cannot patch non-existent entity");
      if (entity.deleted_hlc) return entity;
      return {
        ...entity,
        data: mergeFields(entity.data, update),
        updated_hlc: latestHlc(entity.updated_hlc, hlc),
        last_gsn: Math.max(entity.last_gsn, gsn),
      };

    case "delete":
      if (!entity) throw new Error("Cannot delete non-existent entity");
      return {
        ...entity,
        deleted_hlc: hlc,
        updated_hlc: hlc,
        last_gsn: Math.max(entity.last_gsn, gsn),
      };
  }
};
