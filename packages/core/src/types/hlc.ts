import { Type } from "@sinclair/typebox";
import { Static } from "@sinclair/typebox";

export const HLCTimestampSchema = Type.String();

export type HLCTimestamp = Static<typeof HLCTimestampSchema>;
