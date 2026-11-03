/** Wire shapes for a write response: the per-Update refusals a server returns. */

import { Type, type Static } from "@sinclair/typebox";

/** Per-action rejection from `POST /sync/actions`. */
export const RejectionSchema = Type.Object({
  id: Type.String(),
  reason: Type.String(),
  details: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type Rejection = Static<typeof RejectionSchema>;

/** Response shape for `POST /sync/actions`. */
export interface WriteResponse {
  rejected: readonly Rejection[];
}
