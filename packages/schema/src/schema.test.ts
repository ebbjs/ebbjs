/**
 * Tests for `defineSchema` — the composition of models, relationships, system
 * entities, and reserved names into one frozen `Schema` value.
 */

import { describe, it, expect } from "vitest";

import {
  defineModel,
  defineRelationship,
  defineSchema,
  e,
  entityGroupSystemEntity,
  groupMemberSystemEntity,
  groupSystemEntity,
  ModelKeyMismatchError,
  ModelRegistry,
  RESERVED_ENTITY_NAMES,
  ReservedNameError,
  UnregisteredRelationshipEndpointError,
} from "./index";

const project = defineModel("project", { name: e.string() });
const issue = defineModel("issue", {
  title: e.string(),
  project: e.string().default(""),
});
const todo = defineModel("todo", {
  title: e.string(),
  completed: e.boolean(),
});
const user = defineModel("user", { name: e.string() });

const issue_belongsTo = defineRelationship({ source: issue, target: project, as: "project" });
const todo_ownedBy = defineRelationship({
  source: todo,
  target: groupSystemEntity,
  as: "ownedBy",
  sourceCardinality: "many",
});

const relationshipsFixture = { issue_belongsTo, todo_ownedBy } as const;

describe("defineSchema", () => {
  it("returns a frozen value with the declared entities and version", () => {
    const schema = defineSchema({
      models: { todo, user },
      version: 2,
    });
    expect(Object.isFrozen(schema)).toBe(true);
    expect(schema.version).toBe(2);
    expect(schema.minSupportedVersion).toBeUndefined();
    expect(Object.keys(schema.models)).toEqual(["todo", "user"]);
    expect(schema.models.todo).toBe(todo);
    expect(schema.models.user).toBe(user);
  });

  it("records minSupportedVersion when provided", () => {
    const schema = defineSchema({
      models: { todo },
      version: 3,
      minSupportedVersion: 2,
    });
    expect(schema.version).toBe(3);
    expect(schema.minSupportedVersion).toBe(2);
  });

  it("produces exactly the models and relationships it was given", () => {
    const schema = defineSchema({
      models: { project, issue, todo, user },
      relationships: relationshipsFixture,
      version: 1,
    });

    expect(Object.keys(schema.models).sort()).toEqual(["issue", "project", "todo", "user"]);
    expect(Object.keys(schema.relationships ?? {}).sort()).toEqual([
      "issue_belongsTo",
      "todo_ownedBy",
    ]);
    // The system entities are the app's too: resolveRelationship and the
    // membership write path address them by name.
    expect([...schema._registry.modelNames()].sort()).toEqual(
      [...RESERVED_ENTITY_NAMES, "issue", "project", "todo", "user"].sort(),
    );
  });

  it("rejects a model map key that differs from the definition's name", () => {
    expect(() => defineSchema({ models: { task: issue }, version: 1 })).toThrow(
      ModelKeyMismatchError,
    );
    expect(() => defineSchema({ models: { task: issue }, version: 1 })).toThrow(
      /does not match the definition's name "issue"/,
    );
  });

  it("two schemas share entities but build independent registries", () => {
    const a = defineSchema({ models: { todo }, version: 1 });
    const b = defineSchema({ models: { user }, version: 1 });
    expect(a._registry.has("todo")).toBe(true);
    expect(a._registry.has("user")).toBe(false);
    expect(b._registry.has("todo")).toBe(false);
    expect(b._registry.has("user")).toBe(true);
    // Distinct runtime instances so per-client wiring can mutate
    // their own registry without bleeding across clients.
    expect(a._registry).not.toBe(b._registry);
  });
});

describe("defineSchema registry", () => {
  it("exposes a runtime ModelRegistry with every model and system entity registered", () => {
    const schema = defineSchema({
      models: { todo, user },
      version: 1,
    });
    expect(schema._registry).toBeInstanceOf(ModelRegistry);
    expect(schema._registry.has("todo")).toBe(true);
    expect(schema._registry.has("user")).toBe(true);
    expect(schema._registry.get("todo")).toBe(todo);
    expect(schema._registry.get("user")).toBe(user);
    expect(schema._registry.get("group")).toBe(groupSystemEntity);
    expect(schema._registry.get("groupMember")).toBe(groupMemberSystemEntity);
    expect(schema._registry.get("entityGroup")).toBe(entityGroupSystemEntity);
  });

  it("registers every declared relationship on the composed registry", () => {
    const schema = defineSchema({
      models: { project, issue, todo },
      relationships: relationshipsFixture,
      version: 1,
    });

    const belongsTo = schema._registry.getRelationship("issue", "project");
    expect(belongsTo?.source.name).toBe("issue");
    expect(belongsTo?.target.name).toBe("project");
    expect(belongsTo?.sourceCardinality).toBe("one");

    const ownedBy = schema._registry.getRelationship("todo", "ownedBy");
    expect(ownedBy?.source.name).toBe("todo");
    expect(ownedBy?.target.name).toBe("group");
    expect(ownedBy?.sourceCardinality).toBe("many");
  });

  it("accepts a relationships slot and threads it through the type", () => {
    const schema = defineSchema({
      models: { project, issue, todo },
      relationships: relationshipsFixture,
      version: 1,
    });
    expect(schema.relationships).toEqual(relationshipsFixture);
    expect(schema.relationships?.todo_ownedBy).toEqual(todo_ownedBy);
  });

  it("omits the relationships slot when not provided", () => {
    const schema = defineSchema({
      models: { todo },
      version: 1,
    });
    expect(schema.relationships).toBeUndefined();
    expect(schema._registry.getRelationship("todo", "ownedBy")).toBeUndefined();
  });
});

describe("defineSchema materialization", () => {
  const page = defineModel("page", { title: e.string() });

  it("leaves system entities held", () => {
    const schema = defineSchema({ models: { page }, version: 1 });
    expect(schema._registry.get("relationship")?.materialization).toBe("held");
    expect(schema._registry.get("group")?.materialization).toBe("held");
  });
});

describe("defineSchema system entities + membership", () => {
  it("does not inject a groups relationship for user entities", () => {
    const schema = defineSchema({ models: { todo, user }, version: 1 });
    for (const name of ["todo", "user"] as const) {
      expect(schema._registry.getRelationship(name, "groups")).toBeUndefined();
    }
  });

  it("rejects an app entity that collides with a system entity name", () => {
    expect(() => defineSchema({ models: { group: groupSystemEntity }, version: 1 })).toThrow(
      ReservedNameError,
    );
    expect(() =>
      defineSchema({ models: { entityGroup: entityGroupSystemEntity }, version: 1 }),
    ).toThrow(ReservedNameError);
  });

  it("rejects an app relationship that collides with the groups accessor", () => {
    const colliding = {
      source: todo,
      target: groupSystemEntity,
      as: "groups",
      sourceCardinality: "many" as const,
      type: "todo",
    };
    expect(() =>
      defineSchema({ models: { todo }, relationships: { bad: colliding }, version: 1 }),
    ).toThrow(ReservedNameError);
  });
});

describe("defineSchema relationship endpoint validation", () => {
  const label = defineModel("label", { name: e.string() });

  it("throws when a forward-one relationship's target is not registered", () => {
    const todo_label = defineRelationship({ source: todo, target: label, as: "label" });
    expect(() =>
      defineSchema({ models: { todo }, relationships: { todo_label }, version: 1 }),
    ).toThrow(UnregisteredRelationshipEndpointError);
  });

  it("names the missing endpoint, the accessor, and the models map in the message", () => {
    const todo_labels = defineRelationship({
      source: todo,
      target: label,
      as: "labels",
      sourceCardinality: "many",
    });
    let caught: unknown;
    try {
      defineSchema({ models: { todo }, relationships: { todo_labels }, version: 1 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnregisteredRelationshipEndpointError);
    const error = caught as UnregisteredRelationshipEndpointError;
    expect(error.entityName).toBe("label");
    expect(error.role).toBe("target");
    expect(error.accessor).toBe("labels");
    expect(error.message).toContain('"label"');
    expect(error.message).toContain('"labels"');
    expect(error.message).toContain('"models"');
  });

  it("accepts a relationship whose target is a system entity", () => {
    const todo_ownedBy = defineRelationship({
      source: todo,
      target: groupSystemEntity,
      as: "ownedBy",
      sourceCardinality: "many",
    });
    const schema = defineSchema({
      models: { todo },
      relationships: { todo_ownedBy },
      version: 1,
    });
    expect(schema._registry.getRelationship("todo", "ownedBy")).toBeDefined();
  });

  it("accepts a relationship whose source is a system entity", () => {
    const group_todos = defineRelationship({
      source: groupSystemEntity,
      target: todo,
      as: "todos",
      sourceCardinality: "many",
    });
    const schema = defineSchema({
      models: { todo },
      relationships: { group_todos },
      version: 1,
    });
    expect(schema._registry.getRelationship("group", "todos")).toBeDefined();
  });

  it("reports the source when the source is the missing endpoint", () => {
    const todo_label = defineRelationship({ source: todo, target: label, as: "label" });
    let caught: unknown;
    try {
      defineSchema({ models: { label }, relationships: { todo_label }, version: 1 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnregisteredRelationshipEndpointError);
    const error = caught as UnregisteredRelationshipEndpointError;
    expect(error.entityName).toBe("todo");
    expect(error.role).toBe("source");
  });
});
