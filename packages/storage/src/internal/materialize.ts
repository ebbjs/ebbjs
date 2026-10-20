import type { Entity, FieldValue, HLCTimestamp, Update } from "@ebbjs/core";
import { latestHlc, mergeFieldValue } from "@ebbjs/core";

import { adoptMapFields, mergeResidentFieldValue, toWireMapFields } from "./map-field";

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
 * Whether a materialized row keeps large map fields in the replica's sharded
 * container. The replica owns its rows and flattens them at the record
 * boundary; the legacy adapters deep-clone every row, so they keep the plain
 * wire shape.
 */
export interface MaterializeOptions {
  readonly residentMapFields?: boolean;
}

/** The replica's materialization options. */
export const RESIDENT_MAP_FIELDS: MaterializeOptions = { residentMapFields: true };

/**
 * Merges patch fields into existing entity data using LWW semantics.
 * Higher HLC wins; equal HLC breaks toward the lexicographically
 * greater `update_id`. A map field merges key by key. The recursive
 * rule itself lives in `@ebbjs/core` so the server, the outbox, and
 * both adapters share one definition.
 *
 * The fields record is copied only when a field actually changes; when
 * the patch contributes nothing, the existing data object is returned
 * by reference so a caller can detect a no-op without a structural
 * comparison. With {@link MaterializeOptions.residentMapFields}, a large map
 * field is a sharded container, so a winning one-key patch copies one shard
 * rather than the whole map.
 */
export const mergeFields = (
  existing: Entity["data"],
  update: Update,
  options?: MaterializeOptions,
): Entity["data"] => {
  const patch = readFields(update);
  const mergeValue = options?.residentMapFields ? mergeResidentFieldValue : mergeFieldValue;
  let merged: Record<string, FieldValue> | undefined;

  for (const [field, patchValue] of Object.entries(patch)) {
    const previous = merged === undefined ? existing.fields[field] : merged[field];
    const next = mergeValue(previous, patchValue);
    if (next !== previous) {
      if (merged === undefined) merged = { ...existing.fields };
      merged[field] = next;
    }
  }

  return merged === undefined ? existing : { fields: merged };
};

const withTransformedFields = (
  entity: Entity,
  transform: (fields: Record<string, FieldValue>) => Record<string, FieldValue>,
): Entity => {
  const fields = transform(entity.data.fields);
  return fields === entity.data.fields ? entity : { ...entity, data: { ...entity.data, fields } };
};

/**
 * Adopt the large map fields of a row installed from a cold read or a record.
 * Returns the same row when every map field is already resident in the shape
 * the merge path expects.
 */
export const withAdoptedMapFields = (entity: Entity): Entity =>
  withTransformedFields(entity, adoptMapFields);

/**
 * Flatten a row's resident map fields to the wire shape before it crosses the
 * record boundary. Returns the same row when it holds no containers.
 */
export const withWireMapFields = (entity: Entity): Entity =>
  withTransformedFields(entity, toWireMapFields);

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
  options?: MaterializeOptions,
): Entity | null => {
  switch (update.method) {
    case "put":
      return {
        id: update.subject_id,
        type: update.subject_type,
        data: {
          fields: options?.residentMapFields
            ? adoptMapFields(readFields(update))
            : readFields(update),
        },
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
        data: mergeFields(entity.data, update, options),
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
