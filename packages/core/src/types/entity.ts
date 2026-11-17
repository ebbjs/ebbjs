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
  /** The committed model: the model the row's create named. */
  model: Type.String(),
  data: EntityDataSchema,
  /**
   * Whether this replica has seen the row's create (or a base that carries
   * it). Only a create sets it: a component write that arrives before its
   * create materializes an `exists: false` placeholder, and that placeholder
   * is a backfill candidate. The row's presence in the store is its row
   * existence; this flag is the separate, local fact of whether the base has
   * been seen.
   */
  exists: Type.Boolean(),
  /**
   * The create's HLC, the row's creation time. `null` only while `exists` is
   * false. Time only, never a predicate.
   */
  created_hlc: Type.Union([HLCTimestampSchema, Type.Null()]),
  updated_hlc: HLCTimestampSchema,
  deleted_hlc: Type.Union([HLCTimestampSchema, Type.Null()]),
  last_gsn: Type.Number(),
});
export type Entity = Static<typeof EntitySchema>;
