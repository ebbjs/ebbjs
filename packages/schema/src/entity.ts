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
  TNumber,
  TInteger,
  TBoolean,
  Static,
} from "@sinclair/typebox/type";

import type { TextDocument } from "./collaborative-text/text-document";
import { assertEntityNameAvailable, assertFieldNamesAvailable } from "./reserved";

/** Merge-semantics marker. Marker and shape are independent axes. */
// Future counter / causal-tree markers extend this union in their own issues.
export type FieldMarker = {
  type: "lww";
  /**
   * Declared with `e.map(...)`, so a write carries a `map` envelope and
   * merges key by key instead of replacing the whole field.
   */
  map?: true;
};

/**
 * Granularity at which a concurrent write to the entity is surfaced as a
 * conflict. `"field"` scopes detection to a shared map position;
 * `"entity"` surfaces any touch of an entity with offline writes.
 */
export type ConflictScope = "field" | "entity";

/**
 * Client-side residency of an entity type. `"held"` keeps every row in
 * the replica; `"on-demand"` materializes a row only while it is open.
 * Purely a read-path concern — the wire payload is identical either way.
 */
export type Materialization = "held" | "on-demand";

/** Schema with a `.nullable()` chain producing `T | null`. */
export type NullableSchema<T extends TSchema> = T & {
  readonly nullable: () => ReturnType<typeof Type.Union<[T, ReturnType<typeof Type.Null>]>>;
};

/**
 * Type-level stamp identifying a field schema that went through
 * `.default(value)`. A symbol brand is needed because every TypeBox
 * schema accepts a `default` annotation in its option bag, so a plain
 * `default` key on the type cannot distinguish a declared default from
 * the builder's non-enumerable `.default()` method.
 */
declare const DEFAULT_BRAND: unique symbol;

/** A field schema carrying a declared default of `V`. */
export type DefaultedSchema<T extends TSchema, V = unknown> = T & {
  readonly [DEFAULT_BRAND]: V;
};

/**
 * Field builders are declared as interfaces extending their TypeBox
 * schema rather than as intersections: `SchemaOptions` declares
 * `default?: any` for the JSON Schema annotation, and an intersection
 * would leave `.default()` typed `any`. An interface member overrides
 * the inherited annotation slot, so the chain stays typed.
 */
export interface StringField extends TString {
  nullable(): TUnion<[TString, TNull]>;
  default(value: Static<TString>): DefaultedSchema<TString, Static<TString>>;
}

export interface NumberField extends TNumber {
  nullable(): TUnion<[TNumber, TNull]>;
  default(value: Static<TNumber>): DefaultedSchema<TNumber, Static<TNumber>>;
}

export interface IntegerField extends TInteger {
  nullable(): TUnion<[TInteger, TNull]>;
  default(value: Static<TInteger>): DefaultedSchema<TInteger, Static<TInteger>>;
}

export interface BooleanField extends TBoolean {
  nullable(): TUnion<[TBoolean, TNull]>;
  default(value: Static<TBoolean>): DefaultedSchema<TBoolean, Static<TBoolean>>;
}

/** A map field builder: `.default()` takes the map's projected value. */
export interface MapField<V extends TSchema> extends MapSchema<V> {
  nullable(): TUnion<[MapSchema<V>, TNull]>;
  default(value: Static<MapSchema<V>>): DefaultedSchema<MapSchema<V>, Static<MapSchema<V>>>;
}

/**
 * Stamp a plain JSON Schema `default` annotation onto a field schema.
 * The annotation is enumerable so `stableStringify` includes it in the
 * schema hash, and it is not a `Symbol` or closure so `Value.Check`
 * ignores it and `Type.Object` carries it through.
 *
 * Mutates and returns the schema: each `e.*()` builder allocates a
 * fresh schema, and mutating in place preserves non-enumerable markers
 * (the collaborative-text marker) that a spread would drop.
 */
const stampDefault = <T extends TSchema, V>(schema: T, value: V): DefaultedSchema<T, V> => {
  Object.defineProperty(schema, "default", {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return schema as DefaultedSchema<T, V>;
};

/**
 * True when `schema` carries a declared default. The builder's
 * non-enumerable `.default()` method is a function and does not count.
 */
export const hasDefault = (schema: TSchema): boolean => {
  const value = (schema as { default?: unknown }).default;
  return value !== undefined && typeof value !== "function";
};

/**
 * The field's declared default, or `undefined` when it has none. A
 * declared `undefined` default is indistinguishable from no default,
 * which is fine: absence has no value to resolve.
 */
export const readDefault = (schema: TSchema): unknown =>
  hasDefault(schema) ? (schema as { default?: unknown }).default : undefined;

/**
 * Marker stamped onto the union returned by `.nullable()` so
 * `defineEntity` can recognize the field came through the chain
 * even though the union itself doesn't carry the `.nullable`
 * method.
 */
const NULLABLE_MARKER = Symbol.for("@ebbjs/nullable");

const withNullable = <T extends TSchema>(schema: T): T => {
  const self = schema as T & { nullable: unknown; default: unknown };
  Object.defineProperty(self, "nullable", {
    value: () => {
      const union = Type.Union([schema, Type.Null()]);
      Object.defineProperty(union, NULLABLE_MARKER, { value: true, enumerable: false });
      return union;
    },
    enumerable: false,
  });
  Object.defineProperty(self, "default", {
    value: (value: Static<T>) => stampDefault(schema, value),
    enumerable: false,
    configurable: true,
    writable: true,
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
   * Name of the document entity backing the body. Defaults to a
   * per-field generated document entity. Set it to share a document
   * across fields or grant the body its own `<entity>.*` permissions
   * independently of the parent.
   */
  readonly entity?: E;
  /** Conflict granularity the body's document entity declares. Defaults to `"field"`. */
  readonly conflictScope?: ConflictScope;
}

declare const COLLABORATIVE_TEXT_BRAND: unique symbol;

/**
 * Marker-stamped schema returned by `e.collaborativeText()`. The
 * TypeBox schema is `Type.Never()` — the parent carries no wire value
 * — and the brand makes the field recognisable at the type level so
 * {@link WireFields} can hoist it out of the parent's shape. The
 * brand's type argument is the document entity name (`undefined` for a
 * per-field generated document).
 */
export type CollaborativeTextSchema<E extends string | undefined = string | undefined> = TNever & {
  readonly [COLLABORATIVE_TEXT_BRAND]: E;
  /**
   * Available so registration can reject it with a clear message: a
   * derived body has a seed policy, not a field default.
   */
  default(value: unknown): CollaborativeTextSchema<E>;
};

const COLLABORATIVE_TEXT_MARKER = Symbol.for("@ebbjs/collaborative-text");

/** Runtime payload stamped on a collaborative-text schema. */
interface CollaborativeTextMarker {
  readonly entity: string | undefined;
  readonly conflictScope: ConflictScope | undefined;
}

const readCollaborativeTextMarker = (schema: TSchema): CollaborativeTextMarker | undefined =>
  Object.getOwnPropertyDescriptor(schema, COLLABORATIVE_TEXT_MARKER)?.value as
    | CollaborativeTextMarker
    | undefined;

/** Last-writer-wins typed-field helpers. Each returns a TypeBox primitive. */
export const e = {
  string: (): StringField => withNullable(Type.String()) as StringField,
  number: (): NumberField => withNullable(Type.Number()) as NumberField,
  integer: (): IntegerField => withNullable(Type.Integer()) as IntegerField,
  boolean: (): BooleanField => withNullable(Type.Boolean()) as BooleanField,
  /**
   * A map field: a string-keyed object whose entries merge key by key
   * under the wire's recursive merge rule rather than replacing the
   * whole field.
   */
  map: <V extends TSchema>(value: V): MapField<V> =>
    withNullable(Type.Record(Type.String(), value) as MapSchema<V>) as MapField<V>,
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
      value: {
        entity: opts?.entity,
        conflictScope: opts?.conflictScope,
      } satisfies CollaborativeTextMarker,
      enumerable: false,
    });
    Object.defineProperty(schema, "default", {
      value: (value: unknown) => stampDefault(schema, value),
      enumerable: false,
      configurable: true,
      writable: true,
    });
    return schema as unknown as CollaborativeTextSchema<E>;
  },
} as const;

const isMapSchema = (schema: TSchema): boolean => {
  if ("patternProperties" in schema) return true;
  const anyOf = (schema as { anyOf?: readonly TSchema[] }).anyOf;
  return Array.isArray(anyOf) && anyOf.some(isMapSchema);
};

const deriveMarker = (schema: TSchema): FieldMarker =>
  isMapSchema(schema) ? { type: "lww", map: true } : { type: "lww" };

/**
 * True at the type level when a field declares a default. Keyed on the
 * `.default()` brand, not the annotation key: TypeBox's option bag
 * accepts `default?: any` on every schema.
 */
export type HasDefault<T extends TSchema> = [T] extends [{ readonly [DEFAULT_BRAND]: unknown }]
  ? true
  : false;

/**
 * The read shape of a field map: a defaulted field reads as `T`, a field
 * without one reads as `T | undefined`. `TOptional<T>` is TypeBox's
 * spelling of an optional property, so `Static<TObject<ShapeFields<...>>>`
 * yields exactly those read types.
 *
 * Absence is the truth for a non-defaulted field: any row can predate the
 * field's declaration. Declaring a default is the statement that absence
 * has a value.
 */
export type ShapeFields<TFields extends Record<string, TSchema>> = {
  [K in keyof TFields]: HasDefault<TFields[K]> extends true
    ? StripOptional<TFields[K]>
    : TOptional<StripOptional<TFields[K]>>;
};

/** The read shape is already optional-wrapped; re-applying it must not nest. */
type StripOptional<T extends TSchema> = T extends TOptional<infer S> ? S : T;

/**
 * The create-validation shape of a field map. `Value.Check` treats an
 * unwrapped property as required, so `create()` may omit a field exactly
 * when it has a default: the validation wrap is optional iff defaulted.
 *
 * This is the inverse of {@link ShapeFields}, which is why the two are
 * separate shapes rather than one type doing double duty.
 */
export type CreateShapeFields<TFields extends Record<string, TSchema>> = {
  [K in keyof TFields]: HasDefault<TFields[K]> extends true ? TOptional<TFields[K]> : TFields[K];
};

/**
 * The TypeBox object schema wrapping a field map. `EntityDef.shape` is the
 * read shape; field-value types flow through `Static<TObject<...>>`, or
 * `Static<typeof def["shape"]>` for explicit extraction.
 */
export type EntityShape<TFields extends Record<string, TSchema>> = ReturnType<
  typeof Type.Object<ShapeFields<TFields>>
>;

/** The create-validation counterpart of {@link EntityShape}. */
export type EntityCreateShape<TFields extends Record<string, TSchema>> = ReturnType<
  typeof Type.Object<CreateShapeFields<TFields>>
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
  /** Document entity name; `undefined` for a per-field generated document. */
  readonly entity: string | undefined;
  /** Conflict granularity declared on the field; `"field"` when omitted. */
  readonly conflictScope: ConflictScope;
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
   * Granularity at which concurrent writes to this entity surface as
   * conflicts. Defaults to `"field"`.
   */
  readonly conflictScope: ConflictScope;
  /**
   * Whether the replica holds every row of this type or materializes a
   * row only while it is open. Defaults to `"held"`.
   */
  readonly materialization: Materialization;
  /**
   * Read shape — drives value-shape typing and projection. Implicit
   * `Type.Object` wrapper over the *wire* fields; derived fields are
   * hoisted out. A non-defaulted field is optional here.
   */
  readonly shape: EntityShape<WireFields<TFields>>;
  /**
   * Create-validation shape: a defaulted field is optional (the default
   * fills it), a field without one is required. Only `Value.Check` for a
   * full `create()` payload reads this.
   */
  readonly createShape: EntityCreateShape<WireFields<TFields>>;
  /** Merge-semantics markers for the wire fields — derived fields are absent. */
  readonly fields: { [K in keyof WireFields<TFields>]: FieldMarker };
  /** Fields declared with `e.collaborativeText()`, awaiting expansion. */
  readonly derived: { [K in DerivedKeys<TFields>]: DerivedFieldDef };
}

/** Options accepted by `defineEntity`. */
export interface EntityOptions {
  /** Conflict granularity the entity declares. Defaults to `"field"`. */
  readonly conflictScope?: ConflictScope;
  /** Replica residency the entity declares. Defaults to `"held"`. */
  readonly materialization?: Materialization;
}

/**
 * Define an entity by name and field map. The result is frozen.
 * Throws {@link ReservedNameError} when the name is a system entity
 * or a generated document entity, or the field map declares the
 * injected `groups` accessor.
 */
export function defineEntity<TFields extends Record<string, TSchema>, TName extends string>(
  name: TName,
  fields: TFields,
  options: EntityOptions = {},
): EntityDef<TFields, TName> {
  assertEntityNameAvailable(name);
  assertFieldNamesAvailable(name, fields);
  return buildEntityDef(name, fields, options);
}

/** Raised when a derived (collaborative-text) field declares a default. */
export class DerivedFieldDefaultError extends Error {
  constructor(entityName: string, field: string) {
    super(
      `Field "${field}" on entity "${entityName}" is derived (e.collaborativeText()) ` +
        `and cannot declare a default; a derived body has a seed policy.`,
    );
    this.name = "DerivedFieldDefaultError";
  }
}

/**
 * Unchecked entity factory. `defineEntity` validates reserved names
 * first; the SDK's own system entities (`group`, `groupMember`,
 * `relationship`) build through here.
 */
export function buildEntityDef<TFields extends Record<string, TSchema>, TName extends string>(
  name: TName,
  fields: TFields,
  options: EntityOptions = {},
): EntityDef<TFields, TName> {
  const wireFields: Record<string, TSchema> = {};
  const derived: Record<string, DerivedFieldDef> = {};
  // A derived body inherits the entity's declared scope unless the
  // field sugar overrides it.
  const entityScope = options.conflictScope ?? "field";
  for (const [key, schema] of Object.entries(fields)) {
    const marker = readCollaborativeTextMarker(schema as TSchema);
    if (marker !== undefined) {
      if (hasDefault(schema as TSchema)) {
        throw new DerivedFieldDefaultError(name, key);
      }
      derived[key] = {
        kind: "collaborative-text",
        entity: marker.entity,
        conflictScope: marker.conflictScope ?? entityScope,
      };
      continue;
    }
    wireFields[key] = schema as TSchema;
  }

  const shapeFields = withReadOptional(wireFields);
  const createShapeFields = withCreateOptional(wireFields);

  const derivedFields = Object.fromEntries(
    Object.keys(wireFields).map((k) => [k, deriveMarker(wireFields[k] as TSchema)]),
  ) as { [K in keyof WireFields<TFields>]: FieldMarker };
  const derivedMarkers = derived as { [K in DerivedKeys<TFields>]: DerivedFieldDef };
  return Object.freeze({
    name,
    conflictScope: entityScope,
    materialization: options.materialization ?? "held",
    shape: Type.Object(shapeFields) as EntityShape<WireFields<TFields>>,
    createShape: Type.Object(createShapeFields) as EntityCreateShape<WireFields<TFields>>,
    fields: derivedFields,
    derived: derivedMarkers,
  });
}

/**
 * The read wrap: a field without a default is optional, so an absent value
 * reads as `T | undefined`. A defaulted field stays required — its value
 * always resolves.
 */
const withReadOptional = <TFields extends Record<string, TSchema>>(
  fields: TFields,
): Record<string, TSchema> => {
  const out: Record<string, TSchema> = {};
  for (const [key, schema] of Object.entries(fields)) {
    out[key] = hasDefault(schema)
      ? schema
      : Type.Optional(schema as Parameters<typeof Type.Optional>[0]);
  }
  return out;
};

/**
 * The create-validation wrap: a defaulted field is optional because the
 * default fills it, while a field without one is required.
 */
const withCreateOptional = <TFields extends Record<string, TSchema>>(
  fields: TFields,
): Record<string, TSchema> => {
  const out: Record<string, TSchema> = {};
  for (const [key, schema] of Object.entries(fields)) {
    out[key] = hasDefault(schema)
      ? Type.Optional(schema as Parameters<typeof Type.Optional>[0])
      : schema;
  }
  return out;
};

export type { TSchema };
