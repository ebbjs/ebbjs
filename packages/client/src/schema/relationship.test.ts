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

/** One edge's presence leaf, as the `ebb/link` value nests it. */
const edgeLeaf = (
  update: Update,
  as: string,
  type: string,
  targetId: string,
): { readonly value: unknown } | undefined => {
  const data = update.data as {
    map: Record<string, { map: Record<string, { map: Record<string, { value: unknown }> }> }>;
  };
  return data.map[as]?.map[type]?.map[targetId];
};

/** The target ids one Update's `(as, type)` level carries, with their leaves. */
const leavesOf = (
  update: Update,
  as: string,
  type: string,
): Readonly<Record<string, { readonly value: unknown }>> => {
  const data = update.data as {
    map: Record<string, { map: Record<string, { map: Record<string, { value: unknown }> }> }>;
  };
  return data.map[as]?.map[type]?.map ?? {};
};

const registryFor = (many: boolean): ModelRegistry => {
  const r = new ModelRegistry();
  r.register(todo);
  r.register(list);
  r.registerRelationship(
    many
      ? defineRelationship({ source: todo, target: list, as: "tags", sourceCardinality: "many" })
      : defineRelationship({ source: todo, target: list, as: "list" }),
  );
  return r;
};

const mkClient = (registry: ModelRegistry) =>
  createClient({ serverUrl: "http://localhost:4000", actorId: "actor_1", registry });

describe("buildRelationshipWrite (SyncClient)", () => {
  it("merges one presence key on the source for a one-cardinality link", () => {
    const client = mkClient(registryFor(false));

    const result = client.buildRelationshipWrite({
      source: todo,
      target: list,
      as: "list",
      sourceId: "todo_1",
      targetId: "list_1",
    });

    // One Update writes one edge: no link row, no create.
    expect(result.relationshipUpdates).toHaveLength(1);
    const [link] = result.relationshipUpdates;
    expect(link).toMatchObject({ subject_id: "todo_1", component: "ebb/link", method: "merge" });
    expect(leavesOf(link!, "list", "todo")).toEqual({
      list_1: { value: true, update_id: expect.any(String), hlc: expect.any(String) },
    });
  });

  it("carries the old key's tombstone and the new key's presence in one move", () => {
    const client = mkClient(registryFor(false));

    const result = client.buildRelationshipWrite({
      source: todo,
      target: list,
      as: "list",
      sourceId: "todo_1",
      targetId: "list_2",
      currentTargets: ["list_1"],
    });

    expect(result.relationshipUpdates).toHaveLength(1);
    const leaves = leavesOf(result.relationshipUpdates[0]!, "list", "todo");
    expect(leaves).toEqual({
      list_1: { value: null, update_id: expect.any(String), hlc: expect.any(String) },
      list_2: { value: true, update_id: expect.any(String), hlc: expect.any(String) },
    });
  });

  it("refuses a clear it cannot diff against the live set", () => {
    const client = mkClient(registryFor(false));

    // The caller cannot see the live edges, so the builder cannot tombstone
    // the keys a clear drops.
    expect(() =>
      client.buildRelationshipWrite({
        source: todo,
        target: list,
        as: "list",
        sourceId: "todo_1",
        targetId: null,
      }),
    ).toThrow(/needs its live targets/);
  });

  it("emits one tombstone Update per live key a clear drops", () => {
    const client = mkClient(registryFor(false));

    const result = client.buildRelationshipWrite({
      source: todo,
      target: list,
      as: "list",
      sourceId: "todo_1",
      targetId: null,
      currentTargets: ["list_1"],
    });

    expect(result.relationshipUpdates).toHaveLength(1);
    expect(leavesOf(result.relationshipUpdates[0]!, "list", "todo")).toEqual({
      list_1: { value: null, update_id: expect.any(String), hlc: expect.any(String) },
    });
  });

  it("normalizes an entity-shape pointer to its .id", () => {
    const client = mkClient(registryFor(false));

    const result = client.buildRelationshipWrite({
      source: todo,
      target: list,
      as: "list",
      sourceId: "todo_1",
      targetId: { id: "list_99" },
    });

    expect(edgeLeaf(result.relationshipUpdates[0]!, "list", "todo", "list_99")).toMatchObject({
      value: true,
    });
  });

  it("throws EntityValidationError when the source entity is not registered", () => {
    const r = new ModelRegistry();
    // Only `list` is registered — `todo` is not.
    r.register(list);
    r.registerRelationship(defineRelationship({ source: todo, target: list, as: "list" }));
    const client = mkClient(r);

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
    const r = new ModelRegistry();
    r.register(todo);
    r.registerRelationship(defineRelationship({ source: todo, target: list, as: "list" }));

    expect(() =>
      mkClient(r).buildRelationshipWrite({
        source: todo,
        target: list,
        as: "list",
        sourceId: "todo_1",
        targetId: "list_1",
      }),
    ).not.toThrow();
  });

  it("diffs a many-cardinality replace against the live set, one Update per key", () => {
    const client = mkClient(registryFor(true));

    const result = client.buildRelationshipWrite({
      source: todo,
      target: list,
      as: "tags",
      sourceId: "todo_1",
      targetIds: { replace: ["list_1", "list_2", { id: "list_3" }] },
      currentTargets: ["list_1", "list_dropped"],
    });

    // One presence leaf per added key, one tombstone for the key the set drops,
    // each in its own Update.
    const written = result.relationshipUpdates.map((update) => leavesOf(update, "tags", "todo"));
    expect(written).toHaveLength(3);
    const present = written
      .flatMap((leaves) =>
        Object.entries(leaves)
          .filter(([, leaf]) => leaf.value === true)
          .map(([targetId]) => targetId),
      )
      .sort();
    const removed = written
      .flatMap((leaves) =>
        Object.entries(leaves)
          .filter(([, leaf]) => leaf.value === null)
          .map(([targetId]) => targetId),
      )
      .sort();
    expect(present).toEqual(["list_2", "list_3"]);
    expect(removed).toEqual(["list_dropped"]);
  });

  it("defers the permission check to write() rather than throwing in the builder", async () => {
    // The builder only shapes the wire Update; an actor without
    // `ebb/link.update` gets a `PermissionError` from `write()`.
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
      registry: registryFor(false),
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
    const client = mkClient(registryFor(true));

    // Registry says "many"; no targetIds passed -> nothing to write.
    const result = client.buildRelationshipWrite({
      source: todo,
      target: list,
      as: "tags",
    } as never);

    expect(result.relationshipUpdates).toEqual([]);
  });
});
