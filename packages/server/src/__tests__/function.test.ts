import { describe, expect, it } from "vitest";
import { defineFunction } from "../function";
import { p } from "../schema";

describe("defineFunction", () => {
  it("returns the schema, params, handler, and defaults", () => {
    const schema = { version: 1 };
    const params = p.object({ count: p.number() });
    const handler = () => 1;

    const def = defineFunction(schema, params, handler);

    expect(def.schema).toBe(schema);
    expect(def.params).toBe(params);
    expect(def.handler).toBe(handler);
    expect(def.access).toBe("granted");
    expect(def.output).toBeUndefined();
    expect(def.timeoutMs).toBeUndefined();
    expect(def.memoryMb).toBeUndefined();
    expect("~input" in def).toBe(false);
    expect("~output" in def).toBe(false);
  });

  it("carries options through", () => {
    const output = p.object({ count: p.number() });
    const def = defineFunction(
      {},
      p.object({ count: p.number() }),
      (_ctx, params) => ({ count: params.count + 1 }),
      { access: "authenticated", timeoutMs: 500, memoryMb: 128, output },
    );

    expect(def.access).toBe("authenticated");
    expect(def.timeoutMs).toBe(500);
    expect(def.memoryMb).toBe(128);
    expect(def.output).toBe(output);
  });

  it("defines a function with no params", () => {
    const handler = () => 42;
    const def = defineFunction({}, handler);

    expect(def.params).toBeUndefined();
    expect(def.handler).toBe(handler);
    expect(def.access).toBe("granted");
    expect(def.handler({} as never)).toBe(42);
  });

  it("does not validate at definition time", () => {
    const def = defineFunction({}, p.object({ count: p.number() }), (_ctx, params) => params.count);
    // Validation is the server's and runner's job; the definition only holds
    // the pieces.
    expect(def.params?.["~standard"].validate({ count: "not a number" })).toHaveProperty("issues");
  });
});
