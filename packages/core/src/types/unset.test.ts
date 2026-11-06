import { describe, expect, it } from "vitest";

import { isUnset, unset } from "./unset";

describe("unset", () => {
  it("is a frozen singleton", () => {
    expect(Object.isFrozen(unset)).toBe(true);
    expect(isUnset(unset)).toBe(true);
  });

  it("recognises the marker structurally, not by identity", () => {
    // A second copy of the package (or a structured clone) still identifies.
    expect(isUnset({ ...unset })).toBe(true);
  });

  it("never confuses data with the marker", () => {
    for (const value of [null, undefined, 0, false, "", {}, { unset: true }, [], "unset"]) {
      expect(isUnset(value)).toBe(false);
    }
  });
});
