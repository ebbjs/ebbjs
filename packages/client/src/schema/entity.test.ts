import { describe, it, expect, expectTypeOf } from "vitest";
import { Type, type Static } from "@sinclair/typebox";
import {
  defineEntity,
  e,
  hasDefault,
  readDefault,
  validatePayload,
  DerivedFieldDefaultError,
  type EntityDef,
  NullFieldError,
} from "@ebbjs/schema";
import { ReservedNameError, RESERVED_ENTITY_NAMES } from "@ebbjs/schema";

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

  it("describes a map field as a JSON Schema map rule", () => {
    // TypeBox spells `Record(String, …)` as `patternProperties`; the
    // `additionalProperties` option is the other, equivalent spelling.
    expect(Type.Record(Type.String(), Type.String())).toMatchObject({
      type: "object",
      patternProperties: { "^(.*)$": { type: "string" } },
    });

    const doc = defineEntity("doc", {
      content: Type.Object({}, { additionalProperties: Type.String() }),
    });
    expect(doc.shape.properties.content).toMatchObject({
      type: "object",
      additionalProperties: { type: "string" },
    });
    expect(doc.fields.content).toEqual({ type: "lww" });
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

  it('defaults conflictScope to "field"', () => {
    const todo = defineEntity("todo", { title: e.string() });
    expect(todo.conflictScope).toBe("field");
  });

  it("stores an explicit conflictScope", () => {
    const todo = defineEntity("todo", { title: e.string() }, { conflictScope: "entity" });
    expect(todo.conflictScope).toBe("entity");
  });

  it('defaults materialization to "held"', () => {
    const todo = defineEntity("todo", { title: e.string() });
    expect(todo.materialization).toBe("held");
  });

  it("stores an explicit materialization", () => {
    const pageContent = defineEntity(
      "page_content",
      { content: e.map(e.string()) },
      { materialization: "on-demand" },
    );
    expect(pageContent.materialization).toBe("on-demand");
  });

  it("freezes the declared materialization", () => {
    const pageContent = defineEntity(
      "page_content",
      { content: e.map(e.string()) },
      { materialization: "on-demand" },
    );
    expect(Object.getOwnPropertyDescriptor(pageContent, "materialization")).toMatchObject({
      value: "on-demand",
      writable: false,
    });
  });
});

describe("defineEntity reserved names", () => {
  it.each(RESERVED_ENTITY_NAMES)("rejects the reserved entity name %s", (name) => {
    expect(() => defineEntity(name, { name: e.string() })).toThrow(ReservedNameError);
    expect(() => defineEntity(name, { name: e.string() })).toThrow(/reserved/);
  });

  it("rejects a field named groups — the injected membership accessor", () => {
    expect(() => defineEntity("todo", { groups: e.string() })).toThrow(ReservedNameError);
    expect(() => defineEntity("todo", { groups: e.string() })).toThrow(/reserved/);
  });

  it("still accepts app names and fields that don't collide", () => {
    const todo = defineEntity("todo", { title: e.string(), grouping: e.string() });
    expect(todo.name).toBe("todo");
  });

  it("rejects an entity name carrying the generated document prefix", () => {
    expect(() => defineEntity("text_document__x__y", { name: e.string() })).toThrow(
      ReservedNameError,
    );
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
});

describe("bare-field-map authoring", () => {
  it("defineEntity accepts a bare field map; callers never write Type.Object", () => {
    const todo = defineEntity("todo", {
      title: e.string(),
      completed: e.boolean(),
      body: e.string(),
    });
    expect(todo.name).toBe("todo");
    expect(todo.shape.type).toBe("object");
  });
});

describe("declarative field defaults", () => {
  it("e.string().default(v) stamps a plain default annotation on the property schema", () => {
    const todo = defineEntity("todo", {
      title: e.string(),
      priority: e.string().default("normal"),
    });
    const priority = todo.shape.properties.priority as { default?: unknown };
    expect(priority.default).toBe("normal");
    // Enumerable, so a JSON-schema/hash walk sees it.
    expect(Object.keys(priority)).toContain("default");
    expect(JSON.stringify(priority)).toContain('"default":"normal"');
  });

  it("carries defaults for every field builder", () => {
    expect((e.number().default(3) as { default?: unknown }).default).toBe(3);
    expect((e.integer().default(3) as { default?: unknown }).default).toBe(3);
    expect((e.boolean().default(true) as { default?: unknown }).default).toBe(true);
    const map = e.map(e.string()).default({ a: "x" }) as { default?: unknown };
    expect(map.default).toEqual({ a: "x" });
  });

  it("hasDefault/readDefault read the annotation back", () => {
    const d = e.string().default("normal");
    const plain = e.string();
    expect(hasDefault(d)).toBe(true);
    expect(readDefault(d)).toBe("normal");
    expect(hasDefault(plain)).toBe(false);
    expect(readDefault(plain)).toBeUndefined();
  });

  it("a falsy default still counts as a default", () => {
    expect(hasDefault(e.boolean().default(false))).toBe(true);
    expect(hasDefault(e.integer().default(0))).toBe(true);
    expect(readDefault(e.boolean().default(false))).toBe(false);
    expect(readDefault(e.integer().default(0))).toBe(0);
  });

  it("Value.Check ignores the annotation", () => {
    const todo = defineEntity("todo", { priority: e.string().default("normal") });
    // The default does not relax the declared type.
    expect(validatePayload(todo.createShape, { priority: "normal" }, "todo", false)).toEqual([]);
    expect(validatePayload(todo.createShape, { priority: 1 }, "todo", false)).not.toEqual([]);
  });

  it("rejects a default on a derived collaborative-text field", () => {
    expect(() => defineEntity("doc", { body: e.collaborativeText().default("seed") })).toThrow(
      DerivedFieldDefaultError,
    );
  });
});

describe("read types state absence", () => {
  const task = defineEntity("task", {
    title: e.string(),
    priority: e.string().default("normal"),
  });

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

  it("the runtime read shape marks an undefaulted property optional", () => {
    const shape = task.shape as unknown as {
      properties: Record<string, { [key: symbol]: unknown }>;
    };
    const properties = shape.properties as Record<string, Record<string, unknown>>;
    expect(properties.priority).toBeDefined();
    expect(properties.title).toBeDefined();
    // Type.Optional stamps OptionalKind on the property schema.
    expect(Object.getOwnPropertySymbols(properties.title!).length).toBeGreaterThan(0);
  });
});

describe("field schemas may not admit null", () => {
  it("rejects a union that includes Type.Null, naming the field", () => {
    expect(() => defineEntity("todo", { body: Type.Union([Type.String(), Type.Null()]) })).toThrow(
      NullFieldError,
    );
  });

  it("rejects a bare null-typed field", () => {
    expect(() => defineEntity("todo", { gone: Type.Null() })).toThrow(NullFieldError);
  });

  it("rejects a schema whose type array includes null", () => {
    expect(() => defineEntity("todo", { value: { type: ["string", "null"] } as never })).toThrow(
      NullFieldError,
    );
  });
});
