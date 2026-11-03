import type { Context } from "../../src/index.ts";

import { schema } from "./schema.ts";

export { schema };

interface Params {
  readonly group_id: string;
  readonly id: string;
}

/**
 * Buffers a create and then throws before returning. The runner flushes only
 * a handler that returned, so nothing may be submitted. The row id is a
 * parameter so the test can look for it afterwards.
 */
export const createThenThrow = (ctx: Context, params: Params): never => {
  ctx.create("todo", { title: "never stored" }, { groups: [params.group_id], id: params.id });
  throw new Error("boom after create");
};
