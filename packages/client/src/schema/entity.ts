/**
 * `defineEntity` — pure factory returning a frozen entity definition.
 * No behavior at registration time; composition into a runtime
 * registry is the caller's job (via `EntityRegistry.register`).
 */

export type FieldMarker = { type: "lww" } | { type: "counter" } | { type: "causal-tree" };

/**
 * JS-side value type for a field marker. The mapping is best-effort
 * static typing only — the wire envelope carries `field.value` as
 * `unknown` (see `@ebbjs/core/types/action.ts`), so a misbehaving
 * peer can still violate the static type. Server-side validation is
 * the trust boundary; this mapping exists to narrow the common case
 * at compile time, not to enforce at runtime.
 *
 * - `lww` is the catch-all last-writer-wins field. The prototype's
 *   `e.string` / `e.number` / `e.boolean` helpers all return the
 *   `lww` marker; the static type unions the obvious primitives so
 *   `eq()` callers don't have to write a redundant cast.
 * - `counter` is additive — the static type is `number` because
 *   every increment lands as a number.
 * - `causal-tree` fields hold an opaque encoded tree blob (string).
 *   The collaborative-text wire layer maintains the actual tree and
 *   reads `value` as a string; the SDK exposes no public mutation
 *   primitive for these today.
 */
export type FieldValueFor<T extends FieldMarker> = T extends { type: "counter" }
  ? number
  : T extends { type: "lww" }
    ? string | number | boolean | null
    : T extends { type: "causal-tree" }
      ? string
      : never;

/** Passive entity definition value. The runtime registry consumes it. */
export interface EntityDef<TFields extends Record<string, FieldMarker>> {
  readonly name: string;
  readonly fields: TFields;
}

/** Define an entity by name and field map. The result is frozen. */
export function defineEntity<TFields extends Record<string, FieldMarker>>(
  name: string,
  fields: TFields,
): EntityDef<TFields> {
  return Object.freeze({ name, fields });
}
