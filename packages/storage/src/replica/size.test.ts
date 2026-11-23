import { describe, expect, it } from "vitest";

import { jsonBytes, utf8Bytes } from "./size";

describe("replica size accounting", () => {
  it("counts UTF-8 bytes the way Buffer does", () => {
    for (const text of ["", "abc", "é", "📄", "a📄b", "\ud800", "a\ud800b"]) {
      expect(utf8Bytes(text)).toBe(Buffer.byteLength(text, "utf8"));
    }
  });

  it("counts a value's JSON, and nothing for a value with no JSON", () => {
    for (const value of [null, "é", 42, { title: "hi", values: ["é", "📄"] }]) {
      expect(jsonBytes(value)).toBe(Buffer.byteLength(JSON.stringify(value), "utf8"));
    }
    expect(jsonBytes(undefined)).toBe(0);
  });
});
