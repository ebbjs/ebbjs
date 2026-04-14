import { Type } from "@sinclair/typebox";
import { Static } from "@sinclair/typebox";

export const NanoIdSchema = Type.String({
  pattern: "^[a-z]+_[a-zA-Z0-9]+$",
});

export type NanoId = Static<typeof NanoIdSchema>;
