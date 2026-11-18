/**
 * The committed row a read returns.
 *
 * It is a wire shape, and it is the one shape two surfaces share: `GET
 * /entities/:id` answers with it and a handler's `ctx.get` resolves to it, so
 * it lives beside the other response shape (`WriteResponse`) instead of in the
 * client that happens to parse one of them.
 */

import { Type, type Static } from "@sinclair/typebox";

/** Response shape for `GET /entities/:id`. */
export const EntityResponseSchema = Type.Object({
  id: Type.String(),
  /** The committed model. */
  model: Type.String(),
  data: Type.Object({ fields: Type.Record(Type.String(), Type.Unknown()) }),
  created_hlc: Type.Union([Type.Number(), Type.String()]),
  updated_hlc: Type.Union([Type.Number(), Type.String()]),
  deleted_hlc: Type.Union([Type.Number(), Type.String(), Type.Null()]),
  last_gsn: Type.Number(),
});
export type EntityResponse = Static<typeof EntityResponseSchema>;
