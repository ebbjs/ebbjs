/**
 * `defineModel` — pure factory returning a frozen model definition.
 *
 * `defineComponent(name, shape, options)` declares a named component with
 * its own policy. `defineModel(name, inputs)` accepts components and bare
 * field builders in one map; a bare builder normalises to an anonymous
 * component named `<model>/<field>`. The model's `shape` is derived from
 * its attached components and `components` records the declarations.
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  TSchema,
  TObject,
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

import { EBB_MODEL_NAME } from "@ebbjs/core";

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
 * Granularity at which a concurrent write is surfaced as a conflict.
 * `"field"` scopes detection to a shared map position; `"component"` holds
 * one component; `"entity"` surfaces any touch of an entity with offline
 * writes. A component declared `structural` opts out of detection entirely,
 * which is how the SDK's edge, membership, and grant rows behave.
 */
export type ConflictScope = "field" | "component" | "entity";

/**
 * Client-side residency of an entity type. `"held"` keeps every row in
 * the replica; `"on-demand"` materializes a row only while it is open.
 * Purely a read-path concern — the wire payload is identical either way.
 */
export type Materialization = "held" | "on-demand";

/**
 * How a component is loaded into the replica. `"eager"` keeps it held;
 * `"lazy"` loads it only once opened. Purely a read-path concern — the wire
 * payload is identical either way.
 */
export type Loading = "eager" | "lazy";

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
 * The key identifying a component declared `optional: true`. It serves as both
 * the runtime stamp and its type brand.
 *
 * The stamp sits on the component's *shape*, not on its declaration:
 * `ComponentFields` extracts shapes out of component declarations before the
 * model's read and create shapes are derived, so a brand on the declaration
 * would be erased before any of them see it.
 */
const ABSENT_BRAND: unique symbol = Symbol("ebbjs.schema.absentable");

/** A component shape declared `optional: true`: an entity may not carry it. */
export type AbsentableSchema<T extends TSchema> = T & {
  readonly [ABSENT_BRAND]: true;
};

/** True at the type level when a component shape was declared `optional: true`. */
export type IsAbsentable<T extends TSchema> = [T] extends [{ readonly [ABSENT_BRAND]: true }]
  ? true
  : false;

/**
 * Stamp a declared `optional: true` onto a component shape. Mutates in place
 * for the same reason {@link stampDefault} does: each `e.*()` builder allocates
 * a fresh schema, and a spread would drop the non-enumerable builder chain.
 * The stamp is a symbol, so `Value.Check`, the schema hash, and
 * `stableStringify` never see it.
 */
const stampAbsentable = <T extends TSchema>(schema: T): AbsentableSchema<T> => {
  Object.defineProperty(schema, ABSENT_BRAND, {
    value: true,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return schema as AbsentableSchema<T>;
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

/**
 * A nested-object field builder: one atomic value on the wire, so a write
 * replaces the whole object. `.default()` takes the whole object.
 */
export interface ObjectField<TFields extends Record<string, TSchema>> extends TObject<TFields> {
  default(
    value: Static<TObject<TFields>>,
  ): DefaultedSchema<TObject<TFields>, Static<TObject<TFields>>>;
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
  /**
   * A nested-object field: one atomic value whose properties are closed by
   * default. Declared exactly as authored — a nested property is optional
   * only when written as `Type.Optional(...)` — and replaced whole by a
   * write, so it travels together rather than merging per key.
   */
  object: <TFields extends Record<string, TSchema>>(fields: TFields): ObjectField<TFields> => {
    for (const [key, field] of Object.entries(fields)) {
      const mapPath = findNestedMap(field, key);
      if (mapPath !== undefined) throw new NestedMapError(mapPath);
    }
    const schema = Type.Object(fields, { additionalProperties: false });
    return withFieldChain(schema) as ObjectField<TFields>;
  },
} as const;

export const isMapSchema = (schema: TSchema): boolean => "patternProperties" in schema;

/** Raised when a map is nested inside an `e.object` property. */
export class NestedMapError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `e.object() cannot contain a map at "${path}": a map nested inside an atomic value ` +
        `loses its per-key merge. Declare the map at the top level with e.map (a key space ` +
        `that merges per key), or use e.object for a value that travels together.`,
    );
    this.name = "NestedMapError";
    this.path = path;
  }
}

/**
 * The path of the first map nested under `schema`, or `undefined`. A map's
 * own entries are not searched: the map itself is the refusal.
 */
const findNestedMap = (schema: TSchema, path: string): string | undefined => {
  if (isMapSchema(schema)) return path;
  const candidate = schema as {
    properties?: Record<string, TSchema>;
    items?: TSchema | readonly TSchema[];
    anyOf?: readonly TSchema[];
    oneOf?: readonly TSchema[];
  };
  if (candidate.properties !== undefined && typeof candidate.properties === "object") {
    for (const [key, property] of Object.entries(candidate.properties)) {
      const found = findNestedMap(property, `${path}.${key}`);
      if (found !== undefined) return found;
    }
  }
  if (Array.isArray(candidate.items)) {
    for (const [index, item] of candidate.items.entries()) {
      const found = findNestedMap(item, `${path}[${index}]`);
      if (found !== undefined) return found;
    }
  } else if (candidate.items !== undefined && typeof candidate.items === "object") {
    const found = findNestedMap(candidate.items as TSchema, `${path}[]`);
    if (found !== undefined) return found;
  }
  for (const branches of [candidate.anyOf, candidate.oneOf]) {
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const found = findNestedMap(branch, path);
      if (found !== undefined) return found;
    }
  }
  return undefined;
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
 * unwrapped property as required, so `create()` may omit a component exactly
 * when the declaration says absence is allowed: it carries a default or is
 * declared `optional: true`.
 *
 * This is the inverse of {@link ShapeFields}, which is why the two are
 * separate shapes rather than one type doing double duty.
 */
export type CreateShapeFields<TFields extends Record<string, TSchema>> = {
  [K in keyof TFields]: HasDefault<TFields[K]> extends true
    ? TOptional<TFields[K]>
    : IsAbsentable<TFields[K]> extends true
      ? TOptional<TFields[K]>
      : TFields[K];
};

/**
 * The TypeBox object schema wrapping a field map. `ModelDef.shape` is the
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

/** A component shape: either a field builder/schema or a map of them. */
export type ComponentShapeInput = TSchema | Record<string, TSchema>;

/** The read shape a component declaration carries. */
export type ComponentShapeOf<T> = T extends TSchema
  ? T
  : T extends Record<string, TSchema>
    ? EntityShape<T>
    : never;

/** Policy declared on one component. Defaults match an anonymous field. */
export interface ComponentOptions {
  /** Whether an entity may exist without this component. Defaults to `false`. */
  readonly optional?: boolean;
  /** Replica loading. Defaults to `"eager"`, which keeps the component held. */
  readonly loading?: Loading;
  /** Conflict granularity. Defaults to the model's `conflictScope`. */
  readonly conflictScope?: ConflictScope;
  /** Whether this component participates in existence indexes. Defaults to `false`. */
  readonly indexed?: boolean;
  /**
   * Structural components converge last-writer-wins and are never surfaced as
   * conflicts. The SDK declares its edge, membership, and grant components
   * this way. Defaults to `false`.
   */
  readonly structural?: boolean;
  /** Opt in to `<model>/<component>.<verb>` permissions. Defaults to the model. */
  readonly permission?: "own";
  /**
   * The entity whose group set this component's write resolves against.
   * `"self"` is the row itself; a string names a field of the component's
   * value, whose entity carries the groups. Platform-only: a user component
   * that could name a group could mint its own delivery scope.
   */
  readonly scope?: "self" | string;
  /** Component version for read migrations. Defaults to `1`. */
  readonly version?: number;
}

/** A frozen component declaration. A bare field builder is one, anonymously. */
export interface ComponentDef<TShape extends TSchema = TSchema, TName extends string = string> {
  readonly kind: "component";
  /** Full declaration name, `<model>/<leaf>`. */
  readonly name: TName;
  readonly shape: TShape;
  readonly createShape: TSchema;
  readonly marker: FieldMarker;
  readonly optional: boolean;
  readonly loading: Loading;
  /** Declared granularity; `undefined` inherits the model's default. */
  readonly conflictScope: ConflictScope | undefined;
  readonly indexed: boolean;
  readonly structural: boolean;
  readonly permission: "own" | undefined;
  /**
   * Scope owner: `"self"`, a field name, or `undefined` to inherit the
   * entity's membership. Only `ebb/*` components may declare one.
   */
  readonly scope: string | undefined;
  readonly version: number;
}

/** Anything `defineModel` can attach under a field name. */
export type ComponentInput = TSchema | ComponentDef;

/** One input's field schema: a component contributes its shape, a builder itself. */
type ComponentSchema<T> = T extends { readonly kind: "component"; readonly shape: infer S }
  ? S extends TSchema
    ? S
    : never
  : T extends TSchema
    ? T
    : never;

/** The field schemas contributed by a model's component inputs. */
export type ComponentFields<TInputs extends Record<string, ComponentInput>> = {
  [K in keyof TInputs]: ComponentSchema<TInputs[K]>;
};

/** A model's component declarations, keyed by the field they attach under. */
export type ModelComponents<TFields extends Record<string, TSchema>> = {
  [K in keyof ComponentFields<TFields>]: ComponentDef<ComponentFields<TFields>[K], string>;
};

/** Raised when a component name is not `<model>/<leaf>`. */
export class InvalidComponentNameError extends Error {
  readonly componentName: string;

  constructor(componentName: string) {
    super(
      `Component name "${componentName}" must be "<model>/<leaf>", with exactly one "/" ` +
        `and non-empty segments.`,
    );
    this.name = "InvalidComponentNameError";
    this.componentName = componentName;
  }
}

const COMPONENT_NAME_PATTERN = /^[^/]+\/[^/]+$/;

/** True when `name` is shaped `<model>/<leaf>`. */
export const isComponentName = (name: string): boolean => COMPONENT_NAME_PATTERN.test(name);

/** Reject a component name that is not `<model>/<leaf>`-shaped. */
export const assertComponentName = (name: string): void => {
  if (!isComponentName(name)) throw new InvalidComponentNameError(name);
};

/**
 * Raised when a declared component is attached under a field key that is not
 * its name's leaf. The wire names one component `<model>/<field>`, so the two
 * must agree or a write would address a field the declaration does not name.
 */
export class ComponentLeafMismatchError extends Error {
  readonly modelName: string;
  readonly componentName: string;
  readonly key: string;

  constructor(modelName: string, componentName: string, key: string) {
    super(
      `Model "${modelName}" attaches component "${componentName}" under key "${key}". ` +
        `A component's name leaf must equal the key it is attached under: ` +
        `declare it as "${modelName}/${key}".`,
    );
    this.name = "ComponentLeafMismatchError";
    this.modelName = modelName;
    this.componentName = componentName;
    this.key = key;
  }
}

/** Raised when a component declares a version that is not an integer >= 1. */
export class InvalidComponentVersionError extends Error {
  readonly componentName: string;
  readonly version: unknown;

  constructor(componentName: string, version: unknown) {
    super(
      `Component "${componentName}" declares version ${String(version)}: a component version is ` +
        `an integer >= 1, and defaults to 1 when omitted.`,
    );
    this.name = "InvalidComponentVersionError";
    this.componentName = componentName;
    this.version = version;
  }
}

/**
 * Raised when a component declares a scope owner it may not have, or one that
 * names nothing. Only the platform's own components declare a scope.
 */
export class ComponentScopeError extends Error {
  readonly componentName: string;
  readonly scope: unknown;

  constructor(componentName: string, scope: unknown, message: string) {
    super(message);
    this.name = "ComponentScopeError";
    this.componentName = componentName;
    this.scope = scope;
  }
}

/** A field-shaped scope: one non-empty segment, since a scope names no path. */
const SCOPE_FIELD_PATTERN = /^[^/\s]+$/;

/** The property names of an object shape, or `undefined` for any other shape. */
const shapeFieldNames = (shape: TSchema): readonly string[] | undefined => {
  const properties = (shape as { properties?: Record<string, unknown> }).properties;
  if (properties === undefined || typeof properties !== "object") return undefined;
  return Object.keys(properties);
};

/**
 * Reject a scope owner a component may not declare. A scope naming a group
 * decides where a write is delivered, so only the platform may hold one; and a
 * scope naming no field of the value would silently resolve no group set.
 */
const assertComponentScope = (name: string, scope: string, shape: TSchema): void => {
  if (!name.startsWith(`${EBB_MODEL_NAME}/`)) {
    throw new ComponentScopeError(
      name,
      scope,
      `Component "${name}" declares a scope owner, but only the \`${EBB_MODEL_NAME}/\` ` +
        `namespace may: a component that can name a group could mint its own delivery scope.`,
    );
  }
  if (scope !== "self" && !SCOPE_FIELD_PATTERN.test(scope)) {
    throw new ComponentScopeError(
      name,
      scope,
      `Component "${name}" declares scope ${JSON.stringify(scope)}: a scope is "self" (the ` +
        `row's own id) or the name of one field of the component's value.`,
    );
  }
  if (scope === "self") return;

  const fields = shapeFieldNames(shape);
  if (fields === undefined || fields.includes(scope)) return;
  throw new ComponentScopeError(
    name,
    scope,
    `Component "${name}" declares scope "${scope}", which is not one of its fields ` +
      `(${fields.map((field) => `"${field}"`).join(", ")}). A scope naming no field resolves ` +
      `no group set.`,
  );
};

/** True when a value is a component declaration rather than a bare schema. */
const isComponentDef = (value: ComponentInput): value is ComponentDef =>
  typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "component";

/**
 * A plain field map is not a TypeBox schema. Detect a schema structurally
 * so a component may be declared as `{ title: e.string() }` or as one
 * builder such as `e.object(...)`.
 */
const isSchemaLike = (value: ComponentShapeInput): value is TSchema => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const type = candidate["type"];
  if (typeof type === "string" || Array.isArray(type)) return true;
  return ["anyOf", "oneOf", "allOf", "const", "enum", "$ref", "not"].some(
    (key) => key in candidate,
  );
};

const normalizeComponentShape = (shape: ComponentShapeInput): TSchema => {
  if (isSchemaLike(shape)) return shape;
  return Type.Object(withReadOptional(shape as Record<string, TSchema>));
};

const normalizeComponentCreateShape = (shape: ComponentShapeInput): TSchema => {
  if (isSchemaLike(shape)) return shape;
  return Type.Object(withCreateOptional(shape as Record<string, TSchema>));
};

/**
 * Raised when an `optional` component also declares a default. `optional`
 * says absence is absence; `.default()` says absence has a value. Projection
 * resolves a default only when the component is not optional, so the pair
 * would otherwise declare a value no reader ever sees.
 */
export class OptionalDefaultConflictError extends Error {
  readonly componentName: string;
  /** Field carrying the default; `undefined` when the component is one value. */
  readonly defaultedField: string | undefined;

  constructor(componentName: string, defaultedField: string | undefined) {
    super(
      `Component "${componentName}" declares optional: true together with a default on ` +
        `${defaultedField === undefined ? "its value" : `field "${defaultedField}"`}. An ` +
        `optional component's absence is absence, so it never resolves a default: remove ` +
        `the default, or remove optional: true.`,
    );
    this.name = "OptionalDefaultConflictError";
    this.componentName = componentName;
    this.defaultedField = defaultedField;
  }
}

/**
 * The property directly under a component shape that carries a declared
 * default, or `undefined` when none does. A bare builder carries its own
 * default; a field-map component's shape is an object schema, so its fields'
 * defaults sit one level down.
 */
const defaultedFieldOf = (shape: TSchema): string | undefined => {
  const properties = (shape as { properties?: Record<string, TSchema> }).properties;
  if (properties === undefined || typeof properties !== "object") return undefined;
  return Object.entries(properties).find(([, property]) => hasDefault(property))?.[0];
};

/** Build a frozen component declaration. Shared by `defineComponent` and anonymous fields. */
export function buildComponentDef<TShape extends TSchema, TName extends string>(
  name: TName,
  shape: TShape,
  options: ComponentOptions = {},
  createShape: TSchema = shape,
): ComponentDef<TShape, TName> {
  if (options.optional === true) {
    if (hasDefault(shape)) throw new OptionalDefaultConflictError(name, undefined);
    const field = defaultedFieldOf(shape);
    if (field !== undefined) throw new OptionalDefaultConflictError(name, field);
  }

  const version = options.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new InvalidComponentVersionError(name, options.version);
  }

  if (options.scope !== undefined) assertComponentScope(name, options.scope, shape);

  return Object.freeze({
    kind: "component",
    name,
    shape,
    createShape,
    marker: deriveMarker(shape),
    optional: options.optional ?? false,
    loading: options.loading ?? "eager",
    conflictScope: options.conflictScope,
    indexed: options.indexed ?? false,
    structural: options.structural ?? false,
    permission: options.permission,
    scope: options.scope,
    version,
  });
}

/**
 * The shape type a component declaration carries. `optional: true` brands the
 * shape so the model's create shape can read the fact back out.
 */
type DeclaredComponentShape<
  TShape extends ComponentShapeInput,
  TOptions extends ComponentOptions,
> = TOptions extends { readonly optional: true }
  ? AbsentableSchema<ComponentShapeOf<TShape>>
  : ComponentShapeOf<TShape>;

/**
 * Declare a component under `<model>/<leaf>`. The result is frozen and
 * carries the policy later slices read: existence, loading, conflict
 * scope, indexing, permission, scope owner, and version.
 *
 * Throws {@link OptionalDefaultConflictError} when `optional: true` is
 * combined with a declared `.default()`, and {@link ComponentScopeError}
 * when a `scope` is declared outside the `ebb/` namespace or names no field.
 */
export function defineComponent<
  const TShape extends ComponentShapeInput,
  const TName extends string,
  const TOptions extends ComponentOptions = ComponentOptions,
>(
  name: TName,
  shape: TShape,
  options: TOptions = {} as TOptions,
): ComponentDef<DeclaredComponentShape<TShape, TOptions>, TName> {
  assertComponentName(name);
  const normalized = normalizeComponentShape(shape) as ComponentShapeOf<TShape>;
  const stamped = options.optional === true ? stampAbsentable(normalized) : normalized;
  return buildComponentDef(
    name,
    stamped,
    options,
    normalizeComponentCreateShape(shape),
  ) as ComponentDef<DeclaredComponentShape<TShape, TOptions>, TName>;
}

/**
 * Passive entity definition value. The runtime registry consumes it.
 *
 * `TName` carries the literal name passed to `defineModel` so
 * downstream type-level walkers (e.g. the per-accessor row type) can
 * match a relationship's `source` / `target` back to a model. The
 * default `string` keeps erased usages (`ModelDef<...>`, the runtime
 * registry) compiling without a name argument.
 */
export interface ModelDef<TFields extends Record<string, TSchema>, TName extends string = string> {
  readonly name: TName;
  /**
   * Default conflict granularity for this model's components. A component
   * may declare its own. Defaults to `"field"`.
   */
  readonly conflictScope: ConflictScope;
  /**
   * Default replica residency for this model's components. A component may
   * declare its own. Defaults to `"held"`.
   */
  readonly materialization: Materialization;
  /**
   * Read shape — drives value-shape typing and projection. Implicit
   * `Type.Object` wrapper over the field map. A non-defaulted field is
   * optional here.
   */
  readonly shape: EntityShape<TFields>;
  /**
   * Create-validation shape: a component is optional here exactly when
   * `create()` may omit it — it has a default or is declared optional. Any
   * other component is required. Only `Value.Check` for a full `create()`
   * payload reads this.
   */
  readonly createShape: EntityCreateShape<TFields>;
  /** Component declarations keyed by the field they attach under. */
  readonly components: ModelComponents<TFields>;
  /** Merge-semantics markers for the declared fields. */
  readonly markers: { [K in keyof TFields]: FieldMarker };
}

/** Options accepted by `defineModel`. */
export interface ModelOptions {
  /** Default conflict granularity for the model's components. Defaults to `"field"`. */
  readonly conflictScope?: ConflictScope;
  /** Default replica residency for the model's components. Defaults to `"held"`. */
  readonly materialization?: Materialization;
}

/**
 * Define a model by name and component map. The result is frozen.
 * Throws {@link ReservedNameError} when the name is a system entity,
 * or the component map declares the injected `groups` accessor.
 */
export function defineModel<TInputs extends Record<string, ComponentInput>, TName extends string>(
  name: TName,
  components: TInputs,
  options: ModelOptions = {},
): ModelDef<ComponentFields<TInputs>, TName> {
  assertEntityNameAvailable(name);
  assertFieldNamesAvailable(name, components);
  return buildModelDef(name, components, options);
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
    properties?: Record<string, TSchema>;
    items?: TSchema | readonly TSchema[];
  };
  if (candidate.type === "null") return true;
  if (Array.isArray(candidate.type) && candidate.type.includes("null")) return true;
  if (candidate.const === null) return true;
  if (Array.isArray(candidate.enum) && candidate.enum.includes(null)) return true;
  for (const branches of [candidate.anyOf, candidate.oneOf]) {
    if (Array.isArray(branches) && branches.some(admitsNull)) return true;
  }
  // An object is a value on the wire, so a nullable property is the same
  // mistake as a nullable field. A map's entries are positions rather than
  // parts of one value, so `patternProperties` is deliberately not searched:
  // a run tombstone inside a map stays spellable.
  if (candidate.properties !== undefined && typeof candidate.properties === "object") {
    if (Object.values(candidate.properties).some(admitsNull)) return true;
  }
  if (Array.isArray(candidate.items)) {
    if (candidate.items.some(admitsNull)) return true;
  } else if (candidate.items !== undefined && typeof candidate.items === "object") {
    if (admitsNull(candidate.items as TSchema)) return true;
  }
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
 * Unchecked model factory. `defineModel` validates reserved names first;
 * the SDK's own system models (`group`, `groupMember`, `relationship`)
 * build through here.
 */
export function buildModelDef<TInputs extends Record<string, ComponentInput>, TName extends string>(
  name: TName,
  inputs: TInputs,
  options: ModelOptions = {},
): ModelDef<ComponentFields<TInputs>, TName> {
  const readFields: Record<string, TSchema> = {};
  const createFields: Record<string, TSchema> = {};
  const components: Record<string, ComponentDef> = {};
  const modelScope = options.conflictScope ?? "field";
  const modelMaterialization = options.materialization ?? "held";
  for (const [key, input] of Object.entries(inputs)) {
    // Optionality changes when a component may be absent, not what it may
    // hold: a null-admitting shape is refused whether or not it is optional.
    if (admitsNull(isComponentDef(input) ? input.shape : (input as TSchema))) {
      throw new NullFieldError(name, key);
    }

    if (isComponentDef(input) && input.name.split("/")[1] !== key) {
      throw new ComponentLeafMismatchError(name, input.name, key);
    }

    const component = isComponentDef(input)
      ? input
      : buildComponentDef(`${name}/${key}`, input as TSchema, {
          loading: modelMaterialization === "on-demand" ? "lazy" : "eager",
          conflictScope: modelScope,
        });
    readFields[key] = component.shape;
    createFields[key] = createFieldSchema(component);
    components[key] = component;
  }

  const markers = Object.fromEntries(
    Object.entries(components).map(([key, component]) => [key, component.marker]),
  ) as { [K in keyof ComponentFields<TInputs>]: FieldMarker };
  return Object.freeze({
    name,
    conflictScope: modelScope,
    materialization: modelMaterialization,
    shape: Type.Object(withReadOptional(readFields)) as EntityShape<ComponentFields<TInputs>>,
    createShape: Type.Object(createFields) as EntityCreateShape<ComponentFields<TInputs>>,
    components: Object.freeze(components) as ModelComponents<ComponentFields<TInputs>>,
    markers: Object.freeze(markers),
  });
}

/**
 * The read wrap: a field without a default is optional, so an absent value
 * reads as `T | undefined`. A defaulted field stays required — its value
 * always resolves.
 */
function withReadOptional<TFields extends Record<string, TSchema>>(
  fields: TFields,
): Record<string, TSchema> {
  const out: Record<string, TSchema> = {};
  for (const [key, schema] of Object.entries(fields)) {
    out[key] = hasDefault(schema)
      ? schema
      : Type.Optional(schema as Parameters<typeof Type.Optional>[0]);
  }
  return out;
}

/**
 * The create-validation schema of one component: optional exactly when the
 * component may be omitted from a payload, i.e. when it has a default or is
 * itself optional.
 */
const createFieldSchema = (component: ComponentDef): TSchema =>
  component.optional || hasDefault(component.createShape)
    ? Type.Optional(component.createShape as Parameters<typeof Type.Optional>[0])
    : component.createShape;

/**
 * The create-validation wrap for a declared field map: a defaulted property
 * is optional because the default fills it, while a property without one is
 * required. Component optionality is applied one level up, in
 * {@link createFieldSchema}.
 */
function withCreateOptional<TFields extends Record<string, TSchema>>(
  fields: TFields,
): Record<string, TSchema> {
  const out: Record<string, TSchema> = {};
  for (const [key, schema] of Object.entries(fields)) {
    out[key] = hasDefault(schema)
      ? Type.Optional(schema as Parameters<typeof Type.Optional>[0])
      : schema;
  }
  return out;
}

export type { TSchema };
