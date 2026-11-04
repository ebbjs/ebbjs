import { describe, expectTypeOf, it } from "vitest";

import { defineConfig } from "../config";
import type { EbbConfig } from "../config";

describe("defineConfig types", () => {
  it("accepts the documented keys and returns the config type", () => {
    const config = defineConfig({
      url: "https://ebb.example.com",
      token: "deploy-token",
      actor: "a_admin",
      headers: { cookie: "session=abc" },
      functions: { dir: "functions", typesOut: "src/ebb-functions.generated.ts" },
    });

    expectTypeOf(config).toEqualTypeOf<EbbConfig>();
  });

  it("accepts an empty config", () => {
    expectTypeOf(defineConfig({})).toEqualTypeOf<EbbConfig>();
  });

  it("rejects unknown keys and wrong value types", () => {
    // @ts-expect-error `tokens` is not a config key
    defineConfig({ tokens: "nope" });
    // @ts-expect-error `url` is a string
    defineConfig({ url: 4000 });
    // @ts-expect-error `headers` is a string map
    defineConfig({ headers: { cookie: 1 } });
    // @ts-expect-error `functions` is an object
    defineConfig({ functions: "functions" });
    // @ts-expect-error `functions.typesOut` is a string
    defineConfig({ functions: { typesOut: 1 } });
  });
});
