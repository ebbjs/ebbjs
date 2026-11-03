import type { Context } from "../../src/index.ts";

import { schema } from "./schema.ts";

export { schema };

interface Params {
  readonly todo_id: string;
}

/**
 * Patches a row this actor may not update. The write passes the runtime's
 * local checks and only the server's authorizer can refuse it, which is what
 * makes the rejection comparable with `POST /sync/actions`.
 */
export const patchForeign = (ctx: Context, params: Params) => {
  ctx.update("todo", params.todo_id, { title: "overwritten" });
  return { patched: params.todo_id };
};
