import { Type } from "@sinclair/typebox";
import { Static } from "@sinclair/typebox";
import { NanoIdSchema } from "./nanoid";

export const RelationshipSchema = Type.Object({
  id: NanoIdSchema,
  type: Type.Literal("relationship"),
  data: Type.Object({
    source_id: NanoIdSchema,
    target_id: NanoIdSchema,
    relationship_type: Type.String(),
  }),
});
export type Relationship = Static<typeof RelationshipSchema>;
