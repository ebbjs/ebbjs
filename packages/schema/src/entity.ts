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
import { Value } from "@sinclair/typebox/value";
import type {
  TSchema,
  TOptional,
  TArray,
  TRecord,
  TString,
  TNumber,
  TInteger,
  TBoolean,
  TLiteral,
  TUnion,
  Static,
} from "@sinclair/typebox/type";

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
  default(value: Static<TString>): DefaultedSchema<TString, Static<TString>>;
}

export interface NumberField extends TNumber {
  default(value: Static<TNumber>): DefaultedSchema<TNumber, Static<TNumber>>;
}

export interface IntegerField extends TInteger {
  default(value: Static<TInteger>): DefaultedSchema<TInteger, Static<TInteger>>;
}

export interface BooleanField extends TBoolean {
  default(value: Static<TBoolean>): DefaultedSchema<TBoolean, Static<TBoolean>>;
}

/** An array field builder: `.default()` takes the array's value. */
export interface ArrayField<V extends TSchema> extends TArray<V> {
  default(value: Static<TArray<V>>): DefaultedSchema<TArray<V>, Static<TArray<V>>>;
}

/** A map field builder: `.default()` takes the map's projected value. */
export interface MapField<V extends TSchema> extends MapSchema<V> {
  default(value: Static<MapSchema<V>>): DefaultedSchema<MapSchema<V>, Static<MapSchema<V>>>;
}

/** A value a closed-set field admits: the primitives TypeBox can make a literal of. */
export type LiteralValue = string | number | boolean;

/**
 * A closed-set field builder. The field reads as the union of its
 * members, so `.default()` takes one of them and a `switch` over the
 * value can be exhaustive.
 */
export interface EnumField<V extends LiteralValue = LiteralValue> extends TUnion<TLiteral<V>[]> {
  default(value: V): DefaultedSchema<TUnion<TLiteral<V>[]>, V>;
}

/**
 * Stamp a plain JSON Schema `default` annotation onto a field schema.
 * The annotation is enumerable so `stableStringify` includes it in the
 * schema hash, and it is not a `Symbol` or closure so `Value.Check`
 * ignores it and `Type.Object` carries it through.
 *
 * Mutates and returns the schema: each `e.*()` builder allocates a
 * fresh schema, and mutating in place preserves the non-enumerable
 * `.default()` builder that a spread would drop.
 */
const stampDefault = <T extends TSchema, V>(schema: T, value: V): DefaultedSchema<T, V> => {
  // A default is shared by every row that resolves it, and it is part of the
  // schema hash, so it is cloned once and frozen: a caller mutating a
  // projected default must not rewrite the annotation or another row.
  const stored = deepFreeze(structuredClone(value));
  Object.defineProperty(schema, "default", {
    value: stored,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return schema as DefaultedSchema<T, V>;
};

/** Freeze a JSON default at every level. Defaults are acyclic JSON values. */
const deepFreeze = <V>(value: V): V => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
};

/**
 * True when `schema` carries a declared default. The builder's
 * non-enumerable `.default()` method is a function and does not count.
 */
export const hasDefault = (schema: TSchema | undefined): boolean => {
  const value = (schema as { default?: unknown } | undefined)?.default;
  return value !== undefined && typeof value !== "function";
};

/**
 * The field's declared default, or `undefined` when it has none. A
 * declared `undefined` default is indistinguishable from no default,
 * which is fine: absence has no value to resolve.
 */
export const readDefault = (schema: TSchema | undefined): unknown =>
  hasDefault(schema) ? (schema as { default?: unknown }).default : undefined;

const withFieldChain = <T extends TSchema>(schema: T): T => {
  const self = schema as T & { default: unknown };
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

/** Last-writer-wins typed-field helpers. Each carries the `.default()` chain. */
export const e = {
  string: (): StringField => withFieldChain(Type.String()) as StringField,
  number: (): NumberField => withFieldChain(Type.Number()) as NumberField,
  integer: (): IntegerField => withFieldChain(Type.Integer()) as IntegerField,
  boolean: (): BooleanField => withFieldChain(Type.Boolean()) as BooleanField,
  /**
   * A closed-set field: the value must be one of `values`. Reads as the
   * members' literal union, so a typo or a stale client's value fails
   * local validation like a wrong type does. Strings are the app case;
   * numbers are stored as numbers and ordered numerically.
   */
  enum: <const V extends readonly LiteralValue[]>(values: V): EnumField<V[number]> => {
    if (values.length === 0) {
      throw new Error("e.enum() requires at least one value: a closed set cannot be empty.");
    }
    const union = Type.Union(values.map((value) => Type.Literal(value)));
    return withFieldChain(union) as EnumField<V[number]>;
  },
  /** A list field: an array of `value`. On the wire it is an ordinary leaf. */
  array: <V extends TSchema>(value: V): ArrayField<V> =>
    withFieldChain(Type.Array(value)) as ArrayField<V>,
  /**
   * A map field: a string-keyed object whose entries merge key by key
   * under the wire's recursive merge rule rather than replacing the
   * whole field.
   */
  map: <V extends TSchema>(value: V): MapField<V> =>
    withFieldChain(Type.Record(Type.String(), value) as MapSchema<V>) as MapField<V>,
} as const;

const isMapSchema = (schema: TSchema): boolean => "patternProperties" in schema;

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
   * `Type.Object` wrapper over the field map. A non-defaulted field is
   * optional here.
   */
  readonly shape: EntityShape<TFields>;
  /**
   * Create-validation shape: a defaulted field is optional (the default
   * fills it), a field without one is required. Only `Value.Check` for a
   * full `create()` payload reads this.
   */
  readonly createShape: EntityCreateShape<TFields>;
  /** Merge-semantics markers for the declared fields. */
  readonly fields: { [K in keyof TFields]: FieldMarker };
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
 * Throws {@link ReservedNameError} when the name is a system entity,
 * or the field map declares the injected `groups` accessor.
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

/** Raised when a field schema admits `null`. */
export class NullFieldError extends Error {
  constructor(entityName: string, field: string) {
    super(
      `Field "${field}" on entity "${entityName}" admits Null. Absence is the only ` +
        `spelling: declare a default for a read-time value, or clear with \`unset\`.`,
    );
    this.name = "NullFieldError";
  }
}

/**
 * True when a field schema admits `null` anywhere in its type: a `null`
 * type, a union branch, a `const`, or an enum entry. The wire's
 * `{ value: null }` is a tombstone, not a stored null, so no field
 * schema may admit one.
 */
export const admitsNull = (schema: TSchema): boolean => {
  const candidate = schema as {
    type?: unknown;
    anyOf?: readonly TSchema[];
    oneOf?: readonly TSchema[];
    const?: unknown;
    enum?: readonly unknown[];
  };
  if (candidate.type === "null") return true;
  if (Array.isArray(candidate.type) && candidate.type.includes("null")) return true;
  if (candidate.const === null) return true;
  if (Array.isArray(candidate.enum) && candidate.enum.includes(null)) return true;
  for (const branches of [candidate.anyOf, candidate.oneOf]) {
    if (Array.isArray(branches) && branches.some(admitsNull)) return true;
  }
  // Deliberately not recursive: a map entry's null is a run tombstone in the
  // collaborative-text document schema, and this rule is about the field's
  // own value, not the entries inside it.
  try {
    // Covers `Type.Any()` / `Type.Unknown()` / an empty schema, which accept
    // `null` without naming it structurally.
    return Value.Check(schema, null);
  } catch {
    // TypeBox cannot check an exotic schema; the structural checks above are
    // the whole answer.
    return false;
  }
};

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
  const markers = {} as { [K in keyof TFields]: FieldMarker };
  for (const [key, schema] of Object.entries(fields)) {
    if (admitsNull(schema as TSchema)) {
      throw new NullFieldError(name, key);
    }
    markers[key as keyof TFields] = deriveMarker(schema as TSchema);
  }
  return Object.freeze({
    name,
    conflictScope: options.conflictScope ?? "field",
    materialization: options.materialization ?? "held",
    shape: Type.Object(withReadOptional(fields)) as EntityShape<TFields>,
    createShape: Type.Object(withCreateOptional(fields)) as EntityCreateShape<TFields>,
    fields: markers,
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
