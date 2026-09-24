/**
 * `defineEntity` — typed entity definition factory.
 *
 * The factory is pure: it returns a frozen value with no behavior at
 * registration time. Composition into a runtime registry is the
 * caller's job (via `EntityRegistry.register`). The schema layer lives
 * in `@ebbjs/client` because it builds on wire primitives from
 * `@ebbjs/core`; see issue #143 for the rationale.
 */

export type FieldMarker = { type: "lww" } | { type: "counter" } | { type: "causal-tree" };

/**
 * Passive entity definition value.
 *
 * `EntityDef` is a structural type — it carries no behavior, only the
 * declared shape. The runtime registry (issue #143) is what consumes
 * it; this value stays inert.
 */
export interface EntityDef<TFields extends Record<string, FieldMarker>> {
  readonly name: string;
  readonly fields: TFields;
}

/**
 * Define an entity by name and field map. Each field is an `e.*()`
 * marker from `@ebbjs/core`; the marker types are not enforced on the
 * wire (issue #139), only here in the client-side schema.
 *
 * The returned value is frozen so accidental mutation of the definition
 * throws rather than silently diverging from the registry.
 */
export function defineEntity<TFields extends Record<string, FieldMarker>>(
  name: string,
  fields: TFields,
): EntityDef<TFields> {
  return Object.freeze({ name, fields });
}
