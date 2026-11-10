import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox/type";
import { describe, expect, it } from "vitest";

import { defineModel, e, readDefault, validatePayload } from "../index";

const fieldOf = (entity: ReturnType<typeof defineModel>, key: string): TSchema =>
  (entity.shape.properties as Record<string, TSchema>)[key] as TSchema;

describe("e.enum", () => {
  const wall = defineModel("wall", {
    kind: e.enum(["exterior", "interior", "railing"]),
    height: e.enum(["low", "high"]).default("low"),
  });

  it("declares the field as a literal union", () => {
    const kind = fieldOf(wall, "kind");

    expect(Value.Check(kind, "interior")).toBe(true);
    expect(Value.Check(kind, "brick")).toBe(false);
  });

  it("rejects a non-member through the create-validation shape", () => {
    const violations = validatePayload(
      wall.createShape,
      { kind: "brick", height: "low" },
      "wall",
      false,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.field).toBe("kind");
  });

  it("accepts a create that omits a defaulted enum field", () => {
    expect(validatePayload(wall.createShape, { kind: "interior" }, "wall", false)).toEqual([]);
  });

  it("composes .default() like the other builders", () => {
    const height = fieldOf(wall, "height");

    expect(readDefault(height)).toBe("low");
    expect(Value.Check(height, "high")).toBe(true);
    expect(Value.Check(height, "medium")).toBe(false);
  });

  it("rejects a non-member on an update patch", () => {
    const violations = validatePayload(wall.shape, { kind: "brick" }, "wall", true);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("kind");
  });

  it("rejects an empty closed set at declaration time", () => {
    expect(() => e.enum([])).toThrow(/at least one value/);
  });

  it("keeps numeric members numeric", () => {
    const rating = e.enum([1, 2, 3]);

    expect(Value.Check(rating, 2)).toBe(true);
    expect(Value.Check(rating, "2")).toBe(false);
  });

  it("accepts a one-member set", () => {
    const draft = e.enum(["draft"]).default("draft");

    expect(Value.Check(draft, "draft")).toBe(true);
    expect(Value.Check(draft, "published")).toBe(false);
    expect(readDefault(draft)).toBe("draft");
  });
});
