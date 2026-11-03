import type { Context } from "../../src/index.ts";

import { schema } from "./schema.ts";

export { schema };

interface Params {
  readonly group_id: string;
}

/**
 * Buffers four verbs — two creates, a patch, and a one-cardinality link — so
 * the invocation can prove they leave as one Action. The linked project is
 * created here too, so the fixture needs no seeded rows beyond membership.
 */
export const createTwoAndPatch = (ctx: Context, params: Params) => {
  const todo = ctx.create("todo", { title: "first" }, { groups: [params.group_id] });
  const project = ctx.create("project", { name: "second" }, { groups: [params.group_id] });
  ctx.update("todo", todo.id, { done: true });
  ctx.relate("todo", todo.id, "project", project.id);
  return { ids: [todo.id, project.id] };
};
