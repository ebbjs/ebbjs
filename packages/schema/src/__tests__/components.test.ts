import { describe, expect, it } from "vitest";

import {
  ComponentLeafMismatchError,
  ComponentOutsideModelError,
  InvalidComponentNameError,
  ModelRegistry,
  defineComponent,
  defineModel,
  defineSchema,
  e,
} from "../index";

describe("defineComponent", () => {
  it("returns a frozen declaration with the default policy", () => {
    const title = defineComponent("note/title", e.string());

    expect(Object.isFrozen(title)).toBe(true);
    expect(title).toEqual(
      expect.objectContaining({
        kind: "component",
        name: "note/title",
        optional: false,
        loading: "eager",
        conflictScope: "field",
        indexed: false,
        permission: undefined,
        version: 1,
      }),
    );
    expect(title.marker).toEqual({ type: "lww" });
  });

  it("carries every declared option", () => {
    const body = defineComponent(
      "note/body",
      { engine: e.string(), updates: e.map(e.string()) },
      {
        optional: true,
        loading: "lazy",
        conflictScope: "component",
        indexed: true,
        permission: "own",
        version: 2,
      },
    );

    expect(body.optional).toBe(true);
    expect(body.loading).toBe("lazy");
    expect(body.conflictScope).toBe("component");
    expect(body.indexed).toBe(true);
    expect(body.permission).toBe("own");
    expect(body.version).toBe(2);
    expect(body.shape.properties).toHaveProperty("engine");
  });

  it("rejects a name that is not <model>/<leaf>-shaped with the offending name", () => {
    for (const name of ["title", "/title", "note/", "note/body/more"]) {
      expect(() => defineComponent(name, e.string())).toThrow(InvalidComponentNameError);
      expect(() => defineComponent(name, e.string())).toThrow(name);
    }
  });
});

describe("defineModel", () => {
  it("normalises a bare builder to an anonymous component named <model>/<field>", () => {
    const note = defineModel("note", { title: e.string(), status: e.enum(["draft", "live"]) });

    expect(note.components.title).toEqual(
      expect.objectContaining({
        kind: "component",
        name: "note/title",
        optional: false,
        loading: "eager",
        conflictScope: "field",
      }),
    );
    expect(note.components.status.name).toBe("note/status");
    expect(note.shape.properties).toHaveProperty("title");
    expect(note.markers.title).toEqual({ type: "lww" });
  });

  it("accepts builders and named components in one map", () => {
    const body = defineComponent(
      "note/body",
      { engine: e.string(), updates: e.map(e.string()) },
      { optional: true, loading: "lazy", conflictScope: "component" },
    );
    const note = defineModel("note", { title: e.string(), body });

    expect(note.components.title.name).toBe("note/title");
    expect(note.components.body).toBe(body);
    expect(note.shape.properties).toHaveProperty("body");
  });

  it("maps the model's materialization default onto component loading", () => {
    const page = defineModel(
      "page",
      { content: e.map(e.string()) },
      { materialization: "on-demand" },
    );
    const note = defineModel("note", { title: e.string() });

    expect(page.components.content.loading).toBe("lazy");
    expect(note.components.title.loading).toBe("eager");
  });

  it("derives the model shape from its components", () => {
    const body = defineComponent("note/body", { text: e.string() });
    const note = defineModel("note", { title: e.string(), body });

    expect(note.shape.type).toBe("object");
    expect(note.shape.properties.title).toMatchObject({ type: "string" });
    expect(note.shape.properties.body).toMatchObject({ type: "object" });
  });
});

describe("ModelRegistry", () => {
  const body = defineComponent(
    "note/body",
    { text: e.string() },
    { optional: true, loading: "lazy", conflictScope: "component", permission: "own" },
  );
  const note = defineModel("note", { title: e.string().default("untitled"), body });

  const registry = () => {
    const models = new ModelRegistry();
    models.register(note);
    return models;
  };

  it("answers which components a model declares", () => {
    const names = registry()
      .componentsOf("note")
      .map((component) => component.name);
    expect(names).toEqual(["note/title", "note/body"]);
    expect(registry().componentsOf("missing")).toEqual([]);
  });

  it("finds a component by field key or full name", () => {
    expect(registry().componentOf("note", "title")?.name).toBe("note/title");
    expect(registry().componentOf("note", "note/body")).toBe(body);
    expect(registry().componentOf("note", "missing")).toBeUndefined();
  });

  it("reports existence, loading, conflict scope, and permission", () => {
    expect(registry().isOptional("note", "title")).toBe(false);
    expect(registry().isOptional("note", "note/body")).toBe(true);
    expect(registry().loadingOf("note", "body")).toBe("lazy");
    expect(registry().conflictScopeOf("note", "body")).toBe("component");
    expect(registry().conflictScopeOf("note", "title")).toBe("field");
    expect(registry().permissionOf("note", "body")).toBe("note/body");
    expect(registry().permissionOf("note", "title")).toBe("note");
  });
});

describe("defineSchema component validation", () => {
  it("rejects a component that belongs to another model, naming it", () => {
    const stray = defineComponent("other/body", { text: e.string() });
    const note = defineModel("note", { body: stray });

    let caught: unknown;
    try {
      defineSchema({ models: { note }, version: 1 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ComponentOutsideModelError);
    expect((caught as ComponentOutsideModelError).componentName).toBe("other/body");
    expect((caught as Error).message).toContain("other/body");
  });

  it("rejects a component attached under a leaf other than its own key", () => {
    const body = defineComponent("note/body", { text: e.string() });

    let caught: unknown;
    try {
      defineModel("note", { content: body });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ComponentLeafMismatchError);
    expect((caught as ComponentLeafMismatchError).componentName).toBe("note/body");
    expect((caught as ComponentLeafMismatchError).key).toBe("content");
  });
});
