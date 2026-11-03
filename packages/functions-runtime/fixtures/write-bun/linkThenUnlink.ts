import type { Context } from "../../src/index.ts";

import { schema } from "./schema.ts";

export { schema };

interface Params {
  readonly group_id: string;
  readonly project_id: string;
}

/**
 * Links a one-cardinality edge and removes it again before returning. The
 * runtime resolves the edge it created from its own buffer, so no committed
 * relationship row is needed to name it.
 */
export const linkThenUnlink = async (ctx: Context, params: Params) => {
  const todo = ctx.create("todo", { title: "linked" }, { groups: [params.group_id] });
  ctx.relate("todo", todo.id, "project", params.project_id);
  await ctx.unrelate("todo", todo.id, "project");
  return { id: todo.id };
};
