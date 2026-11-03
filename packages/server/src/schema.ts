import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * A params or output schema: validatable by the runner through the Standard
 * Schema interface, and convertible to the draft-7 JSON Schema the RPC
 * boundary ships to the server.
 *
 * Schemas validate the shape as given. They never transform input or fill in
 * defaults — normalization belongs to the handler, and the client type is the
 * validated shape.
 */
export type FunctionSchema<T> = StandardSchemaV1<T> & {
  /** Draft-7 JSON Schema used by the RPC boundary. */
  toJSONSchema(): Record<string, unknown>;
};

/** The value a schema describes. */
export type InferSchema<S> = S extends FunctionSchema<infer T> ? T : never;

export type LiteralValue = string | number | boolean;

export type OptionalFunctionSchema<T> = FunctionSchema<T> & {
  readonly "~optional": true;
};

const typeboxBySchema = new WeakMap<object, TSchema>();

function typeboxOf<T>(schema: FunctionSchema<T>): TSchema {
  return typeboxBySchema.get(schema) ?? Type.Unsafe(schema.toJSONSchema());
}

function jsonSchemaOf(typebox: TSchema): Record<string, unknown> {
  // TypeBox schemas are JSON Schema plus symbol-keyed metadata. A JSON
  // round-trip drops the symbols and leaves exactly the uploadable document.
  return JSON.parse(JSON.stringify(typebox)) as Record<string, unknown>;
}

function pathOf(jsonPath: string): PropertyKey[] {
  if (jsonPath === "") return [];
  return jsonPath
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .map((segment) => (/^(?:0|[1-9]\d*)$/.test(segment) ? Number(segment) : segment));
}

function issuesOf(typebox: TSchema, value: unknown): StandardSchemaV1.Issue[] {
  return [...Value.Errors(typebox, value)].map((error) => {
    const path = pathOf(error.path);
    return path.length === 0 ? { message: error.message } : { message: error.message, path };
  });
}

function createSchema<T>(typebox: TSchema): FunctionSchema<T> {
  const schema: FunctionSchema<T> = {
    "~standard": {
      version: 1,
      vendor: "ebb",
      validate: (value: unknown): StandardSchemaV1.Result<T> => {
        if (Value.Check(typebox, value)) return { value: value as T };
        return { issues: issuesOf(typebox, value) };
      },
    },
    toJSONSchema: () => jsonSchemaOf(typebox),
  };
  typeboxBySchema.set(schema, typebox);
  return schema;
}

type RequiredKeys<P> = {
  [K in keyof P]: P[K] extends { readonly "~optional": true } ? never : K;
}[keyof P];

type OptionalKeys<P> = Exclude<keyof P, RequiredKeys<P>>;

type Simplify<T> = { [K in keyof T]: T[K] };

/** The object shape inferred from a `p.object` property map. */
export type ObjectShape<P> = Simplify<
  { [K in RequiredKeys<P>]: InferSchema<P[K]> } & {
    [K in OptionalKeys<P>]?: InferSchema<P[K]>;
  }
>;

function object<P extends Record<string, FunctionSchema<any>>>(
  properties: P,
): FunctionSchema<ObjectShape<P>> {
  const shape: Record<string, TSchema> = {};
  for (const [key, property] of Object.entries(properties)) {
    shape[key] = typeboxOf(property);
  }
  return createSchema<ObjectShape<P>>(Type.Object(shape));
}

function string(): FunctionSchema<string> {
  return createSchema<string>(Type.String());
}

function number(): FunctionSchema<number> {
  return createSchema<number>(Type.Number());
}

function boolean(): FunctionSchema<boolean> {
  return createSchema<boolean>(Type.Boolean());
}

function array<T>(item: FunctionSchema<T>): FunctionSchema<T[]> {
  return createSchema<T[]>(Type.Array(typeboxOf(item)));
}

/**
 * Marks a property optional in the object that contains it. The marker is a
 * property of the parent, as in JSON Schema; the schema alone still rejects
 * `undefined`.
 */
function optional<T>(schema: FunctionSchema<T>): OptionalFunctionSchema<T> {
  const typebox = Type.Optional(typeboxOf(schema));
  return Object.assign(createSchema<T>(typebox), { "~optional": true as const });
}

function nullable<T>(schema: FunctionSchema<T>): FunctionSchema<T | null> {
  return createSchema<T | null>(Type.Union([typeboxOf(schema), Type.Null()]));
}

function literal<const V extends LiteralValue[]>(...values: V): FunctionSchema<V[number]> {
  const typebox =
    values.length === 1
      ? Type.Literal(values[0])
      : Type.Union(values.map((value) => Type.Literal(value)));
  return createSchema<V[number]>(typebox);
}

function union<S extends readonly FunctionSchema<any>[]>(
  schemas: S,
): FunctionSchema<InferSchema<S[number]>> {
  return createSchema<InferSchema<S[number]>>(
    Type.Union(schemas.map((schema) => typeboxOf(schema))),
  );
}

function record<T>(values: FunctionSchema<T>): FunctionSchema<Record<string, T>> {
  return createSchema<Record<string, T>>(Type.Record(Type.String(), typeboxOf(values)));
}

/**
 * Schema builder for function params and outputs.
 *
 * ```ts
 * const params = p.object({
 *   documentId: p.string(),
 *   limit: p.optional(p.number()),
 * });
 * ```
 */
export const p = {
  object,
  string,
  number,
  boolean,
  array,
  optional,
  nullable,
  literal,
  union,
  record,
};
