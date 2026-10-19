import type { Entity, FieldValue } from "@ebbjs/core";
import { isFieldMap } from "@ebbjs/core";

/**
 * Field equality with a reference fast path. The normative merge
 * (`mergeFieldValue`) returns the losing side by reference, so two leaves that
 * are distinct objects are genuinely different writes; only maps need a
 * structural walk to see through a touched key.
 */
const fieldValueEqual = (a: FieldValue, b: FieldValue): boolean => {
  if (a === b) return true;
  const aMap = isFieldMap(a);
  const bMap = isFieldMap(b);
  if (aMap !== bMap || !aMap || !bMap) return false;
  const aKeys = Object.keys(a.map);
  const bKeys = Object.keys(b.map);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const left = a.map[key];
    const right = b.map[key];
    if (left === undefined || right === undefined || !fieldValueEqual(left, right)) return false;
  }
  return true;
};

const fieldsEqual = (
  a: Readonly<Record<string, FieldValue>>,
  b: Readonly<Record<string, FieldValue>>,
): boolean => {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    const left = a[key];
    const right = b[key];
    if (left === undefined || right === undefined || !fieldValueEqual(left, right)) return false;
  }
  return true;
};

const absent = (entity: Entity | null | undefined): entity is null | undefined =>
  entity === null || entity === undefined;

/**
 * True when `next` differs from `prev` in anything a reader can observe.
 * `last_gsn` is delivery bookkeeping and is excluded, so a lower-HLC patch
 * that only advances it leaves the revision untouched.
 */
export const contentChanged = (
  prev: Entity | null | undefined,
  next: Entity | null | undefined,
): boolean => {
  if (absent(prev) || absent(next)) return absent(prev) !== absent(next);
  if (prev.type !== next.type) return true;
  if (prev.updated_hlc !== next.updated_hlc) return true;
  if (prev.deleted_hlc !== next.deleted_hlc) return true;
  return !fieldsEqual(prev.data.fields, next.data.fields);
};
