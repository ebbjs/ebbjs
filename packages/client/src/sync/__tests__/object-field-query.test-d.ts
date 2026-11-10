import { Type } from "@sinclair/typebox";
import { describe, it } from "vitest";

import { defineModel, e } from "@ebbjs/schema";

import { buildQueryBuilder } from "../query-builder";

const wall = defineModel("wall", {
  anchor: Type.Object({ x: Type.Number(), y: Type.Number() }, { additionalProperties: false }),
  tags: Type.Array(Type.String()),
  kind: e.enum(["exterior", "interior"]).default("interior"),
  rating: e.number().default(0),
  title: e.string(),
});

describe("orderBy field keys", () => {
  it("accepts scalar, enum, and defaulted field keys", () => {
    const builder = buildQueryBuilder([], wall.shape);
    builder.orderBy("title", "asc").orderBy("kind", "desc").orderBy("rating", "asc");
  });

  it("rejects object- and array-typed field keys", () => {
    const builder = buildQueryBuilder([], wall.shape);
    const invoke = () => {
      // @ts-expect-error — an object field has no scalar order
      builder.orderBy("anchor", "asc");
      // @ts-expect-error — an array field has no scalar order
      builder.orderBy("tags", "asc");
    };
    void invoke;
  });
});
