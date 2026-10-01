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

/**
 * Non-enumerable marker `defineEntity` uses to recognize fields that
 * came through `.nullable()`. The union returned by `.nullable()` is
 * a fresh schema without the `.nullable` method, so the chain
 * marker is the only way to recover the original intent at the
 * field-map level.
 */
const NULLABLE_MARKER = Symbol.for("@ebbjs/nullable");

const withNullable = <T extends TSchema>(schema: T): NullableSchema<T> => {
  const self = schema as NullableSchema<T>;
  Object.defineProperty(self, "nullable", {
    value: () => {
      const union = Type.Union([schema, Type.Null()]);
      // Stamp the marker onto the union so `defineEntity` can
      // detect this field came through `.nullable()` even though
      // the union itself doesn't carry the `.nullable` method.
      Object.defineProperty(union, NULLABLE_MARKER, { value: true, enumerable: false });
      return union;
    },
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
  const shapeFields = withImplicitOptional(fields);
  const derivedFields = Object.fromEntries(
    Object.keys(fields).map((k) => [k, deriveMarker(fields[k] as TSchema)]),
  ) as { [K in keyof TFields]: FieldMarker };
  return Object.freeze({
    name,
    shape: Type.Object(shapeFields) as EntityShape<TFields>,
    fields: derivedFields,
  });
}

/**
 * Mark every field whose schema carries the nullable sentinel as
 * `Type.Optional(...)`. Nullable means the field's value can be
 * `null` *or absent*, matching the wire envelope's three states
 * (set / nulled / absent) — the query-builder and row-accessor
 * tests already project `undefined` for absent fields. Without
 * this wrap, TypeBox would require the field to be present in any
 * `Value.Check` payload even when the user logically treats it as
 * optional, and the SDK's local validator would reject valid
 * create/update calls.
 *
 * The wrap is applied only at runtime; the static type still
 * requires nullable fields in `Static<TObject<TFields>>`. Callers
 * that want optional fields at the type level should pass
 * `Type.Optional` explicitly, or use the `Partial` modifier on
 * `update`'s patch input.
 */
const withImplicitOptional = <TFields extends Record<string, TSchema>>(
  fields: TFields,
): Record<string, TSchema> => {
  const out: Record<string, TSchema> = {};
  for (const [key, schema] of Object.entries(fields)) {
    out[key] = isNullableSchema(schema)
      ? Type.Optional(schema as Parameters<typeof Type.Optional>[0])
      : schema;
  }
  return out;
};

/**
 * Duck-type check for the nullable sentinel that `withNullable`
 * attaches to the schema. The original primitive (e.g.,
 * `e.string()`) carries `.nullable`; the union returned by
 * `.nullable()` carries the `NULLABLE_MARKER` symbol so the
 * signal survives across the chain. Either is enough to flag
 * the field as nullable-and-therefore-optional.
 */
const isNullableSchema = (schema: TSchema): boolean => {
  const candidate = schema as unknown as { nullable?: unknown };
  if (typeof candidate.nullable === "function") return true;
  const marked = schema as unknown as Record<symbol, unknown>;
  return marked[NULLABLE_MARKER] === true;
};

export type { TSchema };
