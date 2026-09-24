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
    // Compile-time check: keys of `fields` flow through to EntityDef.
    const todo: EntityDef<{ title: { type: "lww" } }> = defineEntity("todo", {
      title: e.string(),
    });
    expect(todo.fields.title.type).toBe("lww");
  });

  it("produces independent values for independent calls", () => {
    const a = defineEntity("a", { x: e.number() });
    const b = defineEntity("b", { y: e.counter() });
    expect(a).not.toBe(b);
    expect(a.name).toBe("a");
    expect(b.name).toBe("b");
    expect(a.fields).not.toBe(b.fields);
  });

  it("supports all marker types in fields", () => {
    const doc = defineEntity("doc", {
      body: e.collaborativeText(),
      views: e.counter(),
      title: e.string(),
      rating: e.number(),
      pinned: e.boolean(),
    });
    expect(doc.fields.body).toEqual({ type: "causal-tree" });
    expect(doc.fields.views).toEqual({ type: "counter" });
    expect(doc.fields.title).toEqual({ type: "lww" });
    expect(doc.fields.rating).toEqual({ type: "lww" });
    expect(doc.fields.pinned).toEqual({ type: "lww" });
  });
});
