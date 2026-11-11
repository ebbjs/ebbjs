import { describe, it, expect } from "vitest";
import { makeHlc, type Action } from "@ebbjs/core";
import { ModelRegistry, EntityValidationError, defineModel, e } from "./index";

const todo = defineModel("todo", {
  title: e.string(),
  completed: e.boolean(),
});

const buildRegistry = (): ModelRegistry => {
  const r = new ModelRegistry();
  r.register(todo);
  return r;
};

/** One `replace` per declared field, the shape a create emits. */
const validUpdate = {
  id: "u_1",
  subject_id: "todo_1",
  component: "todo/title" as const,
  method: "replace" as const,
  data: { value: "Hello", update_id: "u_1", hlc: makeHlc(1711036800000) },
};

const buildAction = (updates: Action["updates"]): Action => ({
  id: "a_1",
  actor_id: "a_test",
  hlc: makeHlc(1711036800000),
  gsn: 0,
  updates,
});

describe("ModelRegistry register / get / has", () => {
  it("returns the same entity from get after register", () => {
    const r = new ModelRegistry();
    r.register(todo);
    expect(r.get("todo")).toBe(todo);
    expect(r.has("todo")).toBe(true);
  });

  it("returns undefined for unknown names", () => {
    const r = new ModelRegistry();
    expect(r.get("missing")).toBeUndefined();
    expect(r.has("missing")).toBe(false);
  });

  it("overwrites on duplicate register", () => {
    const r = new ModelRegistry();
    r.register(todo);
    const v2 = defineModel("todo", { name: e.string() });
    r.register(v2);
    expect(r.get("todo")).toBe(v2);
  });
});

describe("ModelRegistry.isLwwField", () => {
  it("reports a declared field on a registered entity as LWW", () => {
    expect(buildRegistry().isLwwField("todo", "title")).toBe(true);
  });

  it("defaults an unknown entity, an undeclared field, and a schema-less registry to LWW", () => {
    expect(buildRegistry().isLwwField("missing", "title")).toBe(true);
    expect(buildRegistry().isLwwField("todo", "missing")).toBe(true);
    expect(new ModelRegistry().isLwwField("todo", "title")).toBe(true);
  });
});

describe("ModelRegistry.validateAction", () => {
  it("returns empty for a valid registered action", () => {
    const r = buildRegistry();
    const action = buildAction([validUpdate]);
    expect(r.validateAction(action)).toEqual([]);
  });

  it("reports a component naming an unregistered model", () => {
    const r = buildRegistry();
    const action = buildAction([{ ...validUpdate, component: "list/title" }]);
    const v = r.validateAction(action);
    expect(v).toHaveLength(1);
    expect(v[0]?.entityName).toBe("(unknown)");
    expect(v[0]?.message).toMatch(/Unknown model "list" for component "list\/title"/);
  });

  it("reports unknown field names", () => {
    const r = buildRegistry();
    const action = buildAction([{ ...validUpdate, component: "todo/typo" }]);
    const v = r.validateAction(action);
    expect(v).toHaveLength(1);
    expect(v[0]?.entityName).toBe("todo");
    expect(v[0]?.field).toBe("typo");
    expect(v[0]?.updateIndex).toBe(0);
  });

  it("reports all violations across a mixed batch", () => {
    const r = buildRegistry();
    const action = buildAction([
      validUpdate,
      { ...validUpdate, component: "list/title" },
      { ...validUpdate, id: "u_3", component: "todo/bogus" },
    ]);
    const v = r.validateAction(action);
    expect(v).toHaveLength(2);
    const unknownType = v.find((x) => x.message.includes("Unknown model"));
    expect(unknownType?.updateIndex).toBe(1);
    const badField = v.find((x) => x.field === "bogus");
    expect(badField?.updateIndex).toBe(2);
  });

  it("skips fields check for delete updates (data === null)", () => {
    const r = buildRegistry();
    const action = buildAction([
      { id: "u_del", subject_id: "todo_1", method: "delete", data: null },
    ]);
    expect(r.validateAction(action)).toEqual([]);
  });
});

describe("ModelRegistry.validateFilter", () => {
  it("returns empty for an unfiltered query", () => {
    const r = buildRegistry();
    expect(r.validateFilter("todo", null)).toEqual([]);
    expect(r.validateFilter("todo", [])).toEqual([]);
    expect(r.validateFilter("todo", [{}])).toEqual([]);
  });

  it("returns empty for a filter with only declared fields", () => {
    const r = buildRegistry();
    expect(r.validateFilter("todo", [{ title: "x", completed: false }])).toEqual([]);
    expect(r.validateFilter("todo", [{ title: "x" }, { completed: null }])).toEqual([]);
  });

  it("reports unknown filter field names, naming the group", () => {
    const r = buildRegistry();
    const v = r.validateFilter("todo", [{ title: "x" }, { typo: "x" }]);
    expect(v).toHaveLength(1);
    expect(v[0]?.field).toBe("typo");
    expect(v[0]?.entityName).toBe("todo");
    expect(v[0]?.message).toContain("group 1");
  });

  it("rejects a null entry where a group is expected", () => {
    const r = buildRegistry();
    const v = r.validateFilter("todo", [null] as unknown as readonly Record<string, never>[]);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("group 0");
  });

  it("reports unknown entity type", () => {
    const r = buildRegistry();
    const v = r.validateFilter("list", [{ x: 1 }]);
    expect(v).toHaveLength(1);
    expect(v[0]?.entityName).toBe("(unknown)");
  });
});

describe("ModelRegistry.filterWarnings", () => {
  const defaulted = (): ModelRegistry => {
    const r = new ModelRegistry();
    r.register(
      defineModel("task", {
        title: e.string(),
        priority: e.string().default("normal"),
      }),
    );
    return r;
  };

  it("warns once when a filter compares a defaulted field but never its absence", () => {
    const r = defaulted();
    // Two groups, one warning: the warning is per field, not per match.
    const warnings = r.filterWarnings("task", [{ priority: "normal" }, { title: "x" }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.field).toBe("priority");
    expect(warnings[0]?.message).toContain("null");
  });

  it("is silent when any group carries the null term", () => {
    const r = defaulted();
    expect(r.filterWarnings("task", [{ priority: "normal" }, { priority: null }])).toEqual([]);
    expect(r.filterWarnings("task", [{ priority: null }])).toEqual([]);
  });

  it("is silent for a field without a default", () => {
    const r = defaulted();
    expect(r.filterWarnings("task", [{ title: "x" }])).toEqual([]);
  });

  it("is silent for an unfiltered query or an unknown entity", () => {
    const r = defaulted();
    expect(r.filterWarnings("task", null)).toEqual([]);
    expect(r.filterWarnings("task", [])).toEqual([]);
    expect(r.filterWarnings("task", [{}])).toEqual([]);
    expect(r.filterWarnings("nope", [{ priority: "normal" }])).toEqual([]);
  });
});

describe("EntityValidationError", () => {
  it("aggregates violations into one error", () => {
    const violations = [
      { entityName: "todo", field: "x", message: "bad x" },
      { entityName: "todo", field: "y", message: "bad y" },
    ];
    const err = new EntityValidationError(violations);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("EntityValidationError");
    expect(err.violations).toBe(violations);
    expect(err.message).toMatch(/2 violation/);
    expect(err.message).toMatch(/bad x/);
    expect(err.message).toMatch(/bad y/);
  });
});
