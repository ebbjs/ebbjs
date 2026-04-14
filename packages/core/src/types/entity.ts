import { Type } from "@sinclair/typebox";
import { Static } from "@sinclair/typebox";
import { NanoIdSchema } from "./nanoid";
import { HLCTimestampSchema } from "./hlc";
import { FieldValueSchema } from "./action";

export const EntityDataSchema = Type.Object({
  fields: Type.Record(Type.String(), FieldValueSchema),
});
export type EntityData = Static<typeof EntityDataSchema>;

export const EntitySchema = Type.Object({
  id: NanoIdSchema,
  type: Type.String(),
  data: EntityDataSchema,
  created_hlc: HLCTimestampSchema,
  updated_hlc: HLCTimestampSchema,
  deleted_hlc: Type.Union([HLCTimestampSchema, Type.Null()]),
  last_gsn: Type.Number(),
});
export type Entity = Static<typeof EntitySchema>;
