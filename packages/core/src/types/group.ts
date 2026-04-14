import { Type } from "@sinclair/typebox";
import { Static } from "@sinclair/typebox";
import { NanoIdSchema } from "./nanoid";

export const GroupSchema = Type.Object({
  id: NanoIdSchema,
  type: Type.Literal("group"),
  data: Type.Object({
    name: Type.String(),
  }),
});
export type Group = Static<typeof GroupSchema>;
