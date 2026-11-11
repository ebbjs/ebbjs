import { describe, expect, it } from "vitest";
import { hlcToInteger, integerToHLC, convertHlcToInteger, convertIntegerToHlc } from "./convert";

describe("hlcToInteger", () => {
  it("converts an HLC that fits a double to a number", () => {
    expect(hlcToInteger("123456789012")).toBe(123456789012);
    expect(hlcToInteger("0")).toBe(0);
  });

  it("leaves an HLC over MAX_SAFE_INTEGER as the string it is", () => {
    // A packed HLC (`ms << 16`) is always this large; narrowing it would
    // silently change its value.
    expect(hlcToInteger("112134507724800000")).toBe("112134507724800000");
  });
});

describe("integerToHLC", () => {
  it("converts an integer to its decimal string", () => {
    expect(integerToHLC(123456789012)).toBe("123456789012");
    expect(integerToHLC(0)).toBe("0");
  });
});

describe("convertHlcToInteger", () => {
  it("leaves strings too short to be an HLC untouched", () => {
    expect(convertHlcToInteger("12345")).toBe("12345");
  });

  it("converts HLC strings found in objects", () => {
    expect(convertHlcToInteger({ hlc: "1234567890123" })).toEqual({ hlc: 1234567890123 });
  });

  it("recurses through objects nested in arrays", () => {
    const input = [{ hlc: "1234567890123" }, { hlc: "9876543210987" }];
    expect(convertHlcToInteger(input)).toEqual([{ hlc: 1234567890123 }, { hlc: 9876543210987 }]);
  });

  it("converts HLC strings inside recursive map field values", () => {
    const input = {
      fields: {
        content: {
          map: {
            a: { value: 1, update_id: "u_a", hlc: "1234567890123" },
            b: { map: { c: { value: 2, update_id: "u_c", hlc: "9876543210987" } } },
          },
        },
      },
    };

    expect(convertHlcToInteger(input)).toEqual({
      fields: {
        content: {
          map: {
            a: { value: 1, update_id: "u_a", hlc: 1234567890123 },
            b: { map: { c: { value: 2, update_id: "u_c", hlc: 9876543210987 } } },
          },
        },
      },
    });
  });

  it("leaves non-string values untouched", () => {
    expect(convertHlcToInteger(42)).toBe(42);
    expect(convertHlcToInteger(null)).toBe(null);
    expect(convertHlcToInteger({ name: "test" })).toEqual({ name: "test" });
  });
});

describe("convertIntegerToHlc", () => {
  it("leaves integers at or below the threshold untouched", () => {
    expect(convertIntegerToHlc(42)).toBe(42);
    expect(convertIntegerToHlc(1_000_000_000)).toBe(1_000_000_000);
  });

  it("converts integers above the threshold to HLC strings", () => {
    expect(convertIntegerToHlc(1_000_000_000_001)).toBe("1000000000001");
    expect(convertIntegerToHlc(9_999_999_999_999)).toBe("9999999999999");
  });

  it("converts large integers found in objects and arrays", () => {
    expect(convertIntegerToHlc({ action: { hlc: 5_000_000_000_000, actor_id: "a_test" } })).toEqual(
      { action: { hlc: "5000000000000", actor_id: "a_test" } },
    );
    expect(convertIntegerToHlc([1_000_000_000_001, 2_000_000_000_002])).toEqual([
      "1000000000001",
      "2000000000002",
    ]);
  });

  it("leaves strings and small integers untouched", () => {
    expect(convertIntegerToHlc("already a string")).toBe("already a string");
    expect(convertIntegerToHlc({ count: 42 })).toEqual({ count: 42 });
  });
});

describe("roundtrip convert", () => {
  it("restores the value it was given, in either direction", () => {
    const asString = { hlc: "1234567890123" };
    expect(convertIntegerToHlc(convertHlcToInteger(asString))).toEqual(asString);

    const asNumber = { hlc: 1234567890123 };
    expect(convertHlcToInteger(convertIntegerToHlc(asNumber))).toEqual(asNumber);
  });
});
