import { describe, it, expect } from "vitest";
import { e } from "@ebbjs/core";
import { defineEntity, type EntityDef } from "./entity";

describe("defineEntity", () => {
  it("returns a value with the given name and fields", () => {
    const todo = defineEntity("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    expect(todo.name).toBe("todo");
    expect(todo.fields).toEqual({
      title: { type: "lww" },
      completed: { type: "lww" },
    });
  });

  it("returns a frozen value", () => {
    const todo = defineEntity("todo", { title: e.string() });
    expect(Object.isFrozen(todo)).toBe(true);
  });

  it("preserves field-name typing in EntityDef<TFields>", () => {
    const todo: EntityDef<{ title: { type: "lww" } }> = defineEntity("todo", {
      title: e.string(),
    });
    expect(todo.fields.title.type).toBe("lww");
  });

  it("produces independent values for independent calls", () => {
    const a = defineEntity("a", { x: e.number() });
    const b = defineEntity("b", { y: e.boolean() });
    expect(a).not.toBe(b);
    expect(a.name).toBe("a");
    expect(b.name).toBe("b");
    expect(a.fields).not.toBe(b.fields);
  });
});
