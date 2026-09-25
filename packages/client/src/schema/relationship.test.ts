import { describe, it, expect } from "vitest";
import { defineEntity, e } from "./entity";
import { defineRelationship, type RelationshipDef } from "./relationship";
import { EntityRegistry, EntityValidationError } from "./entity-registry";
import {
  buildRelationshipUpdate,
  normalizeManyPointers,
  normalizePointer,
} from "../sync/relationship";
import { createClient } from "../sync/client";
import type { Update } from "@ebbjs/core";

const todo = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
  list: e.string(),
});
const list = defineEntity("list", { name: e.string() });

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

  it("flows S and T into RelationshipDef<S, T> via inference", () => {
    const rel = defineRelationship({ source: todo, target: list, as: "list" });
    type Inferred = RelationshipDef<typeof todo, typeof list>;
    const typed: Inferred = rel;
    expect(typed.source.name).toBe("todo");
    expect(typed.target.name).toBe("list");
  });
});

describe("EntityRegistry.registerRelationship", () => {
  it("returns a relationship by (sourceName, as)", () => {
    const r = new EntityRegistry();
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
    const r = new EntityRegistry();
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
    const r = new EntityRegistry();
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
    const r = new EntityRegistry();
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

describe("EntityRegistry.isEmpty", () => {
  it("is true for a fresh registry", () => {
    const r = new EntityRegistry();
    expect(r.isEmpty()).toBe(true);
  });

  it("is false after registering an entity", () => {
    const r = new EntityRegistry();
    r.register(todo);
    expect(r.isEmpty()).toBe(false);
  });

  it("is false after registering a relationship", () => {
    const r = new EntityRegistry();
    r.registerRelationship(defineRelationship({ source: todo, target: list, as: "list" }));
    expect(r.isEmpty()).toBe(false);
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

describe("buildRelationshipUpdate", () => {
  it("produces a put Update with source_id, target_id, type, field", () => {
    const u = buildRelationshipUpdate({
      relationshipId: "rel_1",
      sourceId: "todo_1",
      targetId: "list_1",
      field: "list",
      type: "todo",
      updateId: "u_1",
    });
    expect(u.id).toBe("u_1");
    expect(u.subject_id).toBe("rel_1");
    expect(u.subject_type).toBe("relationship");
    expect(u.method).toBe("put");
    expect(u.data?.fields.source_id.value).toBe("todo_1");
    expect(u.data?.fields.target_id.value).toBe("list_1");
    expect(u.data?.fields.type.value).toBe("todo");
    expect(u.data?.fields.field.value).toBe("list");
  });

  it("produces a delete Update when targetId is null", () => {
    const u = buildRelationshipUpdate({
      relationshipId: "rel_1",
      sourceId: "todo_1",
      targetId: null,
      field: "list",
      type: "todo",
      updateId: "u_1",
    });
    expect(u.method).toBe("delete");
    expect(u.data).toBeNull();
  });
});

describe("buildRelationshipWrite (SyncClient)", () => {
  const buildEntityUpdate = (id: string, fields: Record<string, unknown> = {}): Update => ({
    id: "u_e",
    subject_id: id,
    subject_type: "todo",
    method: "put",
    data: {
      fields: {
        title: { value: "Ship it", update_id: "u_e" },
        ...Object.fromEntries(
          Object.entries(fields).map(([k, v]) => [k, { value: v, update_id: "u_e" }]),
        ),
      },
    },
  });

  it("produces a put relationship update for one-cardinality with a string id", () => {
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      registry: (() => {
        const r = new EntityRegistry();
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
      entityUpdate: buildEntityUpdate("todo_1"),
      targetId: "list_1",
    });

    expect(result.entityUpdate.subject_id).toBe("todo_1");
    expect(result.entityUpdate.subject_type).toBe("todo");
    // The `list` field was stripped from the entity update — it
    // lives on the relationship update, not the entity update.
    expect("list" in (result.entityUpdate.data?.fields ?? {})).toBe(false);
    expect(result.entityUpdate.data?.fields.title.value).toBe("Ship it");

    const relUpdates = Array.isArray(result.relationshipUpdate)
      ? result.relationshipUpdate
      : [result.relationshipUpdate];
    expect(relUpdates).toHaveLength(1);
    const rel = relUpdates[0]!;
    expect(rel.method).toBe("put");
    expect(rel.subject_type).toBe("relationship");
    expect(rel.data?.fields.target_id.value).toBe("list_1");
    expect(rel.data?.fields.field.value).toBe("list");
    expect(rel.data?.fields.type.value).toBe("todo");
  });

  it("produces a delete relationship update for one-cardinality with null targetId", () => {
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      registry: (() => {
        const r = new EntityRegistry();
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
      entityUpdate: buildEntityUpdate("todo_1"),
      targetId: null,
    });

    const relUpdates = Array.isArray(result.relationshipUpdate)
      ? result.relationshipUpdate
      : [result.relationshipUpdate];
    expect(relUpdates).toHaveLength(1);
    expect(relUpdates[0]!.method).toBe("delete");
  });

  it("normalizes an entity-shape pointer to its .id", () => {
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      registry: (() => {
        const r = new EntityRegistry();
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
      entityUpdate: buildEntityUpdate("todo_1"),
      targetId: { id: "list_99" },
    });
    const relUpdates = Array.isArray(result.relationshipUpdate)
      ? result.relationshipUpdate
      : [result.relationshipUpdate];
    expect(relUpdates[0]!.data?.fields.target_id.value).toBe("list_99");
  });

  it("rejects a non-id, non-entity pointer value", () => {
    // The validate-before-encode stance rejects anything that isn't
    // a string id or an entity-shape object. The unit-level check
    // lives in `normalizePointer` (covered above); here we pin that
    // buildRelationshipWrite propagates the same error type.
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      registry: (() => {
        const r = new EntityRegistry();
        r.register(todo);
        r.register(list);
        r.registerRelationship(defineRelationship({ source: todo, target: list, as: "list" }));
        return r;
      })(),
    });

    expect(() =>
      client.buildRelationshipWrite({
        source: todo,
        target: list,
        as: "list",
        entityUpdate: buildEntityUpdate("todo_1"),
        targetId: 42 as unknown as string,
      }),
    ).toThrow();
  });

  it("throws EntityValidationError when the source entity is not registered", () => {
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      registry: (() => {
        const r = new EntityRegistry();
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
        entityUpdate: buildEntityUpdate("todo_1"),
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
        const r = new EntityRegistry();
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
        entityUpdate: buildEntityUpdate("todo_1"),
        targetId: "list_1",
      }),
    ).not.toThrow();
  });

  it("produces multiple put relationship updates for many-cardinality replace", () => {
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      registry: (() => {
        const r = new EntityRegistry();
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

    const relUpdates = Array.isArray(result.relationshipUpdate)
      ? result.relationshipUpdate
      : [result.relationshipUpdate];
    expect(relUpdates).toHaveLength(3);
    expect(relUpdates.every((u) => u.method === "put")).toBe(true);
    const targets = relUpdates.map((u) => u.data?.fields.target_id.value).sort();
    expect(targets).toEqual(["list_1", "list_2", "list_3"]);
  });

  it("runs the client-side early permission check", async () => {
    // Stub fetch to return a handshake response with groups that
    // grant `todo.update`. The early check should pass.
    const fetchImpl = (async (_url: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ cursors: {}, schema_version: undefined });
      return new Response(
        JSON.stringify({
          actor_id: "actor_1",
          groups: [
            {
              id: "g_1",
              permissions: ["todo.update"],
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
        const r = new EntityRegistry();
        r.register(todo);
        r.register(list);
        r.registerRelationship(defineRelationship({ source: todo, target: list, as: "list" }));
        return r;
      })(),
    });

    await client.handshake();
    // No throw — the actor has `todo.update` in their group.
    expect(() =>
      client.buildRelationshipWrite({
        source: todo,
        target: list,
        as: "list",
        entityUpdate: buildEntityUpdate("todo_1"),
        targetId: "list_1",
      }),
    ).not.toThrow();
  });

  it("throws EntityValidationError when the actor's known groups lack <source_type>.update", async () => {
    // Stub fetch to return a handshake response with groups that
    // grant only `todo.read` — the early check should reject.
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
        const r = new EntityRegistry();
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
        entityUpdate: buildEntityUpdate("todo_1"),
        targetId: "list_1",
      }),
    ).toThrow(EntityValidationError);
  });

  it("accepts the wildcard permission <source_type>.*", async () => {
    const fetchImpl = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          actor_id: "actor_1",
          groups: [
            {
              id: "g_1",
              permissions: ["todo.*"],
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
        const r = new EntityRegistry();
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
        entityUpdate: buildEntityUpdate("todo_1"),
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
        const r = new EntityRegistry();
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
        subject_type: "todo",
        method: "put",
        data: { fields: {} },
      },
    });

    expect(Array.isArray(result.relationshipUpdate)).toBe(true);
    expect(result.relationshipUpdate).toEqual([]);
  });
});

describe("QueryBuilder (sync/relationship)", () => {
  const buildEntity = (
    id: string,
    fields: Record<string, unknown>,
  ): import("@ebbjs/core").Entity => ({
    id,
    type: "todo",
    data: {
      fields: Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [k, { value: v, update_id: "u" }]),
      ),
    },
    created_hlc: "1",
    updated_hlc: "1",
    deleted_hlc: null,
    last_gsn: 0,
  });

  it("eq filters by field equality", async () => {
    const { buildQueryBuilder } = await import("../sync/relationship");
    const rows = [
      buildEntity("1", { title: "a", completed: false }),
      buildEntity("2", { title: "b", completed: true }),
      buildEntity("3", { title: "c", completed: false }),
    ];
    const out = await buildQueryBuilder(rows, todo.shape).eq("completed", false);
    expect(out.map((r) => r.title)).toEqual(["a", "c"]);
  });

  it("orderBy sorts by field", async () => {
    const { buildQueryBuilder } = await import("../sync/relationship");
    const rows = [
      buildEntity("1", { title: "banana", completed: false }),
      buildEntity("2", { title: "apple", completed: false }),
      buildEntity("3", { title: "cherry", completed: false }),
    ];
    const out = await buildQueryBuilder(rows, todo.shape).orderBy("title", "asc");
    expect(out.map((r) => r.title)).toEqual(["apple", "banana", "cherry"]);
  });

  it("limit caps the result count", async () => {
    const { buildQueryBuilder } = await import("../sync/relationship");
    const rows = [
      buildEntity("1", { title: "a", completed: false }),
      buildEntity("2", { title: "b", completed: false }),
      buildEntity("3", { title: "c", completed: false }),
    ];
    const out = await buildQueryBuilder(rows, todo.shape).limit(2);
    expect(out.map((r) => r.title)).toEqual(["a", "b"]);
  });

  it("chains eq + orderBy + limit", async () => {
    const { buildQueryBuilder } = await import("../sync/relationship");
    const rows = [
      buildEntity("1", { title: "a", completed: false }),
      buildEntity("2", { title: "b", completed: true }),
      buildEntity("3", { title: "c", completed: true }),
      buildEntity("4", { title: "d", completed: true }),
    ];
    const out = await buildQueryBuilder(rows, todo.shape)
      .eq("completed", true)
      .orderBy("title", "desc")
      .limit(2);
    expect(out.map((r) => r.title)).toEqual(["d", "c"]);
  });

  it("chains return new builders (no shared state)", async () => {
    const { buildQueryBuilder } = await import("../sync/relationship");
    const rows = [
      buildEntity("1", { title: "a", completed: false }),
      buildEntity("2", { title: "b", completed: true }),
    ];
    const base = buildQueryBuilder(rows, todo.shape);
    const a = base.eq("completed", true);
    const b = base.eq("completed", false);
    // `base` is untouched; both `a` and `b` carry their own filter.
    expect((await a).map((r) => r.title)).toEqual(["b"]);
    expect((await b).map((r) => r.title)).toEqual(["a"]);
    // And awaiting the base again returns everything.
    expect((await base).map((r) => r.title).sort()).toEqual(["a", "b"]);
  });
});

describe("relationship() handle traversal", () => {
  const mkEntity = (
    id: string,
    type: string,
    fields: Record<string, unknown>,
  ): import("@ebbjs/core").Entity => ({
    id,
    type,
    data: {
      fields: Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [k, { value: v, update_id: "u" }]),
      ),
    },
    created_hlc: "1",
    updated_hlc: "1",
    deleted_hlc: null,
    last_gsn: 0,
  });

  it("forward(id) returns the target entity for sourceCardinality:one", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("list_1", "list", { name: "Today" }));
    await storage.entities.set(mkEntity("todo_1", "todo", { title: "Ship", list: "list_1" }));

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage,
      registry: (() => {
        const r = new EntityRegistry();
        r.register(todo);
        r.register(list);
        r.registerRelationship(defineRelationship({ source: todo, target: list, as: "list" }));
        return r;
      })(),
    });

    const handle = client.relationship({ source: todo, target: list, as: "list" });
    const result = await (handle.forward("todo_1") as Promise<
      import("@ebbjs/core").Entity | undefined
    >);
    expect(result?.id).toBe("list_1");
  });

  it("forward(id) returns undefined when the source has no pointer", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("todo_1", "todo", { title: "Ship" }));

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage,
      registry: (() => {
        const r = new EntityRegistry();
        r.register(todo);
        r.register(list);
        r.registerRelationship(defineRelationship({ source: todo, target: list, as: "list" }));
        return r;
      })(),
    });

    const handle = client.relationship({ source: todo, target: list, as: "list" });
    const result = await (handle.forward("todo_1") as Promise<
      import("@ebbjs/core").Entity | undefined
    >);
    expect(result).toBeUndefined();
  });

  it("forward(id) returns a QueryBuilder for sourceCardinality:many", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("list_1", "list", { name: "A" }));
    await storage.entities.set(mkEntity("list_2", "list", { name: "B" }));
    await storage.entities.set(mkEntity("list_3", "list", { name: "C" }));
    await storage.entities.set(
      mkEntity("issue_1", "issue", { title: "Bug", labels: ["list_1", "list_2"] }),
    );

    const issue = defineEntity("issue", { title: e.string(), labels: e.string() });
    const r = new EntityRegistry();
    r.register(issue);
    r.register(list);
    r.registerRelationship(
      defineRelationship({
        source: issue,
        target: list,
        as: "labels",
        sourceCardinality: "many",
      }),
    );

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage,
      registry: r,
    });

    const handle = client.relationship({ source: issue, target: list, as: "labels" });
    const qb = (await handle.forward("issue_1")) as import("../sync/relationship").QueryBuilder<
      typeof list.fields
    >;
    const out = await qb;
    expect(out.map((e) => e.name).sort()).toEqual(["A", "B"]);
  });

  it("reverse(id) returns the sources linked via Relationship entities", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("list_1", "list", { name: "A" }));
    await storage.entities.set(mkEntity("todo_1", "todo", { title: "x", list: "list_1" }));
    await storage.entities.set(mkEntity("todo_2", "todo", { title: "y", list: "list_1" }));
    await storage.entities.set(mkEntity("todo_3", "todo", { title: "z", list: "list_other" }));
    await storage.entities.set(
      mkEntity("rel_a", "relationship", {
        source_id: "todo_1",
        target_id: "list_1",
        type: "todo",
        field: "list",
      }),
    );
    await storage.entities.set(
      mkEntity("rel_b", "relationship", {
        source_id: "todo_2",
        target_id: "list_1",
        type: "todo",
        field: "list",
      }),
    );
    await storage.entities.set(
      mkEntity("rel_c", "relationship", {
        source_id: "todo_3",
        target_id: "list_other",
        type: "todo",
        field: "list",
      }),
    );

    const r = new EntityRegistry();
    r.register(todo);
    r.register(list);
    r.registerRelationship(defineRelationship({ source: todo, target: list, as: "list" }));

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage,
      registry: r,
    });

    const handle = client.relationship({ source: todo, target: list, as: "list" });
    const qb = await handle.reverse("list_1");
    const out = await qb;
    expect(out.map((e) => e.title).sort()).toEqual(["x", "y"]);
  });
});
