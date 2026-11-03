/**
 * Relationship pointer values and their normalization to wire ids.
 *
 * Shared by the relationship-write path and the client's relationship
 * predicate, so both accept the same handle-or-id shapes.
 */

/**
 * A single pointer value accepted by a relationship predicate:
 * - a string id
 * - a handle with a string `.id` (a materialized entity, say)
 * - `null` / `undefined` — no live edge
 */
export type PointerValue = string | { readonly id: string } | null | undefined;

/**
 * Normalize a pointer value to a string id. `null` / `undefined`
 * normalize to `null`; anything that is neither a string nor an
 * object with a non-empty string `.id` throws.
 */
export function normalizePointer(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (value.length === 0) {
      throw new Error(`${label}: empty string is not a valid pointer id`);
    }
    return value;
  }
  if (typeof value === "object") {
    const obj = value as { id?: unknown };
    if (typeof obj.id === "string" && obj.id.length > 0) {
      return obj.id;
    }
    throw new Error(`${label}: object pointer must have a non-empty string .id`);
  }
  throw new Error(`${label}: pointer must be a string id, an entity with .id, or null/undefined`);
}
