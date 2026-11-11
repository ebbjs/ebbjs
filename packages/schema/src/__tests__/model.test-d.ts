import type { Static } from "@sinclair/typebox/type";
import { describe, expectTypeOf, it } from "vitest";

import { defineModel, e } from "../index";

const task = defineModel("task", {
  title: e.string(),
  priority: e.string().default("normal"),
});

describe("read types state absence", () => {
  it("a defaulted field reads as T; an undefaulted one as T | undefined", () => {
    type Task = Static<typeof task.shape>;
    expectTypeOf<Task["priority"]>().toEqualTypeOf<string>();
    expectTypeOf<Task["title"]>().toEqualTypeOf<string | undefined>();
  });

  it("create may omit a defaulted field and must provide an undefaulted one", () => {
    type Create = Static<typeof task.createShape>;
    expectTypeOf<Create["priority"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Create["title"]>().toEqualTypeOf<string>();
  });
});
