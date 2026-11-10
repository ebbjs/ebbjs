import type { Action, Entity, FieldValue, HLCTimestamp, Update } from "@ebbjs/core";
import { componentField, componentModel, latestHlc, mergeFieldValue } from "@ebbjs/core";

import { adoptMapFields, mergeResidentFieldValue, toWireMapFields } from "./map-field";

/**
 * Shared materialization helpers used by every EntityStore implementation.
 *
 * Both the in-memory adapter and the IndexedDB adapter replay the same
 * action sequence into an entity state. Per-component application rules, BigInt
 * HLC handling, and the row's field projection all live here so the two
 * adapters cannot drift.
 */

/** One Update projected to the component write it is: a row field, a method, a value. */
export type ComponentUpdate =
  | { readonly field: string; readonly method: "merge" | "replace"; readonly value: FieldValue }
  | { readonly field: string; readonly method: "drop"; readonly value: null };

/** The model an Update commits under: the component prefix, or the row's type for a delete. */
export const updateModel = (update: Update, entity: Entity | null): string =>
  update.method === "delete" ? (entity?.type ?? "") : componentModel(update.component);

/**
 * Project one wire Update to the component write it carries. A `delete` names
 * no component and projects to `null`: it tombstones the row.
 */
export const componentUpdate = (update: Update): ComponentUpdate | null => {
  if (update.method === "delete") return null;
  const field = componentField(update.component);
  return update.method === "drop"
    ? { field, method: "drop", value: null }
    : { field, method: update.method, value: update.data };
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
 * Merges one component value into a row's field map under the wire's LWW rule.
 * Higher HLC wins; equal HLC breaks toward the lexicographically greater
 * `update_id`. A map field merges key by key. The recursive rule itself lives in
 * `@ebbjs/core` so the server, the outbox, and both adapters share one
 * definition.
 *
 * The fields record is copied only when a field actually changes; when the
 * write contributes nothing, the existing data object is returned by reference
 * so a caller can detect a no-op without a structural comparison. With
 * {@link MaterializeOptions.residentMapFields}, a large map field is a sharded
 * container, so a winning one-key write copies one shard rather than the whole
 * map.
 */
export const mergeFields = (
  existing: Entity["data"],
  write: Extract<ComponentUpdate, { method: "merge" | "replace" }>,
  options?: MaterializeOptions,
): Entity["data"] => {
  const mergeValue = options?.residentMapFields ? mergeResidentFieldValue : mergeFieldValue;
  const previous = existing.fields[write.field];
  const next = mergeValue(previous, write.value);
  return next === previous ? existing : { fields: { ...existing.fields, [write.field]: next } };
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

/** A fresh row created by the first component write. */
const createRow = (
  update: Exclude<Update, { method: "delete" }>,
  write: Extract<ComponentUpdate, { method: "merge" | "replace" }>,
  gsn: number,
  hlc: HLCTimestamp,
  options: MaterializeOptions | undefined,
): Entity => {
  const fields: Record<string, FieldValue> = { [write.field]: write.value };
  const created = write.method === "replace";
  return {
    id: update.subject_id,
    type: componentModel(update.component),
    data: { fields: options?.residentMapFields ? adoptMapFields(fields) : fields },
    // A `replace` is the row's create; a `merge` arrives first only when the
    // replica has not seen that create, so the placeholder waits for the base.
    exists: created,
    created_hlc: created ? hlc : null,
    updated_hlc: hlc,
    deleted_hlc: null,
    last_gsn: gsn,
  };
};

/**
 * Applies a single component Update to a row during materialization.
 *
 * - `merge` / `replace`: apply the component's value at its field under the
 *   leaf-level LWW compare. The first such write on a row that does not exist
 *   creates it; `replace` is the row's create, while `merge` leaves
 *   `exists: false` and `created_hlc: null` because the create has not been
 *   seen, so the row is a backfill candidate.
 * - `drop`: remove the field from an existing row; the row survives with its
 *   existence and creation time, even when the last component is detached.
 *   A tombstone stays a tombstone — detaching a component is not a
 *   resurrection.
 * - `delete`: tombstone the row, keeping its type and existence bit. A delete
 *   for a row that was never materialized is a no-op, so a per-Update delivery
 *   (#473) cannot break the drain.
 *
 * A component write to a tombstoned row resurrects it, exactly as the server's
 * materialization does.
 */
export const applyUpdate = (
  entity: Entity | null,
  update: Update,
  gsn: number,
  hlc: HLCTimestamp,
  options?: MaterializeOptions,
): Entity | null => {
  if (update.method === "delete") {
    // The delivered group may never have held the row: with per-Update
    // scope the delete and its components can land in different groups (#473).
    // Absence is already the post-delete state, so it is a no-op.
    if (!entity) return null;
    return {
      ...entity,
      deleted_hlc: hlc,
      updated_hlc: hlc,
      last_gsn: Math.max(entity.last_gsn, gsn),
    };
  }

  const write = componentUpdate(update);
  if (write === null) return entity;
  if (write.method === "drop") {
    if (!entity) return null;
    const { [write.field]: _dropped, ...fields } = entity.data.fields;
    return {
      ...entity,
      data: { fields },
      updated_hlc: latestHlc(entity.updated_hlc, hlc),
      last_gsn: Math.max(entity.last_gsn, gsn),
    };
  }
  if (!entity) return createRow(update, write, gsn, hlc, options);

  const created = write.method === "replace" && !entity.exists;
  return {
    ...entity,
    type: componentModel(update.component),
    // A leaf `replace` is the leaf-level LWW compare, so it shares the merge
    // rule: an out-of-order base snapshot must not clobber a newer write.
    data: mergeFields(entity.data, write, options),
    exists: entity.exists || write.method === "replace",
    created_hlc: created ? hlc : entity.created_hlc,
    updated_hlc: latestHlc(entity.updated_hlc, hlc),
    deleted_hlc: null,
    last_gsn: Math.max(entity.last_gsn, gsn),
  };
};

/**
 * Fold one Action's Updates for `entityId` into a row: every Update addressed
 * to that subject, in `updates` order, under the Action's `gsn` and `hlc`.
 * An Update for another subject belongs to a different row and is skipped.
 *
 * This is the replay step every EntityStore adapter runs for the row it is
 * materializing.
 */
export const foldEntityAction = (
  entity: Entity | null,
  entityId: string,
  action: Action,
): Entity | null => {
  let folded = entity;

  for (const update of action.updates) {
    if (update.subject_id !== entityId) continue;
    folded = applyUpdate(folded, update, action.gsn, action.hlc);
  }

  return folded;
};

/**
 * Fold a whole Action sequence for one subject, in the order given. Both
 * entity stores replay a `getForEntity` read through this.
 */
export const foldEntityActions = (actions: readonly Action[], entityId: string): Entity | null => {
  let folded: Entity | null = null;

  for (const action of actions) {
    folded = foldEntityAction(folded, entityId, action);
  }

  return folded;
};
