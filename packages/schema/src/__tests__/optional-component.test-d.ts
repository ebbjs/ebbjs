import type { Static } from "@sinclair/typebox/type";
import { describe, expectTypeOf, it } from "vitest";

import { defineComponent, defineModel, e } from "../index";

const draft = defineComponent("note/draft", { text: e.string() }, { optional: true });
const tag = defineComponent("note/tag", e.string(), { optional: true });
const note = defineModel("note", { title: e.string(), draft, tag });

describe("optional component types", () => {
  it("reads an absent optional component as undefined", () => {
    type Note = Static<typeof note.shape>;

    expectTypeOf<Note["tag"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<undefined>().toMatchTypeOf<Note["draft"]>();
    expectTypeOf<NonNullable<Note["draft"]>["text"]>().toEqualTypeOf<string | undefined>();
  });

  it("lets create() omit an optional component, including one declared from a bare builder", () => {
    type Create = Static<typeof note.createShape>;

    const omitted: Create = { title: "first" };
    const present: Create = { title: "first", draft: { text: "hi" }, tag: "x" };

    expectTypeOf(omitted).toMatchTypeOf<Create>();
    expectTypeOf(present.tag).toEqualTypeOf<string | undefined>();
  });

  it("still requires a present optional component's own value", () => {
    type Create = Static<typeof note.createShape>;

    // @ts-expect-error - a present tag carries its string
    const partial: Create = { title: "first", tag: 1 };
    void partial;
  });

  it("still requires a non-optional component at create()", () => {
    type Create = Static<typeof note.createShape>;

    // @ts-expect-error - only a default or optional: true lets create() omit a component
    const missing: Create = {};
    void missing;
  });

  it("keeps a defaulted, non-optional component required in the read shape", () => {
    const task = defineModel("task", { priority: e.string().default("normal") });
    type Task = Static<typeof task.shape>;

    expectTypeOf<Task["priority"]>().toEqualTypeOf<string>();
  });
});

// `optional: true` with a declared default is refused at declaration time by
// `OptionalDefaultConflictError` (see components.test.ts). A field builder's
// default is a runtime annotation, so the conflict has no type-level spelling.
