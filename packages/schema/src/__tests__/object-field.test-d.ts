import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox/type";
import { describe, expectTypeOf, it } from "vitest";

import { defineModel, e } from "../index";

const wall = defineModel("wall", {
  anchor: e.object({ x: e.number(), y: e.number() }),
  opening: e.object({ kind: e.enum(["door", "window"]), width: e.number() }),
  frame: e.object({ from: e.integer(), to: e.integer() }).default({ from: 0, to: 0 }),
  shutter: e.object({ width: e.number(), height: Type.Optional(Type.Number()) }),
});

const plot = defineModel("plot", {
  viewport: e.object({
    origin: e.object({ x: e.number(), y: e.number() }),
    zoom: e.number(),
  }),
});

describe("e.object types", () => {
  it("reads as the nested shape with nested enums narrowed", () => {
    type Wall = Static<typeof wall.shape>;

    expectTypeOf<Wall["anchor"]>().toEqualTypeOf<{ x: number; y: number } | undefined>();
    expectTypeOf<Wall["opening"]>().toEqualTypeOf<
      { kind: "door" | "window"; width: number } | undefined
    >();
    expectTypeOf<Wall["frame"]>().toEqualTypeOf<{ from: number; to: number }>();
  });

  it("does not apply the top-level absence rule to a nested property", () => {
    type Anchor = NonNullable<Static<typeof wall.shape>["anchor"]>;

    expectTypeOf<Anchor["x"]>().toEqualTypeOf<number>();
    expectTypeOf<Anchor["y"]>().toEqualTypeOf<number>();
  });

  it("types a nested property declared optional as optional", () => {
    type Shutter = NonNullable<Static<typeof wall.shape>["shutter"]>;

    expectTypeOf<Shutter["height"]>().toEqualTypeOf<number | undefined>();
  });

  it("nests an object inside an object", () => {
    type Viewport = NonNullable<Static<typeof plot.shape>["viewport"]>;

    expectTypeOf<Viewport["origin"]>().toEqualTypeOf<{ x: number; y: number }>();
    expectTypeOf<Viewport["zoom"]>().toEqualTypeOf<number>();
  });

  it("rejects a partial object default", () => {
    // @ts-expect-error - .default() takes the whole object
    e.object({ x: e.number(), y: e.number() }).default({ x: 1 });
  });

  it("rejects a nested value of the wrong shape", () => {
    // @ts-expect-error - the nested object requires both numbers
    const invalid: Static<typeof wall.createShape> = { anchor: { x: 1 } };
    void invalid;
  });
});
