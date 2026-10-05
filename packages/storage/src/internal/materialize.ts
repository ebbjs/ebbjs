import type { Entity, FieldValue, HLCTimestamp, Update } from "@ebbjs/core";
import { compare, latestHlc } from "@ebbjs/core";

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
 * Merges patch fields into existing entity data using LWW semantics.
 * Higher HLC wins; equal HLC uses lexicographic update_id (newer >= older).
 */
export const mergeFields = (existing: Entity["data"], update: Update): Entity["data"] => {
  const patch = readFields(update);
  const merged = { ...existing.fields };

  for (const [field, patchValue] of Object.entries(patch)) {
    const existingValue = merged[field];
    if (!existingValue) {
      merged[field] = patchValue;
    } else {
      const hlcCmp = compare(existingValue.hlc ?? "", patchValue.hlc ?? "");
      if (hlcCmp < 0) {
        merged[field] = patchValue;
      } else if (hlcCmp === 0) {
        if (patchValue.update_id >= existingValue.update_id) {
          merged[field] = patchValue;
        }
      }
    }
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
