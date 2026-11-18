/**
 * Value comparison and canonical encoding over the plain JSON values the
 * wire carries.
 *
 * Every layer asks the same two questions. "Are these the same value?" is
 * asked by the query cache (a fresh result against the cached rows) and by
 * the query planner (a stored leaf against a predicate). "What is the one
 * spelling of this value?" is asked by the schema hash the server compares
 * for drift and by the entity diff that projects a position. One
 * implementation per question is what keeps those answers from drifting
 * apart as the shapes they see grow.
 */

/** How {@link canonicalKey} spells an absent (`undefined`) value. */
export interface CanonicalKeyOptions {
  /**
   * `"null"` folds `undefined` into `null`. That is the spelling the schema
   * hash has always had, so a schema declaring an `undefined` annotation
   * keeps comparing equal to the hash the server already accepted.
   *
   * `"undefined"` keeps the two apart, which a diff needs: "this position is
   * gone" and "this position holds null" are different edits.
   *
   * Defaults to `"null"`.
   */
  readonly undefinedAs?: "null" | "undefined";
}

/**
 * Structural equality: scalars by identity, arrays element-wise, plain
 * objects by key set regardless of key order.
 *
 * Two rows that arrived from different transports describe one state, so a
 * comparison asks "this value", never "this reference". An object with no
 * own enumerable keys (a `Date`, say) therefore equals any other, which is
 * the reading both callers were written against.
 */
export function structuralEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => structuralEqual(entry, b[index]));
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(bRecord, key) &&
        structuralEqual(aRecord[key], bRecord[key]),
    )
  );
}

/**
 * Canonical JSON for a value: object keys sorted at every level, arrays in
 * insertion order. Two structurally equal values encode to the same string,
 * which is what lets a hash or a diff key stand in for the value itself.
 *
 * `JSON.stringify` alone is not canonical: key order follows insertion, and
 * it has no spelling for the values below. This does.
 */
export function canonicalKey(value: unknown, options: CanonicalKeyOptions = {}): string {
  const absent = options.undefinedAs === "undefined" ? "undefined" : "null";
  return encode(value, absent);
}

function encode(value: unknown, absent: string): string {
  if (value === undefined) return absent;
  // JSON has no spelling for a function, symbol, or bigint; the absent tag
  // keeps the encoding total instead of throwing or silently dropping.
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    return absent;
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? absent;
  if (Array.isArray(value)) return `[${value.map((entry) => encode(entry, absent)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key], absent)}`).join(",")}}`;
}
