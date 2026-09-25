import { describe, it, expect } from "vitest";
import { Type } from "@sinclair/typebox";
import { defineEntity, e, Optional, type EntityDef, type NullableSchema } from "./entity";

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

  it("exposes the implicit Type.Object wrapper as shape", () => {
    const todo = defineEntity("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    expect(todo.shape.type).toBe("object");
    expect(todo.shape.properties).toEqual({
      title: expect.objectContaining({ type: "string" }),
      completed: expect.objectContaining({ type: "boolean" }),
    });
  });

  it("returns a frozen value", () => {
    const todo = defineEntity("todo", { title: e.string() });
    expect(Object.isFrozen(todo)).toBe(true);
  });

  it("preserves field-name typing in EntityDef<TFields>", () => {
    const todo = defineEntity("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    expect(todo.fields.title.type).toBe("lww");
    expect(todo.fields.completed.type).toBe("lww");
  });

  it("preserves the typed EntityDef<TFields> generic at the call site", () => {
    // Compile-time assertion: the user-written field map flows
    // through `defineEntity` into EntityDef<TFields>.
    const todo: EntityDef<{
      title: ReturnType<typeof e.string>;
      completed: ReturnType<typeof e.boolean>;
    }> = defineEntity("todo", {
      title: e.string(),
      completed: e.boolean(),
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

describe("e.* primitives", () => {
  it("e.string() returns a TypeBox string schema", () => {
    const s = e.string();
    expect(s.type).toBe("string");
  });

  it("e.number() returns a TypeBox number schema", () => {
    const n = e.number();
    expect(n.type).toBe("number");
  });

  it("e.integer() returns a TypeBox integer schema", () => {
    const i = e.integer();
    expect(i.type).toBe("integer");
  });

  it("e.boolean() returns a TypeBox boolean schema", () => {
    const b = e.boolean();
    expect(b.type).toBe("boolean");
  });

  it("e.string().nullable() returns Type.Union([Type.String(), Type.Null()])", () => {
    const n = e.string().nullable();
    expect(Type.Union).toBeDefined();
    expect(n.anyOf).toHaveLength(2);
    expect(n.anyOf[0]).toMatchObject({ type: "string" });
    expect(n.anyOf[1]).toMatchObject({ type: "null" });
  });

  it("e.boolean().nullable() also produces a union with Type.Null", () => {
    const n = e.boolean().nullable();
    expect(n.anyOf).toHaveLength(2);
    expect(n.anyOf[1]).toMatchObject({ type: "null" });
  });

  it("NullableSchema carries the .nullable() chain as a non-enumerable property", () => {
    const s: NullableSchema<ReturnType<typeof Type.String>> = e.string();
    expect(typeof s.nullable).toBe("function");
    expect(Object.keys(s)).not.toContain("nullable");
  });
});

describe("bare-field-map authoring", () => {
  it("defineEntity accepts a bare field map; callers never write Type.Object", () => {
    // The AC: callers write `{ title: e.string(), completed: e.boolean() }`
    // and defineEntity wraps it internally. The shape axis carries the
    // Type.Object wrapper; the call site doesn't construct it.
    const todo = defineEntity("todo", {
      title: e.string(),
      completed: e.boolean(),
      body: e.string().nullable(),
    });
    expect(todo.name).toBe("todo");
    expect(todo.shape.type).toBe("object");
  });

  it("Optional from @ebbjs/client opts a field in without importing TypeBox directly", () => {
    // The AC: `Optional` is re-exported so users can mark fields optional
    // without adding @sinclair/typebox to their own dependencies.
    const todo = defineEntity("todo", {
      title: e.string(),
      archivedAt: Optional(e.string()),
    });
    expect(Object.isFrozen(todo)).toBe(true);
    expect(todo.shape.type).toBe("object");
  });
});
