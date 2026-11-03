import { describe, expect, it } from "vitest";
import { p } from "../schema";
import type { FunctionSchema } from "../schema";

function issuesOf<T>(schema: FunctionSchema<T>, value: unknown) {
  const result = schema["~standard"].validate(value);
  return "issues" in result ? result.issues : [];
}

describe("p.object", () => {
  const params = p.object({
    documentId: p.string(),
    limit: p.optional(p.number()),
  });

  it("produces a draft-7 JSON Schema", () => {
    expect(params.toJSONSchema()).toEqual({
      type: "object",
      required: ["documentId"],
      properties: {
        documentId: { type: "string" },
        limit: { type: "number" },
      },
    });
  });

  it("is JSON-serializable without TypeBox metadata", () => {
    const json = params.toJSONSchema();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(Object.getOwnPropertySymbols(json)).toEqual([]);
  });

  it("accepts a valid object and returns it untransformed", () => {
    const value = { documentId: "doc_1", extra: "kept" };
    expect(params["~standard"].validate(value)).toEqual({ value });
  });

  it("reports a missing required property with its path", () => {
    expect(issuesOf(params, {})).toContainEqual({
      message: "Expected required property",
      path: ["documentId"],
    });
  });

  it("reports a wrong property type with its path", () => {
    expect(issuesOf(params, { documentId: 1 })).toEqual([
      { message: "Expected string", path: ["documentId"] },
    ]);
  });

  it("rejects a present optional property of the wrong type", () => {
    expect(issuesOf(params, { documentId: "doc_1", limit: "ten" })).toEqual([
      { message: "Expected number", path: ["limit"] },
    ]);
  });
});

describe("p primitives", () => {
  it("validates strings, numbers, and booleans", () => {
    expect(p.string()["~standard"].validate("ok")).toEqual({ value: "ok" });
    expect(p.number()["~standard"].validate(1)).toEqual({ value: 1 });
    expect(p.boolean()["~standard"].validate(false)).toEqual({ value: false });
    expect(issuesOf(p.number(), "1")).toEqual([{ message: "Expected number" }]);
  });

  it("does not coerce or default", () => {
    expect(p.number()["~standard"].validate("1")).toHaveProperty("issues");
    expect(p.string()["~standard"].validate(undefined)).toHaveProperty("issues");
  });
});

describe("p.array", () => {
  it("validates items and reports an index path", () => {
    const tags = p.array(p.string());
    expect(tags["~standard"].validate(["a", "b"])).toEqual({ value: ["a", "b"] });
    expect(issuesOf(tags, ["a", 2])).toEqual([{ message: "Expected string", path: [1] }]);
  });
});

describe("p.literal and p.union", () => {
  it("validates literals", () => {
    expect(p.literal("asc")["~standard"].validate("asc")).toEqual({ value: "asc" });
    expect(issuesOf(p.literal("asc"), "desc")).toHaveLength(1);
  });

  it("validates multiple literals as a union", () => {
    const direction = p.literal("asc", "desc");
    expect(direction["~standard"].validate("desc")).toEqual({ value: "desc" });
    expect(issuesOf(direction, "sideways")).toHaveLength(1);
  });

  it("validates unions of schemas", () => {
    const id = p.union([p.string(), p.number()]);
    expect(id["~standard"].validate(7)).toEqual({ value: 7 });
    expect(id.toJSONSchema()).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
  });
});

describe("p.nullable", () => {
  it("accepts null and the wrapped schema", () => {
    const name = p.nullable(p.string());
    expect(name["~standard"].validate(null)).toEqual({ value: null });
    expect(name["~standard"].validate("grace")).toEqual({ value: "grace" });
  });
});

describe("p.record", () => {
  it("validates values and reports the key path", () => {
    const counts = p.record(p.number());
    expect(counts.toJSONSchema()).toEqual({
      type: "object",
      patternProperties: { "^(.*)$": { type: "number" } },
    });
    expect(counts["~standard"].validate({ a: 1 })).toEqual({ value: { a: 1 } });
    expect(issuesOf(counts, { a: "one" })).toEqual([{ message: "Expected number", path: ["a"] }]);
  });
});

describe("standard schema interface", () => {
  it("identifies as a standard schema", () => {
    expect(p.string()["~standard"]).toMatchObject({ version: 1, vendor: "ebb" });
  });
});
