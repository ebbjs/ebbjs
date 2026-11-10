import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox/type";
import { unset } from "@ebbjs/core";
import { describe, expect, it } from "vitest";

import { NullFieldError, defineModel, e, readDefault, validatePayload } from "../index";

const fieldOf = (entity: ReturnType<typeof defineModel>, key: string): TSchema =>
  (entity.shape.properties as Record<string, TSchema>)[key] as TSchema;

describe("e.object", () => {
  const wall = defineModel("wall", {
    anchor: e.object({ x: e.number(), y: e.number() }),
    opening: e.object({
      kind: e.enum(["door", "window"]),
      width: e.number(),
    }),
    frame: e.object({ from: e.integer(), to: e.integer() }).default({ from: 0, to: 0 }),
  });

  it("declares the field as a closed nested object", () => {
    const opening = fieldOf(wall, "opening");

    expect(Value.Check(opening, { kind: "door", width: 800 })).toBe(true);
    expect(Value.Check(opening, { kind: "hatch", width: 800 })).toBe(false);
    expect(Value.Check(opening, { kind: "door", width: 800, depth: 10 })).toBe(false);
  });

  it("rejects an undeclared nested property, naming it", () => {
    const violations = validatePayload(
      wall.shape,
      { anchor: { x: 1, y: 2, why: 3 } },
      "wall",
      true,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.field).toBe("anchor");
    expect(violations[0]?.message).toContain("why");
  });

  it("names an undeclared nested property on a full create too", () => {
    const point = defineModel("point", { at: e.object({ x: e.number() }) });
    const violations = validatePayload(point.createShape, { at: { x: 1, why: 2 } }, "point", false);

    expect(violations.some((violation) => violation.message.includes("at.why"))).toBe(true);
  });

  it("requires every declared nested property", () => {
    const violations = validatePayload(wall.shape, { anchor: { x: 1 } }, "wall", true);

    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations[0]?.field).toBe("anchor");
    expect(violations[0]?.message).toContain("y");
  });

  it("does not add the top-level T | undefined absence rule to a nested property", () => {
    // `Type.Optional` is how a nested property is declared optional.
    const slit = defineModel("slit", {
      size: e.object({ width: e.number(), height: Type.Optional(Type.Number()) }),
    });

    expect(validatePayload(slit.shape, { size: { width: 10 } }, "slit", true)).toEqual([]);
  });

  it("composes .default() over the whole object with a deep-frozen annotation", () => {
    const frame = fieldOf(wall, "frame");
    const fallback = readDefault(frame) as { from: number; to: number };

    expect(fallback).toEqual({ from: 0, to: 0 });
    expect(Object.isFrozen(fallback)).toBe(true);
    // Part of the schema, so the schema hash sees it.
    expect((frame as { default?: unknown }).default).toBe(fallback);
    expect(JSON.stringify(frame)).toContain('"default":{"from":0,"to":0}');
    expect(Value.Check(frame, { from: 1, to: 5 })).toBe(true);
  });
});

describe("e.object null refusal", () => {
  it("refuses a nested nullable property at definition time", () => {
    expect(() =>
      defineModel("wall", { anchor: e.object({ x: e.number(), y: Type.Null() }) }),
    ).toThrow(NullFieldError);
  });

  it("refuses a nested nullable property at any depth", () => {
    expect(() =>
      defineModel("wall", {
        anchor: e.object({ inner: e.object({ gone: Type.Null() }) }),
      }),
    ).toThrow(NullFieldError);
  });

  it("refuses a nullable array item at definition time", () => {
    expect(() =>
      defineModel("wall", { tags: e.array(Type.Union([Type.String(), Type.Null()])) }),
    ).toThrow(NullFieldError);
  });

  it("refuses a nullable property inside an array item", () => {
    expect(() =>
      defineModel("wall", { openings: e.array(e.object({ width: Type.Null() })) }),
    ).toThrow(NullFieldError);
  });

  it("still allows a map whose entries admit null", () => {
    expect(() =>
      defineModel("document", {
        cells: e.map(Type.Object({ value: Type.String(), y: Type.Null() })),
      }),
    ).not.toThrow();
  });
});

describe("e.object nested unset", () => {
  const wall = defineModel("wall", { anchor: e.object({ x: e.number(), y: e.number() }) });

  it("reports one clear violation naming the path and e.map", () => {
    const violations = validatePayload(wall.shape, { anchor: { x: 1, y: unset } }, "wall", true);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("anchor.y");
    expect(violations[0]?.message).toContain("e.map");
    expect(violations[0]?.message).not.toContain("Expected");
  });

  it("reports a nested literal null with its path", () => {
    const violations = validatePayload(wall.shape, { anchor: { x: 1, y: null } }, "wall", true);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("anchor.y: null is not a value");
  });
});

describe("nested values in non-map fields", () => {
  const board = defineModel("board", {
    anchor: e.object({ x: e.number(), y: e.number() }),
    tags: e.array(e.string()),
    marks: e.map(e.object({ x: e.number(), y: e.number() })),
  });

  it("reports an unset in an array item at its path, never as a type error", () => {
    const violations = validatePayload(board.shape, { tags: ["a", unset] }, "board", true);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("tags[1]");
    expect(violations[0]?.message).toContain("e.map");
  });

  it("reports an unset deeper than a map field's entries", () => {
    const violations = validatePayload(
      board.shape,
      { marks: { a: { x: 1, y: unset } } },
      "board",
      true,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("marks.a.y");
    expect(violations[0]?.message).toContain("e.map");
  });

  it("keeps a map field's top-level entry unset legal", () => {
    expect(validatePayload(board.shape, { marks: { a: unset } }, "board", true)).toEqual([]);
  });

  it("reports a nested null inside a map entry with its path", () => {
    const violations = validatePayload(
      board.shape,
      { marks: { a: { x: 1, y: null } } },
      "board",
      true,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("marks.a.y: null is not a value");
  });

  it("reports a nested unset on a full create as well", () => {
    const violations = validatePayload(
      board.createShape,
      { anchor: { x: 1, y: unset }, tags: [], marks: {} },
      "board",
      false,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("anchor.y");
    expect(violations[0]?.message).toContain("e.map");
  });
});

describe("e.object nested map refusal", () => {
  it("refuses a nested e.map and names the alternative", () => {
    expect(() => e.object({ inner: e.map(e.number()) })).toThrow(/e\.map/);
  });

  it("refuses a nested Type.Record at any depth", () => {
    expect(() =>
      e.object({ inner: e.object({ deeper: Type.Record(Type.String(), Type.Number()) }) }),
    ).toThrow(/top level/);
  });
});
