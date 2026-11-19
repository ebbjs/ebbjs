import type { Static } from "@sinclair/typebox/type";
import { describe, expectTypeOf, it } from "vitest";

import { defineModel, e } from "../index";

const entryLog = () => e.log(e.number());

const note = defineModel("note", {
  title: e.string(),
  updates: e.log(e.object({ text: e.string() })),
});

describe("e.log types", () => {
  it("reads as a plain record, exactly like a keyed component", () => {
    type Note = Static<typeof note.shape>;

    expectTypeOf<NonNullable<Note["updates"]>>().toEqualTypeOf<Record<string, { text: string }>>();
  });

  it("projects the builder's static to the entry record", () => {
    expectTypeOf<Static<ReturnType<typeof entryLog>>>().toEqualTypeOf<Record<string, number>>();
  });

  it("rejects a default that is not the projected record", () => {
    // @ts-expect-error - a log's default is a map of entries, not one entry value
    e.log(e.number()).default({ a: "x" });
  });
});
