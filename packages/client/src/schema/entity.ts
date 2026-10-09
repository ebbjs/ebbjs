/**
 * `defineEntity` — pure factory returning a frozen entity definition.
 *
 * `defineEntity(name, fields)` accepts a bare field map and wraps it
 * internally in `Type.Object(fields)` so callers never write the wrapper
 * themselves. The wrapped schema is stored as `EntityDef.shape`; the
 * unwrapped field map, with its merge-marker projection, is stored as
 * `EntityDef.fields`. Marker and shape are independent axes.
 *
 * A field declared with `e.collaborativeText()` is *derived*: the
 * parent carries no wire value for it. `buildEntityDef` hoists it out
 * of `shape` / `fields` and records it under `EntityDef.derived`, so
 * `defineSchema` can expand it into a document entity plus a
 * relationship.
 */

import { Type } from "@sinclair/typebox";
import type {
  TSchema,
  TOptional,
  TUnion,
  TNull,
  TNever,
  TRecord,
  TString,
} from "@sinclair/typebox/type";

import type { TextDocument } from "../fields/collaborative-text/text-document";
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

/**
 * The TypeBox schema produced by `e.map(valueSchema)`: a string-keyed
 * object whose values are `valueSchema`. On the wire the entries merge
 * key by key under the recursive merge rule (#326).
 */
export type MapSchema<V extends TSchema> = TRecord<TString, V>;

/** Options accepted by `e.collaborativeText`. */
export interface CollaborativeTextOptions<E extends string | undefined = undefined> {
  /**
   * Name of the document entity backing the body. Defaults to the
   * shared `text_document`. Set it to grant the body its own
   * `<entity>.*` permissions independently of the parent.
   */
  readonly entity?: E;
}

declare const COLLABORATIVE_TEXT_BRAND: unique symbol;

/**
 * Marker-stamped schema returned by `e.collaborativeText()`. The
 * TypeBox schema is `Type.Never()` — the parent carries no wire value
 * — and the brand makes the field recognisable at the type level so
 * {@link WireFields} can hoist it out of the parent's shape. The
 * brand's type argument is the document entity name (`undefined` for
 * the shared default).
 */
export type CollaborativeTextSchema<E extends string | undefined = string | undefined> = TNever & {
  readonly [COLLABORATIVE_TEXT_BRAND]: E;
};

const COLLABORATIVE_TEXT_MARKER = Symbol.for("@ebbjs/collaborative-text");

/** Runtime payload stamped on a collaborative-text schema. */
interface CollaborativeTextMarker {
  readonly entity: string | undefined;
}

const readCollaborativeTextMarker = (schema: TSchema): CollaborativeTextMarker | undefined =>
  Object.getOwnPropertyDescriptor(schema, COLLABORATIVE_TEXT_MARKER)?.value as
    | CollaborativeTextMarker
    | undefined;

/** Last-writer-wins typed-field helpers. Each returns a TypeBox primitive. */
export const e = {
  string: (): NullableSchema<ReturnType<typeof Type.String>> => withNullable(Type.String()),
  number: (): NullableSchema<ReturnType<typeof Type.Number>> => withNullable(Type.Number()),
  integer: (): NullableSchema<ReturnType<typeof Type.Integer>> => withNullable(Type.Integer()),
  boolean: (): NullableSchema<ReturnType<typeof Type.Boolean>> => withNullable(Type.Boolean()),
  /**
   * A map field: a string-keyed object whose entries merge key by key
   * under the wire's recursive merge rule rather than replacing the
   * whole field.
   */
  map: <V extends TSchema>(value: V): NullableSchema<MapSchema<V>> =>
    withNullable(Type.Record(Type.String(), value) as MapSchema<V>),
  /**
   * Declare a collaborative-text body. The field is derived: it stays
   * out of the parent's wire shape. `defineSchema` expands it into a
   * document entity plus a relationship, and the projected row carries
   * a `Promise<TextDocument | null>` accessor under the same key.
   */
  collaborativeText: <const E extends string | undefined = undefined>(
    opts?: CollaborativeTextOptions<E>,
  ): CollaborativeTextSchema<E> => {
    const schema = Type.Never();
    Object.defineProperty(schema, COLLABORATIVE_TEXT_MARKER, {
      value: { entity: opts?.entity } satisfies CollaborativeTextMarker,
      enumerable: false,
    });
    return schema as unknown as CollaborativeTextSchema<E>;
  },
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
 * Detection keys on the union shape produced by `.nullable()`
 * rather than the `.nullable` chain method (which every `e.*()` builder
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
 * Keys of `TFields` declared with `e.collaborativeText()`. `never`
 * when the entity has no derived fields, which makes {@link WireFields}
 * the identity and {@link DerivedAccessors} the empty object.
 */
export type DerivedKeys<TFields> = {
  [K in keyof TFields]: TFields[K] extends CollaborativeTextSchema ? K : never;
}[keyof TFields];

/**
 * `TFields` with its derived keys removed. Feeds `shape`, `QueryFilter`,
 * and `EntityNamespace` so a derived body is neither a wire field nor
 * filterable.
 */
export type WireFields<TFields> = Omit<TFields, DerivedKeys<TFields>>;

/** Runtime description of one derived field, recorded on `EntityDef.derived`. */
export interface DerivedFieldDef {
  readonly kind: "collaborative-text";
  /** Document entity name; `undefined` for the shared `text_document`. */
  readonly entity: string | undefined;
}

/**
 * Row accessors contributed by derived fields: each derived key resolves
 * to the linked {@link TextDocument}, or `null` when no document is
 * linked.
 */
export type DerivedAccessors<TFields> = {
  readonly [K in DerivedKeys<TFields>]: Promise<TextDocument | null>;
};

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
  /**
   * TypeBox schema — drives value-shape typing. Implicit `Type.Object`
   * wrapper over the *wire* fields; derived fields are hoisted out.
   */
  readonly shape: EntityShape<WireFields<TFields>>;
  /** Merge-semantics markers for the wire fields — derived fields are absent. */
  readonly fields: { [K in keyof WireFields<TFields>]: FieldMarker };
  /** Fields declared with `e.collaborativeText()`, awaiting expansion. */
  readonly derived: { [K in DerivedKeys<TFields>]: DerivedFieldDef };
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
  const wireFields: Record<string, TSchema> = {};
  const derived: Record<string, DerivedFieldDef> = {};
  for (const [key, schema] of Object.entries(fields)) {
    const marker = readCollaborativeTextMarker(schema as TSchema);
    if (marker !== undefined) {
      derived[key] = { kind: "collaborative-text", entity: marker.entity };
      continue;
    }
    wireFields[key] = schema as TSchema;
  }

  const shapeFields = withImplicitOptional(wireFields);

  const derivedFields = Object.fromEntries(
    Object.keys(wireFields).map((k) => [k, deriveMarker(wireFields[k] as TSchema)]),
  ) as { [K in keyof WireFields<TFields>]: FieldMarker };
  const derivedMarkers = derived as { [K in DerivedKeys<TFields>]: DerivedFieldDef };
  return Object.freeze({
    name,
    shape: Type.Object(shapeFields) as EntityShape<WireFields<TFields>>,
    fields: derivedFields,
    derived: derivedMarkers,
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
  if ("nullable" in schema && typeof schema.nullable === "function") return true;

  return Object.getOwnPropertyDescriptor(schema, NULLABLE_MARKER)?.value === true;
};

export type { TSchema };
