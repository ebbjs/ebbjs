import { describe, expect, it } from "vitest";

import { canonicalKey, structuralEqual } from ".";

describe("structuralEqual", () => {
  it("compares scalars by identity", () => {
    expect(structuralEqual(1, 1)).toBe(true);
    expect(structuralEqual("a", "a")).toBe(true);
    expect(structuralEqual(null, null)).toBe(true);
    expect(structuralEqual(1, "1")).toBe(false);
    expect(structuralEqual(null, undefined)).toBe(false);
    expect(structuralEqual(undefined, undefined)).toBe(true);
  });

  it("compares arrays element-wise", () => {
    expect(structuralEqual([1, [2, { a: 3 }]], [1, [2, { a: 3 }]])).toBe(true);
    expect(structuralEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(structuralEqual([1, 2], [2, 1])).toBe(false);
    expect(structuralEqual([], {})).toBe(false);
  });

  it("compares objects by key set regardless of order", () => {
    expect(structuralEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(structuralEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(structuralEqual({ a: 1 }, { b: 1 })).toBe(false);
  });

  it("treats nested absent values as present keys", () => {
    expect(structuralEqual({ a: undefined }, { a: undefined })).toBe(true);
    expect(structuralEqual({ a: undefined }, {})).toBe(false);
  });
});

describe("canonicalKey", () => {
  it("sorts object keys at every level and keeps array order", () => {
    expect(canonicalKey({ b: 1, a: { d: [2, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,1]},"b":1}',
    );
    expect(canonicalKey([2, 1])).toBe("[2,1]");
    expect(canonicalKey([1, 2])).not.toBe(canonicalKey([2, 1]));
  });

  it("encodes two structurally equal values to one string", () => {
    expect(canonicalKey({ a: 1, b: [true, "x"] })).toBe(canonicalKey({ b: [true, "x"], a: 1 }));
  });

  it("defaults an absent value to null", () => {
    expect(canonicalKey(undefined)).toBe("null");
    expect(canonicalKey({ a: undefined })).toBe('{"a":null}');
  });

  it("spells an absent value as undefined when asked", () => {
    expect(canonicalKey(undefined, { undefinedAs: "undefined" })).toBe("undefined");
    expect(canonicalKey({ a: undefined }, { undefinedAs: "undefined" })).toBe('{"a":undefined}');
    // Absence and null stay distinguishable, which a diff needs.
    expect(canonicalKey(null, { undefinedAs: "undefined" })).toBe("null");
  });

  it("encodes JSON values the way JSON.stringify spells them", () => {
    expect(canonicalKey("a")).toBe('"a"');
    expect(canonicalKey(0)).toBe("0");
    expect(canonicalKey(false)).toBe("false");
    expect(canonicalKey(null)).toBe("null");
  });

  it("keeps the encoding total for values JSON cannot spell", () => {
    expect(canonicalKey(() => 1)).toBe("null");
    expect(canonicalKey(Symbol("s"))).toBe("null");
    expect(canonicalKey(1n)).toBe("null");
    expect(canonicalKey(() => 1, { undefinedAs: "undefined" })).toBe("undefined");
  });
});
