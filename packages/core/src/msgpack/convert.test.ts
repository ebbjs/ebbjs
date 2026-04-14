import { describe, expect, it } from "vitest";
import { hlcToInteger, integerToHLC, convertHlcToInteger, convertIntegerToHlc } from "./convert";

describe("hlcToInteger", () => {
  it("converts HLC string to integer", () => {
    expect(hlcToInteger("123456789012")).toBe(123456789012);
    expect(hlcToInteger("0")).toBe(0);
  });
});

describe("integerToHLC", () => {
  it("converts integer to HLC string", () => {
    expect(integerToHLC(123456789012)).toBe("123456789012");
    expect(integerToHLC(0)).toBe("0");
  });
});

describe("convertHlcToInteger", () => {
  it("leaves short strings untouched", () => {
    expect(convertHlcToInteger("12345")).toBe("12345");
  });

  it("converts long HLC strings to integers in objects", () => {
    expect(convertHlcToInteger({ hlc: "1234567890123" })).toEqual({ hlc: 1234567890123 });
  });

  it("converts HLC strings in nested objects", () => {
    const input = {
      action: {
        hlc: "1234567890123",
        actor_id: "a_test",
      },
    };
    expect(convertHlcToInteger(input)).toEqual({
      action: { hlc: 1234567890123, actor_id: "a_test" },
    });
  });

  it("converts HLC strings in arrays", () => {
    const input = ["1234567890123", "9876543210987"];
    expect(convertHlcToInteger(input)).toEqual([1234567890123, 9876543210987]);
  });

  it("converts HLC strings in objects within arrays", () => {
    const input = [{ hlc: "1234567890123" }, { hlc: "9876543210987" }];
    expect(convertHlcToInteger(input)).toEqual([{ hlc: 1234567890123 }, { hlc: 9876543210987 }]);
  });

  it("leaves numbers and other types untouched", () => {
    expect(convertHlcToInteger(42)).toBe(42);
    expect(convertHlcToInteger(null)).toBe(null);
    expect(convertHlcToInteger({ name: "test" })).toEqual({ name: "test" });
  });
});

describe("convertIntegerToHlc", () => {
  it("leaves small integers untouched", () => {
    expect(convertIntegerToHlc(42)).toBe(42);
    expect(convertIntegerToHlc(1_000_000_000)).toBe(1_000_000_000);
  });

  it("converts large integers above threshold to HLC strings", () => {
    expect(convertIntegerToHlc(1_000_000_000_001)).toBe("1000000000001");
    expect(convertIntegerToHlc(9_999_999_999_999)).toBe("9999999999999");
  });

  it("converts large integers in objects", () => {
    expect(convertIntegerToHlc({ hlc: 1_000_000_000_001 })).toEqual({ hlc: "1000000000001" });
  });

  it("converts large integers in nested objects", () => {
    const input = {
      action: { hlc: 5_000_000_000_000, actor_id: "a_test" },
    };
    expect(convertIntegerToHlc(input)).toEqual({
      action: { hlc: "5000000000000", actor_id: "a_test" },
    });
  });

  it("converts large integers in arrays", () => {
    const input = [1_000_000_000_001, 2_000_000_000_002];
    expect(convertIntegerToHlc(input)).toEqual(["1000000000001", "2000000000002"]);
  });

  it("leaves strings untouched", () => {
    expect(convertIntegerToHlc("already a string")).toBe("already a string");
  });

  it("leaves small integers in arrays and objects", () => {
    expect(convertIntegerToHlc([100, 200])).toEqual([100, 200]);
    expect(convertIntegerToHlc({ count: 42 })).toEqual({ count: 42 });
  });
});

describe("roundtrip convert", () => {
  it("convertHlcToInteger then convertIntegerToHlc restores values above threshold", () => {
    const original = { hlc: "1234567890123" };
    const converted = convertHlcToInteger(original);
    const restored = convertIntegerToHlc(converted);
    expect(restored).toEqual(original);
  });

  it("convertIntegerToHlc then convertHlcToInteger restores original integers", () => {
    const original = { hlc: 5_000_000_000_000 };
    const converted = convertIntegerToHlc(original);
    const restored = convertHlcToInteger(converted);
    expect(restored).toEqual(original);
  });
});
