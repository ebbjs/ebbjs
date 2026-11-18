import { describe, expect, it } from "vitest";

import { formatLogLine, formatLogValue, messageOf } from "./text.ts";

describe("formatLogValue", () => {
  it("stringifies anything a handler may print", () => {
    expect(formatLogValue("text")).toBe("text");
    expect(formatLogValue(42)).toBe("42");
    expect(formatLogValue(undefined)).toBe("undefined");
    expect(formatLogValue(null)).toBe("null");
    expect(formatLogValue({ a: 1 })).toBe('{"a":1}');
    expect(formatLogValue(Symbol("s"))).toBe("Symbol(s)");
    expect(formatLogValue(7n)).toBe("7n");
    expect(formatLogValue(new Error("boom"))).toBe("Error: boom");
    expect(formatLogValue([1, 2])).toBe("[1,2]");
  });

  it("survives a circular object and a throwing toString", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(formatLogValue(circular)).toBe("[object Object]");

    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "boom", {
      enumerable: true,
      get() {
        throw new Error("no json");
      },
    });
    Object.defineProperty(hostile, "toString", {
      value: () => {
        throw new Error("no string");
      },
    });
    expect(formatLogValue(hostile)).toBe("[unprintable]");
  });

  it("joins arguments with a space", () => {
    expect(formatLogLine(["hello", 42, { a: 1 }])).toBe('hello 42 {"a":1}');
  });
});

describe("messageOf", () => {
  it("reports an error's message without its name", () => {
    expect(messageOf(new Error("boom"))).toBe("boom");
  });

  it("stringifies a value that is not an error", () => {
    expect(messageOf("gone")).toBe("gone");
    expect(messageOf(undefined)).toBe("undefined");
  });

  it("never throws on a value whose toString throws", () => {
    const hostile = {
      toString() {
        throw new Error("no string");
      },
    };

    expect(messageOf(hostile)).toBe("[unprintable]");
  });
});
