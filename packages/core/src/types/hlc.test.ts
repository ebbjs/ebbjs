import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";

import { HLCTimestampSchema } from "./hlc";

describe("HLCTimestampSchema", () => {
  it("accepts a non-empty decimal string", () => {
    for (const ts of ["123456789", "0", "9999999999999"]) {
      expect(Value.Check(HLCTimestampSchema, ts)).toBe(true);
    }
  });

  it("rejects an empty string", () => {
    expect(Value.Check(HLCTimestampSchema, "")).toBe(false);
  });
});
