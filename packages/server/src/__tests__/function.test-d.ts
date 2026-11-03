import { describe, expectTypeOf, it } from "vitest";
import { defineFunction } from "../function";
import { p } from "../schema";
import type { FunctionDef } from "../function";
import type { FunctionSchema } from "../schema";
import type { Context } from "../context";

describe("defineFunction types", () => {
  it("flows params into the handler", () => {
    const def = defineFunction(
      { tables: {} },
      p.object({
        documentId: p.string(),
        limit: p.optional(p.number()),
        tags: p.array(p.string()),
      }),
      (ctx, params) => {
        expectTypeOf(ctx).toEqualTypeOf<Context<{ tables: {} }>>();
        expectTypeOf(params.documentId).toEqualTypeOf<string>();
        expectTypeOf(params.limit).toEqualTypeOf<number | undefined>();
        expectTypeOf(params.tags).toEqualTypeOf<string[]>();
        return `${params.documentId}:${params.tags.length}`;
      },
    );

    expectTypeOf(def).toEqualTypeOf<
      FunctionDef<{ tables: {} }, { documentId: string; limit?: number; tags: string[] }, string>
    >();
    expectTypeOf(def.handler).returns.toEqualTypeOf<string | Promise<string>>();
    expectTypeOf(def["~output"]).toEqualTypeOf<string | undefined>();
  });

  it("infers the output from an async handler", () => {
    const def = defineFunction({}, p.object({ count: p.number() }), async (_ctx, params) => {
      return { count: params.count + 1 };
    });

    expectTypeOf(def).toEqualTypeOf<FunctionDef<{}, { count: number }, { count: number }>>();
    expectTypeOf(def.handler).returns.toEqualTypeOf<
      { count: number } | Promise<{ count: number }>
    >();
    expectTypeOf(def["~output"]).toEqualTypeOf<{ count: number } | undefined>();
  });

  it("accepts an output schema matching the handler's return", () => {
    defineFunction({}, p.object({ name: p.string() }), (_ctx, params) => params.name.length, {
      output: p.number(),
    });
    defineFunction(
      {},
      p.object({ name: p.string() }),
      (_ctx, params) => ({ length: params.name.length }),
      { output: p.object({ length: p.number() }) },
    );
  });

  it("types a no-params definition as void params", () => {
    const def = defineFunction({}, () => 42);

    expectTypeOf(def.params).toEqualTypeOf<FunctionSchema<void> | undefined>();
    expectTypeOf(def).toEqualTypeOf<FunctionDef<{}, void, number>>();
  });

  it("rejects a handler whose params do not match the schema", () => {
    // @ts-expect-error `count` is a number in the schema, not a string
    defineFunction(
      {},
      p.object({ count: p.number() }),
      (_ctx, params: { count: string }) => params.count,
    );
  });

  it("rejects an output schema that does not match the handler", () => {
    // @ts-expect-error the handler returns a string, the output schema describes a number
    defineFunction({}, p.object({}), () => "ok", { output: p.number() });
  });

  it("rejects calling the handler with wrong params", () => {
    const def = defineFunction({}, p.object({ count: p.number() }), (_ctx, params) => params.count);

    // @ts-expect-error `count` is a number
    def.handler({} as Context, { count: "one" });
  });
});
