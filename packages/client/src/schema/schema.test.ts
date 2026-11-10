/**
 * Tests for `defineSchema`.
 */

import { describe, it, expect } from "vitest";
import { makeHlc, type Action } from "@ebbjs/core";

import { defineModel, e } from "@ebbjs/schema";
import { ModelRegistry, EntityValidationError } from "@ebbjs/schema";
import { defineRelationship } from "@ebbjs/schema";
import { ReservedNameError } from "@ebbjs/schema";
import { defineSchema, UnregisteredRelationshipEndpointError, type Schema } from "@ebbjs/schema";
import { entityGroupSystemEntity, groupMemberSystemEntity, groupSystemEntity } from "@ebbjs/schema";

const todo = defineModel("todo", {
  title: e.string(),
  completed: e.boolean(),
});

const user = defineModel("user", {
  name: e.string(),
});

const group = groupSystemEntity;

const todo_ownedBy = defineRelationship({
  source: todo,
  target: group,
  as: "ownedBy",
  sourceCardinality: "many",
});

const relationshipsFixture = { todo_ownedBy } as const;

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

  it("exposes a runtime ModelRegistry on _registry with every entity registered", () => {
    const schema = defineSchema({
      models: { todo, user },
      version: 1,
    });
    expect(schema._registry).toBeInstanceOf(ModelRegistry);
    expect(schema._registry.has("todo")).toBe(true);
    expect(schema._registry.has("user")).toBe(true);
    expect(schema._registry.get("todo")).toBe(todo);
    expect(schema._registry.get("user")).toBe(user);
  });

  it("registers every relationship on the composed registry", () => {
    const schema = defineSchema({
      models: { todo },
      relationships: relationshipsFixture,
      version: 1,
    });
    const registered = schema._registry.getRelationship("todo", "ownedBy");
    expect(registered).toBeDefined();
    expect(registered?.source.name).toBe("todo");
    expect(registered?.target.name).toBe("group");
    expect(registered?.sourceCardinality).toBe("many");
  });

  it("accepts a relationships slot and threads it through the type", () => {
    const schema = defineSchema({
      models: { todo },
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

  it("preserves the typed inference of TEntities in Schema<TEntities, TRelationships>", () => {
    const schema = defineSchema({
      models: { todo },
      version: 1,
    });
    const fields: Schema<{ todo: typeof todo }>["models"]["todo"]["markers"] =
      schema.models.todo.markers;
    expect(fields.title.type).toBe("lww");
    expect(fields.completed.type).toBe("lww");
  });

  it("rejects actions with unknown field names through the composed registry", async () => {
    const schema = defineSchema({
      models: { todo },
      version: 1,
    });
    const hlc = makeHlc(1711036800000);
    const action: Action = {
      id: "a_1",
      actor_id: "a_test",
      hlc,
      gsn: 0,
      updates: [
        {
          id: "u_1_0",
          subject_id: "todo_1",
          component: "todo/typo",
          method: "replace",
          data: { value: "oops", update_id: "u_1", hlc },
        },
        {
          id: "u_1_1",
          subject_id: "todo_1",
          component: "todo/title",
          method: "replace",
          data: { value: "Hello", update_id: "u_1", hlc },
        },
      ],
    };
    const violations = schema._registry.validateAction(action);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.field).toBe("typo");
    expect(violations[0]?.entityName).toBe("todo");
    expect(() => {
      throw new EntityValidationError(violations);
    }).toThrow(EntityValidationError);
  });

  it("accepts a multi-entity action and validates every entity against the registry", () => {
    const schema = defineSchema({
      models: { todo, user },
      version: 1,
    });
    const hlc = makeHlc(1711036800000);
    const action: Action = {
      id: "a_1",
      actor_id: "a_test",
      hlc,
      gsn: 0,
      updates: [
        {
          id: "u_1_0",
          subject_id: "todo_1",
          component: "todo/title",
          method: "replace",
          data: { value: "Hi", update_id: "u_1", hlc },
        },
        {
          id: "u_1_1",
          subject_id: "todo_1",
          component: "todo/completed",
          method: "replace",
          data: { value: false, update_id: "u_1", hlc },
        },
        {
          id: "u_2_0",
          subject_id: "user_1",
          component: "user/name",
          method: "replace",
          data: { value: "Ada", update_id: "u_2", hlc },
        },
      ],
    };
    expect(schema._registry.validateAction(action)).toEqual([]);
  });

  it("flags components whose model isn't in the registry", () => {
    const schema = defineSchema({
      models: { todo },
      version: 1,
    });
    const hlc = makeHlc(1711036800000);
    const action: Action = {
      id: "a_1",
      actor_id: "a_test",
      hlc,
      gsn: 0,
      updates: [
        {
          id: "u_1_0",
          subject_id: "missing_1",
          component: "missing_entity/foo",
          method: "replace",
          data: { value: 1, update_id: "u_1", hlc },
        },
      ],
    };
    const violations = schema._registry.validateAction(action);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.entityName).toBe("(unknown)");
    expect(violations[0]?.message).toMatch(/Unknown model/);
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

describe("defineSchema materialization", () => {
  const page = defineModel("page", { title: e.string() });
  const pageContent = defineModel(
    "page_content",
    { content: e.map(e.string()) },
    { materialization: "on-demand" },
  );

  it("keeps each entity's declared materialization", () => {
    const schema = defineSchema({ models: { page, page_content: pageContent }, version: 1 });
    expect(schema.models.page.materialization).toBe("held");
    expect(schema.models.page_content.materialization).toBe("on-demand");
  });

  it("leaves system entities held", () => {
    const schema = defineSchema({ models: { page }, version: 1 });
    expect(schema._registry.get("relationship")?.materialization).toBe("held");
    expect(schema._registry.get("group")?.materialization).toBe("held");
  });
});

describe("defineSchema system entities + membership", () => {
  it("registers the system entities alongside user entities", () => {
    const schema = defineSchema({ models: { todo }, version: 1 });
    expect(schema._registry.has("relationship")).toBe(true);
    expect(schema._registry.has("group")).toBe(true);
    expect(schema._registry.has("groupMember")).toBe(true);
    expect(schema._registry.has("entityGroup")).toBe(true);
    expect(schema._registry.get("group")).toBe(groupSystemEntity);
    expect(schema._registry.get("groupMember")).toBe(groupMemberSystemEntity);
    expect(schema._registry.get("entityGroup")).toBe(entityGroupSystemEntity);
  });

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

  it("throws when a forward-many relationship's target is not registered", () => {
    const todo_labels = defineRelationship({
      source: todo,
      target: label,
      as: "labels",
      sourceCardinality: "many",
    });
    expect(() =>
      defineSchema({ models: { todo }, relationships: { todo_labels }, version: 1 }),
    ).toThrow(UnregisteredRelationshipEndpointError);
  });

  it("throws when a relationship's source is not registered", () => {
    const todo_label = defineRelationship({ source: todo, target: label, as: "label" });
    expect(() =>
      defineSchema({ models: { label }, relationships: { todo_label }, version: 1 }),
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

describe("defineSchema TypeBox shape axis", () => {
  it("exposes the implicit Type.Object wrapper as schema.models.X.shape", () => {
    const schema = defineSchema({
      models: { todo },
      version: 1,
    });
    expect(schema.models.todo.shape.type).toBe("object");
    expect(schema.models.todo.shape.properties).toEqual(
      expect.objectContaining({
        title: expect.objectContaining({ type: "string" }),
        completed: expect.objectContaining({ type: "boolean" }),
      }),
    );
  });

  it("exposes the derived FieldMarker map as schema.models.X.markers alongside shape", () => {
    const schema = defineSchema({
      models: { todo },
      version: 1,
    });
    // Marker axis: FieldMarker map derived from the field set.
    expect(schema.models.todo.markers).toEqual({
      title: { type: "lww" },
      completed: { type: "lww" },
    });
    // Shape axis: implicit Type.Object wrapper, separate projection.
    expect(schema.models.todo.shape.type).toBe("object");
    expect(schema.models.todo.shape).not.toBe(schema.models.todo.markers);
  });

  it("threads the shape and fields axes independently across multiple entities", () => {
    const schema = defineSchema({
      models: { todo, user },
      version: 1,
    });
    for (const entity of [todo, user]) {
      expect(schema.models[entity.name as "todo" | "user"].shape).toBe(entity.shape);
      expect(schema.models[entity.name as "todo" | "user"].markers).toBe(entity.markers);
    }
  });

  it("preserves the type-level reachability of Schema<TEntities, TRelationships>.entities.X.shape", () => {
    const schema = defineSchema({
      models: { todo },
      version: 1,
    });
    // Both axes are reachable at the type level without casting.
    const shape: typeof schema.models.todo.shape = schema.models.todo.shape;
    const fields: typeof schema.models.todo.markers = schema.models.todo.markers;
    expect(shape.type).toBe("object");
    expect(fields.title.type).toBe("lww");
  });
});
