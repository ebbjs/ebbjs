import type { Entity, FieldValue, HLCTimestamp, Update } from "@ebbjs/core";
import { latestHlc, mergeFieldValue } from "@ebbjs/core";

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
 * Higher HLC wins; equal HLC breaks toward the lexicographically
 * greater `update_id`. A map field merges key by key. The recursive
 * rule itself lives in `@ebbjs/core` so the server, the outbox, and
 * both adapters share one definition.
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
 *   `updated_hlc`. A delete for a row that was never materialized is a
 *   no-op, so a per-Update delivery (#473) cannot break the drain.
 */
export const applyUpdate = (
  entity: Entity | null,
  update: Update,
  gsn: number,
  hlc: HLCTimestamp,
): Entity | null => {
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
      // A per-Update delivery can land a patch in a group that never held
      // the base `put`; the content backfill supplies the base (#475).
      if (!entity) return null;
      if (entity.deleted_hlc) return entity;
      return {
        ...entity,
        data: mergeFields(entity.data, update),
        updated_hlc: latestHlc(entity.updated_hlc, hlc),
        last_gsn: Math.max(entity.last_gsn, gsn),
      };

    case "delete":
      // The delivered group may never have held the row: with per-Update
      // scope the delete and the put can land in different groups (#473).
      // Absence is already the post-delete state, so it is a no-op.
      if (!entity) return null;
      return {
        ...entity,
        deleted_hlc: hlc,
        updated_hlc: hlc,
        last_gsn: Math.max(entity.last_gsn, gsn),
      };
  }
};
