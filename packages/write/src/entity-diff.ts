/**
 * Entity diff — the projection of a before/after row pair into the
 * positions that differ.
 *
 * Shared by every reader that compares two rows at the field-position
 * level: the conflict view's subject states and entity history. Positions
 * are the vocabulary the merge uses — a top-level field, then ordered map
 * keys — so the diff reads like the merge's verdict rather than a
 * structural object walk.
 */

import { isFieldMap, type Entity, type FieldValue } from "@ebbjs/core";

import { projectFieldValue } from "./field-projection";

/**
 * One position that differs between a before and after row. `path` is the
 * map-key path from the field root, empty for a whole non-map field. The
 * values are projected through {@link projectFieldValue}, the same rule
 * the merge and the conflict slots use.
 */
export interface EntityDiff {
  /** The top-level field the differing position belongs to. */
  readonly field: string;
  /** Ordered map keys from the field root to the position; empty at the root. */
  readonly path: readonly string[];
  /** The projected value on the before row; `undefined` when absent. */
  readonly before: unknown;
  /** The projected value on the after row; `undefined` when absent. */
  readonly after: unknown;
  /** Derived from the projected values: an absent before is `added`, an absent after `removed`, else `changed`. */
  readonly kind: "changed" | "added" | "removed";
}

/** A null row contributes no fields, so the other side's fields all read as added. */
const rowFields = (entity: Entity | null): Record<string, FieldValue> => entity?.data.fields ?? {};

/**
 * Canonical string for a projected value. A tombstone already projects as
 * absent (`undefined`), so only absence needs its own spelling. Mirrors
 * `stableStringify` in `client.ts`: object keys sorted at every level,
 * arrays in order.
 */
const stableValueString = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(stableValueString).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableValueString(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
};

/** A position only emits when the two projected values differ. */
const projectedEqual = (before: unknown, after: unknown): boolean =>
  stableValueString(before) === stableValueString(after);

/**
 * A nested map entry that projects to `null` is a tombstone, not a
 * present value: `projectFieldValue` omits it from a map, so the diff
 * reads it as absent rather than as a changed position.
 */
const presentChild = (child: FieldValue | undefined): FieldValue | undefined =>
  child !== undefined && projectFieldValue(child) === null ? undefined : child;

/**
 * Diff one position, recursing into a pair of maps. A pair of maps
 * recurses over the sorted union of their keys, so the diff vocabulary
 * matches the merge; any other pair projects each present side and emits
 * one diff when the projected values differ.
 */
const diffFieldValue = (
  field: string,
  path: readonly string[],
  before: FieldValue | undefined,
  after: FieldValue | undefined,
  out: EntityDiff[],
): void => {
  if (before !== undefined && after !== undefined && isFieldMap(before) && isFieldMap(after)) {
    // Map keys are positions, so recurse over their sorted union.
    const keys = [...new Set([...Object.keys(before.map), ...Object.keys(after.map)])].sort();
    for (const key of keys) {
      diffFieldValue(
        field,
        [...path, key],
        presentChild(before.map[key]),
        presentChild(after.map[key]),
        out,
      );
    }
    return;
  }
  // A leaf tombstone is absence in the read model, not a stored null.
  const beforeValue = before === undefined ? undefined : (projectFieldValue(before) ?? undefined);
  const afterValue = after === undefined ? undefined : (projectFieldValue(after) ?? undefined);
  if (projectedEqual(beforeValue, afterValue)) return;
  out.push({
    field,
    path,
    before: beforeValue,
    after: afterValue,
    kind: beforeValue === undefined ? "added" : afterValue === undefined ? "removed" : "changed",
  });
};

/**
 * Project a before/after pair into the positions that differ, top-level
 * fields sorted by name and paths sorted by key name. A null row reads
 * as an empty field map, so a null `before` makes every after field
 * `added`.
 */
export const diffEntity = (before: Entity | null, after: Entity | null): readonly EntityDiff[] => {
  const beforeFields = rowFields(before);
  const afterFields = rowFields(after);
  const names = [...new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])].sort();
  const out: EntityDiff[] = [];
  for (const field of names) {
    diffFieldValue(field, [], beforeFields[field], afterFields[field], out);
  }
  return out;
};
