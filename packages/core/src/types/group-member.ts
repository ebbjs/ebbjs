import { Type } from "@sinclair/typebox";
import { Static } from "@sinclair/typebox";
import { NanoIdSchema } from "./nanoid";

export const GroupMemberSchema = Type.Object({
  id: NanoIdSchema,
  type: Type.Literal("groupMember"),
  data: Type.Object({
    group_id: NanoIdSchema,
    actor_id: NanoIdSchema,
    permissions: Type.Array(Type.String()),
  }),
});
export type GroupMember = Static<typeof GroupMemberSchema>;
