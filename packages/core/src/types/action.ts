import { Type } from "@sinclair/typebox";
import { Static } from "@sinclair/typebox";
import { NanoIdSchema } from "./nanoid";
import { HLCTimestampSchema, type HLCTimestamp } from "./hlc";

export const SubjectTypeSchema = Type.Union([
  Type.Literal("group"),
  Type.Literal("groupMember"),
  Type.Literal("relationship"),
  Type.String({ minLength: 1 }),
]);
export type SubjectType = Static<typeof SubjectTypeSchema>;

export const UpdateMethodSchema = Type.Union([
  Type.Literal("put"),
  Type.Literal("patch"),
  Type.Literal("delete"),
]);
export type UpdateMethod = Static<typeof UpdateMethodSchema>;

// A field value is either a leaf carrying a scalar/opaque `value` merged
// by last-writer-wins, or a `map` of nested field values merged key by
// key. The `map` key is the discriminant, so a map is self-describing on
// the wire and the server needs no schema to merge it.
export const FieldValueSchema = Type.Recursive((Self) =>
  Type.Union([
    Type.Object({
      value: Type.Unknown(),
      update_id: NanoIdSchema,
      hlc: Type.Optional(HLCTimestampSchema),
    }),
    // The leaf members are declared optional-never on the map branch so
    // reading `value` / `update_id` / `hlc` on the union stays total: the
    // map branch contributes `undefined`, matching what it holds at
    // runtime. They are never emitted on a map.
    Type.Object({
      map: Type.Record(Type.String(), Self),
      value: Type.Optional(Type.Never()),
      update_id: Type.Optional(Type.Never()),
      hlc: Type.Optional(Type.Never()),
    }),
  ]),
);
export type FieldValue = Static<typeof FieldValueSchema>;

/** A leaf field value: the object carrying `value`. */
export interface FieldLeaf {
  readonly value: unknown;
  readonly update_id: string;
  readonly hlc?: HLCTimestamp;
}

/** A map field value: nested field values merged key by key. */
export interface FieldMap {
  readonly map: Record<string, FieldValue>;
}

/** Narrow a field value to its map variant. */
export const isFieldMap = (field: FieldValue): field is FieldMap => "map" in field;

/** Narrow a field value to its leaf variant. */
export const isFieldLeaf = (field: FieldValue): field is FieldLeaf => !isFieldMap(field);

// An Update's `data` is a `{ fields: Record<string, FieldValue> }`
// envelope. The same shape ships on the wire for every entity type
// (user, groupMember, relationship), so the materializer and the
// wire validator share one code path.
const FieldsEnvelopeSchema = Type.Object({
  fields: Type.Record(Type.String(), FieldValueSchema),
});

export const PutDataSchema = FieldsEnvelopeSchema;
export type PutData = Static<typeof PutDataSchema>;

export const PatchDataSchema = FieldsEnvelopeSchema;
export type PatchData = Static<typeof PatchDataSchema>;

const BaseUpdateFields = Type.Object({
  subject_id: NanoIdSchema,
  subject_type: Type.String({ minLength: 1 }),
  method: UpdateMethodSchema,
});

export const UpdateInputSchema = Type.Intersect([
  BaseUpdateFields,
  Type.Object({
    id: Type.Optional(NanoIdSchema),
    data: Type.Union([Type.Null(), FieldsEnvelopeSchema]),
  }),
]);
export type UpdateInput = Static<typeof UpdateInputSchema>;

export const UpdateSchema = Type.Intersect([
  BaseUpdateFields,
  Type.Object({
    id: NanoIdSchema,
    subject_type: SubjectTypeSchema,
    data: Type.Union([PutDataSchema, PatchDataSchema, Type.Null()]),
  }),
]);
export type Update = Static<typeof UpdateSchema>;

export const ActionSchema = Type.Object({
  id: NanoIdSchema,
  actor_id: NanoIdSchema,
  hlc: HLCTimestampSchema,
  gsn: Type.Number({ minimum: 0 }),
  updates: Type.Array(UpdateSchema),
});
export type Action = Static<typeof ActionSchema>;
