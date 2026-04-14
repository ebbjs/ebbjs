import { describe, expect, it } from "vitest";
import { compare, isBefore, isAfter } from "./compare.js";
import { format, pack } from "./pack.js";

describe("compare", () => {
  it("returns -1 when a < b", () => {
    const a = format(pack(1000n, 0n));
    const b = format(pack(2000n, 0n));
    expect(compare(a, b)).toBe(-1);
  });

  it("returns 1 when a > b", () => {
    const a = format(pack(2000n, 0n));
    const b = format(pack(1000n, 0n));
    expect(compare(a, b)).toBe(1);
  });

  it("returns 0 when a === b", () => {
    const a = format(pack(1000n, 5n));
    const b = format(pack(1000n, 5n));
    expect(compare(a, b)).toBe(0);
  });

  it("compares by logical time first", () => {
    const a = format(pack(1000n, 100n));
    const b = format(pack(2000n, 0n));
    expect(compare(a, b)).toBe(-1);
  });

  it("compares by counter when logical time is equal", () => {
    const a = format(pack(1000n, 0n));
    const b = format(pack(1000n, 1n));
    expect(compare(a, b)).toBe(-1);
  });
});

describe("isBefore", () => {
  it("returns true when a < b", () => {
    const a = format(pack(1000n, 0n));
    const b = format(pack(2000n, 0n));
    expect(isBefore(a, b)).toBe(true);
  });

  it("returns false when a >= b", () => {
    const a = format(pack(2000n, 0n));
    const b = format(pack(1000n, 0n));
    expect(isBefore(a, b)).toBe(false);
  });
});

describe("isAfter", () => {
  it("returns true when a > b", () => {
    const a = format(pack(2000n, 0n));
    const b = format(pack(1000n, 0n));
    expect(isAfter(a, b)).toBe(true);
  });

  it("returns false when a <= b", () => {
    const a = format(pack(1000n, 0n));
    const b = format(pack(2000n, 0n));
    expect(isAfter(a, b)).toBe(false);
  });
});
