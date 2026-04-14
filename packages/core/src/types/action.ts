import { Type } from "@sinclair/typebox";
import { Static } from "@sinclair/typebox";
import { NanoIdSchema } from "./nanoid";
import { HLCTimestampSchema } from "./hlc";

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

export const FieldValueSchema = Type.Object({
  value: Type.Unknown(),
  update_id: NanoIdSchema,
  hlc: Type.Optional(HLCTimestampSchema),
});
export type FieldValue = Static<typeof FieldValueSchema>;

export const PutDataSchema = Type.Record(Type.String(), FieldValueSchema);
export type PutData = Static<typeof PutDataSchema>;

export const PatchDataSchema = Type.Record(Type.String(), FieldValueSchema);
export type PatchData = Static<typeof PatchDataSchema>;

export const UpdateSchema = Type.Object({
  id: NanoIdSchema,
  subject_id: NanoIdSchema,
  subject_type: SubjectTypeSchema,
  method: UpdateMethodSchema,
  data: Type.Union([PutDataSchema, PatchDataSchema, Type.Null()]),
});
export type Update = Static<typeof UpdateSchema>;

export const ActionSchema = Type.Object({
  id: NanoIdSchema,
  actor_id: NanoIdSchema,
  hlc: HLCTimestampSchema,
  gsn: Type.Number(),
  updates: Type.Array(UpdateSchema),
});
export type Action = Static<typeof ActionSchema>;
