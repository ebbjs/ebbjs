/**
 * `defineSchema` — composes per-entity and per-relationship definitions
 * into a single `Schema` value with a runtime `_registry` the SDK
 * consumes. The builder is pure (no I/O, no side effects beyond a
 * frozen return value) so it can be called at module top level and
 * shared across clients.
 *
 * These tests cover:
 * - Typed inference of `TEntities` / `TRelationships` through the
 *   public `Schema<TEntities, TRelationships>` shape.
 * - Composition of multiple entities + relationships produces a
 *   working registry.
 * - The `_registry` rejects unknown field names per #143's rules.
 */

import { describe, it, expect } from "vitest";
import { e, makeHlc, type Action } from "@ebbjs/core";

import { defineEntity } from "./entity";
import { EntityRegistry, EntityValidationError } from "./entity-registry";
import { defineSchema, type Schema } from "./schema";

const todo = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
});

const user = defineEntity("user", {
  name: e.string(),
});

// Relationships aren't a real primitive yet (#149's work). The
// builder accepts an open `Record<string, unknown>` for them so the
// slot composes through the same `_registry` shape; #149 will fill
// in the typed primitive.
const relationshipsFixture = {
  todo_ownedBy: { source: "todo", target: "group", cardinality: "many-to-one" },
} as const;

describe("defineSchema", () => {
  it("returns a frozen value with the declared entities and version", () => {
    const schema = defineSchema({
      entities: { todo, user },
      version: 2,
    });
    expect(Object.isFrozen(schema)).toBe(true);
    expect(schema.version).toBe(2);
    expect(schema.minSupportedVersion).toBeUndefined();
    expect(Object.keys(schema.entities)).toEqual(["todo", "user"]);
    expect(schema.entities.todo).toBe(todo);
    expect(schema.entities.user).toBe(user);
  });

  it("records minSupportedVersion when provided", () => {
    const schema = defineSchema({
      entities: { todo },
      version: 3,
      minSupportedVersion: 2,
    });
    expect(schema.version).toBe(3);
    expect(schema.minSupportedVersion).toBe(2);
  });

  it("exposes a runtime EntityRegistry on _registry with every entity registered", () => {
    const schema = defineSchema({
      entities: { todo, user },
      version: 1,
    });
    expect(schema._registry).toBeInstanceOf(EntityRegistry);
    expect(schema._registry.has("todo")).toBe(true);
    expect(schema._registry.has("user")).toBe(true);
    expect(schema._registry.get("todo")).toBe(todo);
    expect(schema._registry.get("user")).toBe(user);
  });

  it("accepts a relationships slot and threads it through the type", () => {
    const schema = defineSchema({
      entities: { todo },
      relationships: relationshipsFixture,
      version: 1,
    });
    // `schema.relationships` is the same shape we passed in — typing
    // preserves the relationship key set so downstream code can
    // index by relationship name.
    expect(schema.relationships).toEqual(relationshipsFixture);
    expect(schema.relationships?.todo_ownedBy).toEqual(relationshipsFixture.todo_ownedBy);
  });

  it("omits the relationships slot when not provided", () => {
    const schema = defineSchema({
      entities: { todo },
      version: 1,
    });
    expect(schema.relationships).toBeUndefined();
  });

  it("preserves the typed inference of TEntities in Schema<TEntities, TRelationships>", () => {
    const schema = defineSchema({
      entities: { todo },
      version: 1,
    });
    // Compile-time assertion: the entity def is reachable through
    // the generic, not narrowed to `unknown`.
    const fields: Schema<{ todo: typeof todo }>["entities"]["todo"]["fields"] =
      schema.entities.todo.fields;
    expect(fields.title.type).toBe("lww");
    expect(fields.completed.type).toBe("lww");
  });

  it("rejects actions with unknown field names through the composed registry", async () => {
    const schema = defineSchema({
      entities: { todo },
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
          id: "u_1",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "put",
          data: {
            fields: {
              // `typo` is not declared on the todo entity.
              typo: { value: "oops", update_id: "u_1", hlc },
              title: { value: "Hello", update_id: "u_1", hlc },
            },
          },
        },
      ],
    };
    const violations = schema._registry.validateAction(action);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.field).toBe("typo");
    expect(violations[0]?.entityName).toBe("todo");
    // The registry throws the same way the per-client registry does.
    expect(() => {
      if (violations.length > 0) throw new EntityValidationError(violations);
    }).toThrow(EntityValidationError);
  });

  it("accepts a multi-entity action and validates every entity against the registry", () => {
    const schema = defineSchema({
      entities: { todo, user },
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
          id: "u_1",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "put",
          data: {
            fields: {
              title: { value: "Hi", update_id: "u_1", hlc },
              completed: { value: false, update_id: "u_1", hlc },
            },
          },
        },
        {
          id: "u_2",
          subject_id: "user_1",
          subject_type: "user",
          method: "put",
          data: {
            fields: {
              name: { value: "Ada", update_id: "u_2", hlc },
            },
          },
        },
      ],
    };
    expect(schema._registry.validateAction(action)).toEqual([]);
  });

  it("flags updates whose subject_type isn't in the registry", () => {
    const schema = defineSchema({
      entities: { todo },
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
          id: "u_1",
          subject_id: "missing_1",
          subject_type: "missing_entity",
          method: "put",
          data: {
            fields: { foo: { value: 1, update_id: "u_1", hlc } },
          },
        },
      ],
    };
    const violations = schema._registry.validateAction(action);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.entityName).toBe("(unknown)");
    expect(violations[0]?.message).toMatch(/Unknown subject_type/);
  });

  it("two schemas share entities but build independent registries", () => {
    const a = defineSchema({ entities: { todo }, version: 1 });
    const b = defineSchema({ entities: { user }, version: 1 });
    expect(a._registry.has("todo")).toBe(true);
    expect(a._registry.has("user")).toBe(false);
    expect(b._registry.has("todo")).toBe(false);
    expect(b._registry.has("user")).toBe(true);
    // Distinct runtime instances so per-client wiring can mutate
    // their own registry without bleeding across clients.
    expect(a._registry).not.toBe(b._registry);
  });
});
