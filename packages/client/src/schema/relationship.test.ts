import { describe, it, expect } from "vitest";
import { defineModel, e } from "@ebbjs/schema";
import { defineRelationship } from "@ebbjs/schema";
import { ReservedNameError } from "@ebbjs/schema";
import { ModelRegistry, EntityValidationError } from "@ebbjs/schema";
import { normalizeManyPointers, normalizePointer } from "../sync/relationship";
import { createClient } from "../sync/client";
import type { Update } from "@ebbjs/core";

const todo = defineModel("todo", {
  title: e.string(),
  completed: e.boolean(),
});
const list = defineModel("list", { name: e.string() });

describe("defineRelationship", () => {
  it("returns a frozen value with source, target, as, sourceCardinality, type", () => {
    const rel = defineRelationship({ source: todo, target: list, as: "list" });
    expect(rel.source).toBe(todo);
    expect(rel.target).toBe(list);
    expect(rel.as).toBe("list");
    expect(rel.sourceCardinality).toBe("one");
    expect(rel.type).toBe("todo");
    expect(Object.isFrozen(rel)).toBe(true);
  });

  it("honors an explicit sourceCardinality", () => {
    const rel = defineRelationship({
      source: todo,
      target: list,
      as: "tags",
      sourceCardinality: "many",
    });
    expect(rel.sourceCardinality).toBe("many");
  });

  it("honors an explicit type override", () => {
    const rel = defineRelationship({
      source: todo,
      target: list,
      as: "list",
      type: "todo.belongsTo.list",
    });
    expect(rel.type).toBe("todo.belongsTo.list");
  });

  it("rejects the injected groups accessor name", () => {
    expect(() => defineRelationship({ source: todo, target: list, as: "groups" })).toThrow(
      ReservedNameError,
    );
    expect(() => defineRelationship({ source: todo, target: list, as: "groups" })).toThrow(
      /reserved/,
    );
  });
});

describe("ModelRegistry.registerRelationship", () => {
  it("returns a relationship by (sourceName, as)", () => {
    const r = new ModelRegistry();
    const rel = defineRelationship({ source: todo, target: list, as: "list" });
    r.registerRelationship(rel);
    // The registry returns a wire-level view reconstructed from the
    // stored fields — the names and cardinality match the original,
    // but the source/target field maps are empty (callers that need
    // field-level metadata should keep the original `defineRelationship`
    // reference). Compare on the wire-level surface.
    const found = r.getRelationship("todo", "list");
    expect(found?.as).toBe("list");
    expect(found?.sourceCardinality).toBe("one");
    expect(found?.type).toBe("todo");
    expect(found?.source.name).toBe("todo");
    expect(found?.target.name).toBe("list");
    expect(r.getRelationship("todo", "missing")).toBeUndefined();
  });

  it("lists relationships for a source", () => {
    const r = new ModelRegistry();
    const a = defineRelationship({ source: todo, target: list, as: "list" });
    const b = defineRelationship({
      source: todo,
      target: list,
      as: "tags",
      sourceCardinality: "many",
    });
    r.registerRelationship(a);
    r.registerRelationship(b);
    const fromTodo = r.getRelationshipsForSource("todo");
    expect(fromTodo).toHaveLength(2);
    expect(fromTodo.map((x) => x.as).sort()).toEqual(["list", "tags"]);
  });

  it("lists relationships for a target", () => {
    const r = new ModelRegistry();
    const a = defineRelationship({ source: todo, target: list, as: "list" });
    const b = defineRelationship({
      source: todo,
      target: list,
      as: "tags",
      sourceCardinality: "many",
    });
    r.registerRelationship(a);
    r.registerRelationship(b);
    expect(r.getRelationshipsForTarget("list")).toHaveLength(2);
    expect(r.getRelationshipsForTarget("todo")).toEqual([]);
  });

  it("re-registering the same (source, as) overwrites and reports overwritten:true", () => {
    const r = new ModelRegistry();
    const v1 = defineRelationship({ source: todo, target: list, as: "list" });
    const v2 = defineRelationship({
      source: todo,
      target: list,
      as: "list",
      sourceCardinality: "many",
    });
    expect(r.registerRelationship(v1)).toEqual({ overwritten: false });
    const result = r.registerRelationship(v2);
    expect(result.overwritten).toBe(true);
    expect(result.previousCardinality).toBe("one");
    expect(r.getRelationship("todo", "list")?.sourceCardinality).toBe("many");
  });
});

describe("ModelRegistry.isEmpty", () => {
  it("is true only until a model or a relationship is registered", () => {
    expect(new ModelRegistry().isEmpty()).toBe(true);

    const withModel = new ModelRegistry();
    withModel.register(todo);
    expect(withModel.isEmpty()).toBe(false);

    const withRelationship = new ModelRegistry();
    withRelationship.registerRelationship(
      defineRelationship({ source: todo, target: list, as: "list" }),
    );
    expect(withRelationship.isEmpty()).toBe(false);
  });
});

describe("normalizePointer", () => {
  it("returns the same string when given a non-empty string id", () => {
    expect(normalizePointer("todo_1", "test")).toBe("todo_1");
  });

  it("returns null for null or undefined", () => {
    expect(normalizePointer(null, "test")).toBeNull();
    expect(normalizePointer(undefined, "test")).toBeNull();
  });

  it("extracts .id from an entity-shape object", () => {
    expect(normalizePointer({ id: "todo_5" }, "test")).toBe("todo_5");
  });

  it("throws on empty string", () => {
    expect(() => normalizePointer("", "test")).toThrow();
  });

  it("throws on an object without a string .id", () => {
    expect(() => normalizePointer({ id: 42 }, "test")).toThrow();
    expect(() => normalizePointer({}, "test")).toThrow();
  });

  it("throws on numbers, booleans, etc.", () => {
    expect(() => normalizePointer(42, "test")).toThrow();
    expect(() => normalizePointer(true, "test")).toThrow();
  });
});

describe("normalizeManyPointers", () => {
  it("flattens replace into a de-duplicated id list", () => {
    expect(normalizeManyPointers({ replace: ["a", "b", "a", { id: "c" }] }, "test")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("concatenates add and remove into a de-duplicated list", () => {
    expect(normalizeManyPointers({ add: ["a"], remove: ["b", "c"] }, "test")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("rejects null entries", () => {
    expect(() => normalizeManyPointers({ replace: ["a", null] }, "test")).toThrow();
  });
});

describe("buildRelationshipWrite (SyncClient)", () => {
  const buildEntityUpdate = (id: string, fields: Record<string, unknown> = {}): Update => {
    const [field, value] = Object.entries({ title: "Ship it", ...fields })[0]!;
    return {
      id: "u_e",
      subject_id: id,
      component: `todo/${field}`,
      method: "replace",
      data: { value, update_id: "u_e" },
    };
  };

  it("produces a put relationship update for one-cardinality with a string id", () => {
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      registry: (() => {
        const r = new ModelRegistry();
        r.register(todo);
        r.register(list);
        r.registerRelationship(defineRelationship({ source: todo, target: list, as: "list" }));
        return r;
      })(),
    });

    // One-cardinality: no entityUpdate; the FK lives on the
    // Relationship Update, not the source's data fields.
    const result = client.buildRelationshipWrite({
      source: todo,
      target: list,
      as: "list",
      sourceId: "todo_1",
      targetId: "list_1",
    });

    expect(result.entityUpdate).toBeUndefined();
    expect(result.relationshipUpdates).toHaveLength(4);
    const value = (field: string): unknown => {
      const update = result.relationshipUpdates.find(
        (u) => u.method !== "delete" && u.component === `relationship/${field}`,
      )!;
      return (update.data as { value: unknown } | null)?.value;
    };
    expect(value("source_id")).toBe("todo_1");
    expect(value("target_id")).toBe("list_1");
    expect(value("field")).toBe("list");
    expect(value("type")).toBe("todo");
  });

  it("produces a delete relationship update for one-cardinality with null targetId", () => {
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      registry: (() => {
        const r = new ModelRegistry();
        r.register(todo);
        r.register(list);
        r.registerRelationship(defineRelationship({ source: todo, target: list, as: "list" }));
        return r;
      })(),
    });

    const result = client.buildRelationshipWrite({
      source: todo,
      target: list,
      as: "list",
      sourceId: "todo_1",
      targetId: null,
    });

    expect(result.entityUpdate).toBeUndefined();
    expect(result.relationshipUpdates).toHaveLength(1);
    expect(result.relationshipUpdates[0]!.method).toBe("delete");
  });

  it("normalizes an entity-shape pointer to its .id", () => {
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      registry: (() => {
        const r = new ModelRegistry();
        r.register(todo);
        r.register(list);
        r.registerRelationship(defineRelationship({ source: todo, target: list, as: "list" }));
        return r;
      })(),
    });

    const result = client.buildRelationshipWrite({
      source: todo,
      target: list,
      as: "list",
      sourceId: "todo_1",
      targetId: { id: "list_99" },
    });
    const target = result.relationshipUpdates.find(
      (u) => u.method !== "delete" && u.component === "relationship/target_id",
    )!;
    expect((target.data as { value: unknown } | null)?.value).toBe("list_99");
  });

  it("throws EntityValidationError when the source entity is not registered", () => {
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      registry: (() => {
        const r = new ModelRegistry();
        // Only `list` is registered — `todo` is not.
        r.register(list);
        r.registerRelationship(defineRelationship({ source: todo, target: list, as: "list" }));
        return r;
      })(),
    });

    let caught: unknown;
    try {
      client.buildRelationshipWrite({
        source: todo,
        target: list,
        as: "list",
        sourceId: "todo_1",
        targetId: "list_1",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EntityValidationError);
    expect((caught as EntityValidationError).violations[0]?.message).toMatch(
      /source entity "todo" is not registered/,
    );
  });

  it("does NOT throw when the target entity is not registered (server validates)", () => {
    // The target is a wire-level id reference; the server validates
    // its existence at write time. The ownedBy pattern (a source
    // pointing at a group) doesn't have a registered target.
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      registry: (() => {
        const r = new ModelRegistry();
        r.register(todo);
        // `list` not registered on purpose.
        r.registerRelationship(defineRelationship({ source: todo, target: list, as: "list" }));
        return r;
      })(),
    });

    expect(() =>
      client.buildRelationshipWrite({
        source: todo,
        target: list,
        as: "list",
        sourceId: "todo_1",
        targetId: "list_1",
      }),
    ).not.toThrow();
  });

  it("produces multiple put relationship updates for many-cardinality replace", () => {
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      registry: (() => {
        const r = new ModelRegistry();
        r.register(todo);
        r.register(list);
        r.registerRelationship(
          defineRelationship({
            source: todo,
            target: list,
            as: "tags",
            sourceCardinality: "many",
          }),
        );
        return r;
      })(),
    });

    const result = client.buildRelationshipWrite({
      source: todo,
      target: list,
      as: "tags",
      entityUpdate: buildEntityUpdate("todo_1"),
      targetIds: { replace: ["list_1", "list_2", { id: "list_3" }] },
    });

    const rows = new Map<string, readonly Update[]>();
    for (const update of result.relationshipUpdates) {
      rows.set(update.subject_id, [...(rows.get(update.subject_id) ?? []), update]);
    }
    expect(rows.size).toBe(3);
    const targets = [...rows.values()]
      .map(
        (row) =>
          (
            row.find((u) => u.method !== "delete" && u.component === "relationship/target_id")!
              .data as { value: unknown } | null
          )?.value,
      )
      .sort();
    expect(targets).toEqual(["list_1", "list_2", "list_3"]);
  });

  it("defers the permission check to write() rather than throwing in the builder", async () => {
    // The builder only shapes the wire Update; an actor without
    // `<source_type>.update` gets a `PermissionError` from `write()`.
    const fetchImpl = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          actor_id: "actor_1",
          groups: [
            {
              id: "g_1",
              permissions: ["todo.read"],
              cursor_valid: true,
              reason: null,
              cursor: 0,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      fetchImpl,
      registry: (() => {
        const r = new ModelRegistry();
        r.register(todo);
        r.register(list);
        r.registerRelationship(defineRelationship({ source: todo, target: list, as: "list" }));
        return r;
      })(),
    });

    await client.handshake();
    expect(() =>
      client.buildRelationshipWrite({
        source: todo,
        target: list,
        as: "list",
        sourceId: "todo_1",
        targetId: "list_1",
      }),
    ).not.toThrow();
  });
});

describe("buildRelationshipWrite: registry cardinality lookup", () => {
  it("infers cardinality from the registry when sourceCardinality is omitted", () => {
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      registry: (() => {
        const r = new ModelRegistry();
        r.register(todo);
        r.register(list);
        r.registerRelationship(
          defineRelationship({
            source: todo,
            target: list,
            as: "tags",
            sourceCardinality: "many",
          }),
        );
        return r;
      })(),
    });

    // Registry says "many"; no targetIds passed -> empty
    // relationship-update array (no-op, the developer can still
    // write the entity update alone).
    const result = client.buildRelationshipWrite({
      source: todo,
      target: list,
      as: "tags",
      entityUpdate: {
        id: "u_e",
        subject_id: "todo_1",
        component: "todo/tags",
        method: "merge",
        data: { value: [], update_id: "u_e" },
      },
    });

    expect(result.relationshipUpdates).toEqual([]);
  });
});
