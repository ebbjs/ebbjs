import type { Context } from "../../src/index.ts";

import { schema } from "./schema.ts";

export { schema };

interface Params {
  readonly todo_id: string;
  readonly label_id: string;
}

/**
 * Removes one edge that was stored before the invocation. The target names the
 * key, so nothing has to be read first.
 */
export const unlinkStoredLabel = async (ctx: Context, params: Params) => {
  await ctx.unrelate("todo", params.todo_id, "labels", params.label_id);
  return { ok: true };
};
