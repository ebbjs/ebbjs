/**
 * `defineEntity` — pure factory returning a frozen entity definition.
 *
 * `defineEntity(name, fields)` accepts a bare field map and wraps it
 * internally in `Type.Object(fields)` so callers never write the wrapper
 * themselves. The wrapped schema is stored as `EntityDef.shape`; the
 * unwrapped field map, with its merge-marker projection, is stored as
 * `EntityDef.fields`. Marker and shape are independent axes.
 */

import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox/type";

/** Merge-semantics marker. Marker and shape are independent axes. */
// Future counter / causal-tree markers extend this union in their own issues.
export type FieldMarker = { type: "lww" };

/** Schema with a `.nullable()` chain producing `T | null`. */
export type NullableSchema<T extends TSchema> = T & {
  readonly nullable: () => ReturnType<typeof Type.Union<[T, ReturnType<typeof Type.Null>]>>;
};

const withNullable = <T extends TSchema>(schema: T): NullableSchema<T> => {
  const self = schema as NullableSchema<T>;
  Object.defineProperty(self, "nullable", {
    value: () => Type.Union([schema, Type.Null()]),
    enumerable: false,
  });
  return self;
};

/** Last-writer-wins typed-field helpers. Each returns a TypeBox primitive. */
export const e = {
  string: (): NullableSchema<ReturnType<typeof Type.String>> => withNullable(Type.String()),
  number: (): NullableSchema<ReturnType<typeof Type.Number>> => withNullable(Type.Number()),
  integer: (): NullableSchema<ReturnType<typeof Type.Integer>> => withNullable(Type.Integer()),
  boolean: (): NullableSchema<ReturnType<typeof Type.Boolean>> => withNullable(Type.Boolean()),
} as const;

const deriveMarker = (_schema: TSchema): FieldMarker => ({ type: "lww" });

/**
 * The TypeBox object schema wrapping a field map. Returned by
 * `defineEntity` as `EntityDef.shape`. Field-value types flow through
 * `Static<TObject<TFields>>` (TypeBox's static resolver); callers can
 * reach them with `Static<typeof def["shape"]>` if they want explicit
 * value-type extraction.
 */
export type EntityShape<TFields extends Record<string, TSchema>> = ReturnType<
  typeof Type.Object<TFields>
>;

/** Passive entity definition value. The runtime registry consumes it. */
export interface EntityDef<TFields extends Record<string, TSchema>> {
  readonly name: string;
  /** TypeBox schema — drives value-shape typing. Implicit `Type.Object` wrapper. */
  readonly shape: EntityShape<TFields>;
  /** Merge-semantics markers — derived from the field map. */
  readonly fields: { [K in keyof TFields]: FieldMarker };
}

/** Define an entity by name and field map. The result is frozen. */
export function defineEntity<TFields extends Record<string, TSchema>>(
  name: string,
  fields: TFields,
): EntityDef<TFields> {
  const derivedFields = Object.fromEntries(
    Object.keys(fields).map((k) => [k, deriveMarker(fields[k] as TSchema)]),
  ) as { [K in keyof TFields]: FieldMarker };
  return Object.freeze({
    name,
    shape: Type.Object(fields) as EntityShape<TFields>,
    fields: derivedFields,
  });
}

export type { TSchema };
