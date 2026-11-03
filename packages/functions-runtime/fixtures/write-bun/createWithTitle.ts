import type { Context } from "../../src/index.ts";

import { schema } from "./schema.ts";

export { schema };

interface Params {
  readonly group_id: string;
  readonly title: string;
}

/**
 * Creates one row whose id is fresh per invocation. A retry that is not
 * deduped therefore leaves a second row behind.
 */
export const createWithTitle = (ctx: Context, params: Params) => {
  const created = ctx.create("todo", { title: params.title }, { groups: [params.group_id] });
  return { id: created.id, title: params.title };
};
