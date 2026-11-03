import type { Context } from "../../src/index.ts";

import { schema } from "./schema.ts";

export { schema };

interface Params {
  readonly group_id: string;
  readonly title: string;
}

/**
 * Creates a row and reads it back before returning, so the result carries the
 * overlay view the handler saw and the committed row can be compared with it.
 */
export const createAndRead = async (ctx: Context, params: Params) => {
  const created = ctx.create("todo", { title: params.title }, { groups: [params.group_id] });
  const overlay = await ctx.get(created.id);
  return { id: created.id, overlay };
};
