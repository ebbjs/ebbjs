import type { Context } from "../../src/index.ts";

import { schema } from "./schema.ts";

export { schema };

interface Params {
  readonly group_id: string;
  readonly project_id: string;
}

/**
 * Links a one-cardinality edge and removes it again before returning. The
 * edge's key is the source row, the accessor, and the target, so removing it
 * names the key rather than a row.
 */
export const linkThenUnlink = async (ctx: Context, params: Params) => {
  const todo = ctx.create("todo", { title: "linked" }, { groups: [params.group_id] });
  ctx.relate("todo", todo.id, "project", params.project_id);
  await ctx.unrelate("todo", todo.id, "project");
  return { id: todo.id };
};
