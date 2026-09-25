/**
 * `defineEntity` — pure factory returning a frozen entity definition.
 * No behavior at registration time; composition into a runtime
 * registry is the caller's job (via `EntityRegistry.register`).
 */

export type FieldMarker = { type: "lww" };

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
