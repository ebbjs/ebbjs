import { describe, it, expect } from "vitest";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  defineModel,
  e,
  hasDefault,
  readDefault,
  validatePayload,
  NullFieldError,
  ReservedNameError,
} from "./index";

describe("defineModel", () => {
  it("returns a value carrying the given name and field markers", () => {
    const todo = defineModel("todo", {
      title: e.string(),
      completed: e.boolean(),
    });
    expect(todo.name).toBe("todo");
    expect(todo.markers).toEqual({
      title: { type: "lww" },
      completed: { type: "lww" },
    });
  });

  it("returns a frozen value", () => {
    const todo = defineModel("todo", { title: e.string() });
    expect(Object.isFrozen(todo)).toBe(true);
  });

  it("marks a map field for key-by-key merge", () => {
    const doc = defineModel("doc", { content: e.map(e.string()) });

    // The marker is what tells the write path a field merges per key instead
    // of replacing the whole value.
    expect(doc.markers.content).toEqual({ type: "lww", map: true });
    const content = doc.shape.properties.content as Parameters<typeof Value.Check>[0];
    expect(Value.Check(content, { a: "x" })).toBe(true);
    expect(Value.Check(content, { a: 1 })).toBe(false);
  });

  it('defaults conflictScope to "field" and stores an explicit one', () => {
    expect(defineModel("todo", { title: e.string() }).conflictScope).toBe("field");
    expect(
      defineModel("todo", { title: e.string() }, { conflictScope: "entity" }).conflictScope,
    ).toBe("entity");
  });

  it('defaults materialization to "held" and stores an explicit one', () => {
    expect(defineModel("todo", { title: e.string() }).materialization).toBe("held");
    const pageContent = defineModel(
      "page_content",
      { content: e.map(e.string()) },
      { materialization: "on-demand" },
    );
    expect(pageContent.materialization).toBe("on-demand");
  });
});

describe("defineModel reserved names", () => {
  it("rejects the platform namespace as an entity name", () => {
    expect(() => defineModel("ebb", { name: e.string() })).toThrow(ReservedNameError);
    expect(() => defineModel("ebb", { name: e.string() })).toThrow(/reserved/);
  });

  it("rejects a field named groups — the injected membership accessor", () => {
    expect(() => defineModel("todo", { groups: e.string() })).toThrow(ReservedNameError);
    expect(() => defineModel("todo", { groups: e.string() })).toThrow(/reserved/);
  });

  it("still accepts app names and fields that don't collide", () => {
    const todo = defineModel("todo", { title: e.string(), grouping: e.string() });
    expect(todo.name).toBe("todo");
  });
});

describe("declarative field defaults", () => {
  it("e.string().default(v) stamps a plain default annotation on the property schema", () => {
    const todo = defineModel("todo", {
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
    const list = e.array(e.string()).default(["a"]) as { default?: unknown };
    expect(list.default).toEqual(["a"]);
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
    const todo = defineModel("todo", { priority: e.string().default("normal") });
    // The default does not relax the declared type.
    expect(validatePayload(todo.createShape, { priority: "normal" }, "todo", false)).toEqual([]);
    expect(validatePayload(todo.createShape, { priority: 1 }, "todo", false)).not.toEqual([]);
  });

  it("clones and freezes a default so rows and the schema hash share no object", () => {
    const fallback = { a: "x" };
    const field = e.map(e.string()).default(fallback);
    fallback.a = "mutated";
    const stored = readDefault(field) as { a: string };
    expect(stored.a).toBe("x");
    expect(Object.isFrozen(stored)).toBe(true);
  });

  it("readDefault tolerates an unknown property schema", () => {
    expect(readDefault(undefined)).toBeUndefined();
    expect(hasDefault(undefined)).toBe(false);
  });
});

describe("field schemas may not admit null", () => {
  it("rejects a union that includes Type.Null, naming the field", () => {
    expect(() => defineModel("todo", { body: Type.Union([Type.String(), Type.Null()]) })).toThrow(
      NullFieldError,
    );
  });

  it("rejects a bare null-typed field", () => {
    expect(() => defineModel("todo", { gone: Type.Null() })).toThrow(NullFieldError);
  });

  it("rejects Any/Unknown, which admit null without naming it", () => {
    expect(() => defineModel("todo", { anything: Type.Any() })).toThrow(NullFieldError);
    expect(() => defineModel("todo", { anything: Type.Unknown() })).toThrow(NullFieldError);
  });

  it("rejects a schema whose type array includes null", () => {
    expect(() => defineModel("todo", { value: { type: ["string", "null"] } as never })).toThrow(
      NullFieldError,
    );
  });
});
