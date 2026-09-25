import { describe, it, expect } from "vitest";
import { makeHlc, type Action } from "@ebbjs/core";
import { EntityRegistry, EntityValidationError } from "./entity-registry";
import { defineEntity, e } from "./entity";

const todo = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
});

const buildRegistry = (): EntityRegistry => {
  const r = new EntityRegistry();
  r.register(todo);
  return r;
};

const validUpdate = {
  id: "u_1",
  subject_id: "todo_1",
  subject_type: "todo",
  method: "put" as const,
  data: {
    fields: {
      title: {
        value: "Hello",
        update_id: "u_1",
        hlc: makeHlc(1711036800000),
      },
      completed: {
        value: false,
        update_id: "u_1",
        hlc: makeHlc(1711036800000),
      },
    },
  },
};

const buildAction = (updates: Action["updates"]): Action => ({
  id: "a_1",
  actor_id: "a_test",
  hlc: makeHlc(1711036800000),
  gsn: 0,
  updates,
});

describe("EntityRegistry register / get / has", () => {
  it("returns the same entity from get after register", () => {
    const r = new EntityRegistry();
    r.register(todo);
    expect(r.get("todo")).toBe(todo);
    expect(r.has("todo")).toBe(true);
  });

  it("returns undefined for unknown names", () => {
    const r = new EntityRegistry();
    expect(r.get("missing")).toBeUndefined();
    expect(r.has("missing")).toBe(false);
  });

  it("overwrites on duplicate register", () => {
    const r = new EntityRegistry();
    r.register(todo);
    const v2 = defineEntity("todo", { name: e.string() });
    r.register(v2);
    expect(r.get("todo")).toBe(v2);
  });
});

describe("EntityRegistry.validateAction", () => {
  it("returns empty for a valid registered action", () => {
    const r = buildRegistry();
    const action = buildAction([validUpdate]);
    expect(r.validateAction(action)).toEqual([]);
  });

  it("reports unknown subject_type", () => {
    const r = buildRegistry();
    const action = buildAction([{ ...validUpdate, subject_type: "list" }]);
    const v = r.validateAction(action);
    expect(v).toHaveLength(1);
    expect(v[0]?.entityName).toBe("(unknown)");
    expect(v[0]?.message).toMatch(/Unknown subject_type: "list"/);
  });

  it("reports unknown field names", () => {
    const r = buildRegistry();
    const action = buildAction([
      {
        ...validUpdate,
        data: {
          fields: {
            typo: {
              value: "x",
              update_id: "u_1",
              hlc: makeHlc(1711036800000),
            },
          },
        },
      },
    ]);
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
      { ...validUpdate, subject_type: "list" },
      {
        ...validUpdate,
        id: "u_3",
        data: {
          fields: {
            bogus: {
              value: 1,
              update_id: "u_3",
              hlc: makeHlc(1711036800000),
            },
          },
        },
      },
    ]);
    const v = r.validateAction(action);
    expect(v).toHaveLength(2);
    const unknownType = v.find((x) => x.message.includes("Unknown subject_type"));
    expect(unknownType?.updateIndex).toBe(1);
    const badField = v.find((x) => x.field === "bogus");
    expect(badField?.updateIndex).toBe(2);
  });

  it("skips fields check for delete updates (data === null)", () => {
    const r = buildRegistry();
    const action = buildAction([
      {
        id: "u_del",
        subject_id: "todo_1",
        subject_type: "todo",
        method: "delete",
        data: null,
      },
    ]);
    expect(r.validateAction(action)).toEqual([]);
  });
});

describe("EntityRegistry.validateFilter", () => {
  it("returns empty for an empty filter", () => {
    const r = buildRegistry();
    expect(r.validateFilter("todo", {})).toEqual([]);
  });

  it("returns empty for a filter with only declared fields", () => {
    const r = buildRegistry();
    expect(r.validateFilter("todo", { title: "x", completed: false })).toEqual([]);
  });

  it("reports unknown filter field names", () => {
    const r = buildRegistry();
    const v = r.validateFilter("todo", { typo: "x" });
    expect(v).toHaveLength(1);
    expect(v[0]?.field).toBe("typo");
    expect(v[0]?.entityName).toBe("todo");
  });

  it("reports unknown entity type", () => {
    const r = buildRegistry();
    const v = r.validateFilter("list", { x: 1 });
    expect(v).toHaveLength(1);
    expect(v[0]?.entityName).toBe("(unknown)");
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
