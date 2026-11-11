import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";

import { NanoIdSchema } from "./nanoid";

describe("NanoIdSchema", () => {
  it("accepts <prefix>_<suffix> ids", () => {
    for (const id of ["a_test", "abc_def123", "a_ABCDEF123456", "group_abc"]) {
      expect(Value.Check(NanoIdSchema, id)).toBe(true);
    }
  });

  it("rejects anything but <prefix>_<suffix>", () => {
    for (const id of ["", "abc", "_test", "test_", "a_"]) {
      expect(Value.Check(NanoIdSchema, id)).toBe(false);
    }
  });
});
