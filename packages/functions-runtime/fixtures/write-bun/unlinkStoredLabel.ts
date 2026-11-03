import type { Context } from "../../src/index.ts";

import { schema } from "./schema.ts";

export { schema };

interface Params {
  readonly todo_id: string;
  readonly label_id: string;
}

/**
 * Drops one target from a many-cardinality FK set that was stored before the
 * invocation, so the verb has to read the source row through `ctx.get`.
 */
export const unlinkStoredLabel = async (ctx: Context, params: Params) => {
  await ctx.unrelate("todo", params.todo_id, "labels", params.label_id);
  return { ok: true };
};
