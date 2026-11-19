/**
 * Generic append-only helpers for a log component.
 *
 * A log is a keyed component whose entries may only be added. Nothing here
 * knows what an entry is: the payload is opaque, the key is minted by the
 * writer, and comparison is structural. The engine-specific parsing a text
 * body needs lives with its cell schema, not in this module.
 */

import { isFieldLeaf, isFieldMap, structuralEqual, type FieldValue } from "@ebbjs/core";

/** A write tried to rewrite an entry a log already holds. */
export class AppendOnlyViolationError extends Error {
  /** The `<model>/<field>` component the write addressed. */
  readonly component: string;
  /** The existing entry keys the write would have rewritten. */
  readonly keys: readonly string[];

  constructor(component: string, keys: readonly string[]) {
    super(
      `Append-only log component "${component}": refusing to rewrite existing ` +
        `${keys.length === 1 ? "key" : "keys"} ` +
        `${keys.map((key) => JSON.stringify(key)).join(", ")}; ` +
        "a log's entries may only be added",
    );
    this.name = "AppendOnlyViolationError";
    this.component = component;
    this.keys = keys;
  }
}

/**
 * The live entries of a component value, keyed by entry key.
 *
 * A log's value is a map whose entries are leaves; a nested map is not an
 * entry, and a `null` value is a tombstone rather than an entry, so both are
 * skipped. Anything that is not a map carries no entries.
 */
export const logEntriesOf = (value: FieldValue | undefined): ReadonlyMap<string, unknown> => {
  const entries = new Map<string, unknown>();
  if (value === undefined || !isFieldMap(value)) return entries;
  for (const [key, entry] of Object.entries(value.map)) {
    if (!isFieldLeaf(entry)) continue;
    if (entry.value === null) continue;
    entries.set(key, entry.value);
  }
  return entries;
};

/**
 * The keys a write would rewrite: entries it carries under a key that
 * already exists with a different value.
 *
 * Only `value` is compared, so an entry's envelope (`update_id`, `hlc`) can
 * differ freely — the same entry re-delivered is not a rewrite. Order inside
 * an entry value is irrelevant, because the comparison is structural.
 */
export const logRewrites = (
  incoming: ReadonlyMap<string, unknown>,
  existing: ReadonlyMap<string, unknown>,
): readonly string[] => {
  const violated: string[] = [];
  for (const [key, value] of incoming) {
    if (!existing.has(key)) continue;
    if (!structuralEqual(existing.get(key), value)) violated.push(key);
  }
  return violated;
};
