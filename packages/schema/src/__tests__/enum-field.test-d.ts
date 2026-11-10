import type { Static } from "@sinclair/typebox/type";
import { describe, expectTypeOf, it } from "vitest";

import { defineModel, e } from "../index";

const wall = defineModel("wall", {
  kind: e.enum(["exterior", "interior", "railing"]).default("interior"),
  rating: e.enum([1, 2, 3]),
});

describe("e.enum types", () => {
  it("narrows the read value to the literal union", () => {
    type Wall = Static<typeof wall.shape>;

    expectTypeOf<Wall["kind"]>().toEqualTypeOf<"exterior" | "interior" | "railing">();
    expectTypeOf<Wall["rating"]>().toEqualTypeOf<1 | 2 | 3 | undefined>();
  });

  it("rejects a non-member default and a non-member write", () => {
    // @ts-expect-error - "brick" is not a declared member
    e.enum(["exterior", "interior"]).default("brick");

    // @ts-expect-error - a write may not carry a value outside the set
    const invalid: Static<typeof wall.createShape> = { kind: "brick" };
    void invalid;
  });
});
