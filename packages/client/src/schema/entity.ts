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
import type { TSchema, TOptional, TUnion, TNull } from "@sinclair/typebox/type";

import { assertEntityNameAvailable, assertFieldNamesAvailable } from "./reserved";

/** Merge-semantics marker. Marker and shape are independent axes. */
// Future counter / causal-tree markers extend this union in their own issues.
export type FieldMarker = { type: "lww" };

/** Schema with a `.nullable()` chain producing `T | null`. */
export type NullableSchema<T extends TSchema> = T & {
  readonly nullable: () => ReturnType<typeof Type.Union<[T, ReturnType<typeof Type.Null>]>>;
};

/**
 * Marker stamped onto the union returned by `.nullable()` so
 * `defineEntity` can recognize the field came through the chain
 * even though the union itself doesn't carry the `.nullable`
 * method.
 */
const NULLABLE_MARKER = Symbol.for("@ebbjs/nullable");

const withNullable = <T extends TSchema>(schema: T): NullableSchema<T> => {
  const self = schema as NullableSchema<T>;
  Object.defineProperty(self, "nullable", {
    value: () => {
      const union = Type.Union([schema, Type.Null()]);
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
 * True at the type level when `T` is the union shape produced by
 * `.nullable()`: `Type.Union<[T, TNull]>`. The chain helper drops
 * its `.nullable` method when called, so the resulting `TUnion` is
 * the user-facing marker that a field is nullable.
 */
type IsNullableUnion<T> =
  T extends TUnion<infer Members>
    ? Members extends readonly [unknown, infer Second]
      ? Second extends TNull
        ? true
        : false
      : false
    : false;

/**
 * Type-level mirror of {@link withImplicitOptional}: nullable fields
 * become `TOptional<T>` in the static type so `Static<TObject<...>>`
 * agrees with the runtime shape (`Type.Optional(...)` wrap that
 * `Value.Check` accepts). Non-nullable fields pass through untouched.
 *
 * Detection keys on the union shape produced by `.nullable()` rather
 * than the `.nullable` chain method (which every `e.*()` builder
 * carries by default and would over-eagerly mark every field
 * optional).
 */
type WithImplicitOptional<T extends TSchema> = IsNullableUnion<T> extends true ? TOptional<T> : T;

export type ShapeFields<TFields extends Record<string, TSchema>> = {
  [K in keyof TFields]: WithImplicitOptional<TFields[K]>;
};

/**
 * The TypeBox object schema wrapping a field map. Returned by
 * `defineEntity` as `EntityDef.shape`. Field-value types flow through
 * `Static<TObject<TFields>>` (TypeBox's static resolver); callers can
 * reach them with `Static<typeof def["shape"]>` if they want explicit
 * value-type extraction.
 *
 * Nullable fields are represented as `TOptional<T>` in the static type
 * to match the runtime `Type.Optional(...)` wrap applied by
 * `withImplicitOptional` — see `ShapeFields`.
 */
export type EntityShape<TFields extends Record<string, TSchema>> = ReturnType<
  typeof Type.Object<ShapeFields<TFields>>
>;

/**
 * Passive entity definition value. The runtime registry consumes it.
 *
 * `TName` carries the literal name passed to `defineEntity` so
 * downstream type-level walkers (e.g. the per-accessor row type) can
 * match a relationship's `source` / `target` back to an entity. The
 * default `string` keeps erased usages (`EntityDef<...>`, the runtime
 * registry) compiling without a name argument.
 */
export interface EntityDef<TFields extends Record<string, TSchema>, TName extends string = string> {
  readonly name: TName;
  /** TypeBox schema — drives value-shape typing. Implicit `Type.Object` wrapper. */
  readonly shape: EntityShape<TFields>;
  /** Merge-semantics markers — derived from the field map. */
  readonly fields: { [K in keyof TFields]: FieldMarker };
}

/**
 * Define an entity by name and field map. The result is frozen.
 * Throws {@link ReservedNameError} when the name is a system entity
 * or the field map declares the injected `groups` accessor.
 */
export function defineEntity<TFields extends Record<string, TSchema>, TName extends string>(
  name: TName,
  fields: TFields,
): EntityDef<TFields, TName> {
  assertEntityNameAvailable(name);
  assertFieldNamesAvailable(name, fields);
  return buildEntityDef(name, fields);
}

/**
 * Unchecked entity factory. `defineEntity` validates reserved names
 * first; the SDK's own system entities (`group`, `groupMember`,
 * `relationship`) build through here.
 */
export function buildEntityDef<TFields extends Record<string, TSchema>, TName extends string>(
  name: TName,
  fields: TFields,
): EntityDef<TFields, TName> {
  const shapeFields = withImplicitOptional(fields) as unknown as ShapeFields<TFields>;
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
 * Wrap every nullable field in `Type.Optional` so `Value.Check`
 * treats absent values as valid (matching the wire envelope's
 * set / nulled / absent projection). The static type mirrors this
 * wrap via `ShapeFields` so `Static<TObject<...>>` agrees — nullable
 * fields are optional at both runtime and compile time.
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

/** True for fields that came through `.nullable()` — either the chain method or the marker. */
const isNullableSchema = (schema: TSchema): boolean => {
  const candidate = schema as unknown as { nullable?: unknown };
  if (typeof candidate.nullable === "function") return true;
  const marked = schema as unknown as Record<symbol, unknown>;
  return marked[NULLABLE_MARKER] === true;
};

export type { TSchema };
