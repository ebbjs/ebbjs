import type { Context } from "../../src/index.ts";

import { schema } from "./schema.ts";

export { schema };

interface Params {
  readonly todo_id: string;
  readonly title: string;
}

/**
 * Patches a row that existed before the invocation and reads it back through
 * the overlay, so the returned view is what the handler saw mid-Action.
 */
export const patchStoredTodo = async (ctx: Context, params: Params) => {
  ctx.update("todo", params.todo_id, { title: params.title });
  const view = await ctx.get(params.todo_id);
  return { view };
};
