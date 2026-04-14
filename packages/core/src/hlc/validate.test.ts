import { describe, expect, it } from "vitest";
import { isValidHLC } from "./validate.js";

describe("isValidHLC", () => {
  it("returns true for valid positive decimal string", () => {
    expect(isValidHLC("123456789")).toBe(true);
    expect(isValidHLC("1")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isValidHLC("")).toBe(false);
  });

  it("returns false for non-string input", () => {
    expect(isValidHLC(null as any)).toBe(false);
    expect(isValidHLC(undefined as any)).toBe(false);
    expect(isValidHLC(123 as any)).toBe(false);
  });

  it("returns false for non-digit strings", () => {
    expect(isValidHLC("abc")).toBe(false);
    expect(isValidHLC("12a")).toBe(false);
    expect(isValidHLC("12.3")).toBe(false);
    expect(isValidHLC("-1")).toBe(false);
  });

  it("returns false for zero", () => {
    expect(isValidHLC("0")).toBe(false);
  });

  it("returns true for large numbers", () => {
    expect(isValidHLC("9999999999999999999")).toBe(true);
  });
});
