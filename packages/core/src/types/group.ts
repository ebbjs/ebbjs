import { Type } from "@sinclair/typebox";
import { Static } from "@sinclair/typebox";
import { NanoIdSchema } from "./nanoid";

export const GroupSchema = Type.Object({
  id: NanoIdSchema,
  type: Type.Literal("group"),
  data: Type.Object({
    name: Type.String(),
    /** App scope: a group is in scope for an app iff its entry is `true`. */
    apps: Type.Optional(Type.Record(Type.String(), Type.Boolean())),
  }),
});
export type Group = Static<typeof GroupSchema>;
