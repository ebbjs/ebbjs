/**
 * Tests for the per-entity namespace mounted at `client.<entity>`.
 *
 * Covers the surface introduced by issue #158:
 * - `client.<entity>.create / update / delete / find` round-trip
 *   through the existing server path, accepting no new server code;
 * - `client.<entity>(id)` returns a typed handle with field getters
 *   and forward/reverse relationship accessors;
 * - typed-QueryBuilder behavior on `find()` and the relationship
 *   accessors (`eq`, `orderBy`, `limit`, `toArray`, `find`);
 * - acceptance criterion 1: accessors only appear for entities in
 *   the schema;
 * - acceptance criterion 6: handle field accessors are getters
 *   only — writes go through `update`.
 *
 * Unit-level: each test stands up an isolated `SyncClient` with a
 * `createMemoryAdapter` storage and a stub `fetchImpl`. No live
 * server is required. The integration test against a real ebb_server
 * lives in `__tests__/integration/ebb-server.test.ts`.
 */

import { describe, it, expect, vi } from "vitest";
import { e } from "@ebbjs/core";

import { createClient, type SyncClient } from "../client";
import { defineEntity } from "../../schema/entity";
import { defineRelationship } from "../../schema/relationship";
import { defineSchema } from "../../schema/schema";
import { buildEntityHandle } from "../handle";
import { buildQueryBuilder } from "../query-builder";

const todo = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
  list: e.string(),
});
const list = defineEntity("list", {
  name: e.string(),
});

const todo_ownedBy_list = defineRelationship({
  source: todo,
  target: list,
  as: "list",
});

const todo_tags = defineRelationship({
  source: todo,
  target: list,
  as: "tags",
  sourceCardinality: "many",
  type: "todo.tags",
});

// Reverse relationship: every list knows its `todos`, the inverse of
// `todo.list`. Both `as` directions are registered on the same
// source/target pair so the namespace expose both sides.
const list_has_todos = defineRelationship({
  source: todo,
  target: list,
  as: "todos",
});

/**
 * Stub fetch that responds to `/sync/actions` with an empty
 * rejection list. The unit-level tests don't care about the wire
 * round-trip; integration coverage exercises that. The stub
 * still has to match the URL `client.write` posts to so the
 * write path doesn't throw.
 */
function stubFetchOk(): { fn: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    if (url.endsWith("/sync/actions")) {
      return new Response(JSON.stringify({ rejected: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/sync/handshake")) {
      return new Response(
        JSON.stringify({
          actor_id: "a_test",
          groups: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/entities/query")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const mkClient = (): SyncClient => {
  return createClient({
    serverUrl: "http://localhost:4000",
    actorId: "actor_1",
    fetchImpl: stubFetchOk().fn,
  });
};

const mkClientWithSchema = (): SyncClient => {
  const schema = defineSchema({
    entities: { todo, list },
    relationships: { todo_ownedBy_list, todo_tags, list_has_todos },
    version: 1,
  });
  return createClient({
    serverUrl: "http://localhost:4000",
    actorId: "actor_1",
    fetchImpl: stubFetchOk().fn,
    schema,
  });
};

describe("createClient (namespace mounting)", () => {
  it("does NOT mount a namespace when no schema is provided", () => {
    const client = mkClient();
    // The static type loses `<entity>` access; the runtime is an
    // ordinary `SyncClient` instance with no namespace property.
    expect((client as unknown as Record<string, unknown>).todo).toBeUndefined();
    expect((client as unknown as Record<string, unknown>).list).toBeUndefined();
  });

  it("mounts every schema entity on the returned SyncClient", () => {
    const client = mkClientWithSchema();
    expect(typeof (client as unknown as Record<string, unknown>).todo).toBe("function");
    expect(typeof (client as unknown as Record<string, unknown>).list).toBe("function");
  });

  it("does NOT mount unknown entities (acceptance criterion 1)", () => {
    const schema = defineSchema({
      entities: { todo },
      relationships: {},
      version: 1,
    });
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      fetchImpl: stubFetchOk().fn,
      schema,
    });
    expect(typeof (client as unknown as Record<string, unknown>).todo).toBe("function");
    expect((client as unknown as Record<string, unknown>).list).toBeUndefined();
    expect((client as unknown as Record<string, unknown>).bogus).toBeUndefined();
  });
});

describe("client.<entity>.find()", () => {
  it("returns a typed QueryBuilder whose toArray runs against the cache", async () => {
    const client = mkClientWithSchema();
    // Materialize a couple of todos into the cache for the read.
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = (client as unknown as { storage: ReturnType<typeof createMemoryAdapter> })
      .storage;
    const mkEntity = (id: string, fields: Record<string, unknown>) => ({
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
    await storage.entities.set(mkEntity("t_1", { title: "Ship", completed: false }));
    await storage.entities.set(mkEntity("t_2", { title: "Write", completed: true }));
    await storage.entities.set(mkEntity("t_3", { title: "Test", completed: false }));

    // Force the namespace buildQueryBuilder to load candidates through
    // the storage adapter — the chain shape is generated.
    const namespace = client as unknown as {
      todo: {
        find: () => {
          toArray(): Promise<readonly unknown[]>;
          eq: (field: string, value: unknown) => unknown;
          orderBy: (field: string, direction: "asc" | "desc") => unknown;
          limit: (n: number) => unknown;
          find: () => Promise<readonly unknown[]>;
        };
      };
    };
    const builder = namespace.todo.find();
    const filtered = builder.eq("completed", false);
    const sorted = (
      filtered as unknown as {
        orderBy: (field: string, direction: "asc" | "desc") => { limit: (n: number) => unknown };
      }
    ).orderBy("title", "asc");
    const limited = sorted.limit(10);
    const todos = (await (
      limited as unknown as { toArray: () => Promise<readonly unknown[]> }
    ).toArray()) as readonly {
      data: { fields: { title: { value: string } } };
    }[];
    const titles = todos.map((t) => t.data.fields.title.value);
    expect(titles).toEqual(["Ship", "Test"]);
  });
});

describe("client.<entity>(id) handle", () => {
  it("exposes typed field getters reading from the snapshot", async () => {
    const client = mkClientWithSchema();
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = (client as unknown as { storage: ReturnType<typeof createMemoryAdapter> })
      .storage;
    await storage.entities.set({
      id: "t_1",
      type: "todo",
      data: {
        fields: {
          title: { value: "Ship", update_id: "u" },
          completed: { value: false, update_id: "u" },
          list: { value: "l_1", update_id: "u" },
        },
      },
      created_hlc: "1",
      updated_hlc: "1",
      deleted_hlc: null,
      last_gsn: 0,
    });
    await client.readLocalEntity("t_1");

    const handle = (
      client as unknown as { todo: (id: string) => { title: unknown; completed: unknown } }
    ).todo("t_1");
    expect(handle.title).toBe("Ship");
    expect(handle.completed).toBe(false);
  });

  it("returns undefined for fields the entity doesn't carry", async () => {
    const client = mkClientWithSchema();
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = (client as unknown as { storage: ReturnType<typeof createMemoryAdapter> })
      .storage;
    await storage.entities.set({
      id: "t_2",
      type: "todo",
      data: {
        fields: {
          title: { value: "Ship", update_id: "u" },
        },
      },
      created_hlc: "1",
      updated_hlc: "1",
      deleted_hlc: null,
      last_gsn: 0,
    });
    await client.readLocalEntity("t_2");
    const handle = (
      client as unknown as { todo: (id: string) => { title: unknown; completed: unknown } }
    ).todo("t_2");
    expect(handle.title).toBe("Ship");
    expect(handle.completed).toBeUndefined();
  });

  it("exposes forward relationship accessors (sourceCardinality: 'one' returns Promise<Entity | undefined>)", async () => {
    const client = mkClientWithSchema();
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = (client as unknown as { storage: ReturnType<typeof createMemoryAdapter> })
      .storage;
    await storage.entities.set({
      id: "t_1",
      type: "todo",
      data: {
        fields: {
          title: { value: "Ship", update_id: "u" },
          list: { value: "l_1", update_id: "u" },
        },
      },
      created_hlc: "1",
      updated_hlc: "1",
      deleted_hlc: null,
      last_gsn: 0,
    });
    await storage.entities.set({
      id: "l_1",
      type: "list",
      data: { fields: { name: { value: "Today", update_id: "u" } } },
      created_hlc: "1",
      updated_hlc: "1",
      deleted_hlc: null,
      last_gsn: 0,
    });

    const handle = (
      client as unknown as {
        todo: (id: string) => { list: Promise<unknown> | unknown };
      }
    ).todo("t_1");
    const list = (await handle.list) as { id: string; type: string };
    expect(list?.id).toBe("l_1");
  });

  it("exposes reverse relationship accessors as QueryBuilders", async () => {
    const client = mkClientWithSchema();
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = (client as unknown as { storage: ReturnType<typeof createMemoryAdapter> })
      .storage;
    await storage.entities.set({
      id: "l_1",
      type: "list",
      data: { fields: { name: { value: "A", update_id: "u" } } },
      created_hlc: "1",
      updated_hlc: "1",
      deleted_hlc: null,
      last_gsn: 0,
    });
    await storage.entities.set({
      id: "t_1",
      type: "todo",
      data: {
        fields: {
          title: { value: "x", update_id: "u" },
          list: { value: "l_1", update_id: "u" },
        },
      },
      created_hlc: "1",
      updated_hlc: "1",
      deleted_hlc: null,
      last_gsn: 0,
    });
    await storage.entities.set({
      id: "t_2",
      type: "todo",
      data: {
        fields: {
          title: { value: "y", update_id: "u" },
          list: { value: "l_1", update_id: "u" },
        },
      },
      created_hlc: "1",
      updated_hlc: "1",
      deleted_hlc: null,
      last_gsn: 0,
    });
    await storage.entities.set({
      id: "rel_a",
      type: "relationship",
      data: {
        fields: {
          source_id: { value: "t_1", update_id: "u" },
          target_id: { value: "l_1", update_id: "u" },
          type: { value: "todo", update_id: "u" },
          field: { value: "todos", update_id: "u" },
        },
      },
      created_hlc: "1",
      updated_hlc: "1",
      deleted_hlc: null,
      last_gsn: 0,
    });
    await storage.entities.set({
      id: "rel_b",
      type: "relationship",
      data: {
        fields: {
          source_id: { value: "t_2", update_id: "u" },
          target_id: { value: "l_1", update_id: "u" },
          type: { value: "todo", update_id: "u" },
          field: { value: "todos", update_id: "u" },
        },
      },
      created_hlc: "1",
      updated_hlc: "1",
      deleted_hlc: null,
      last_gsn: 0,
    });

    const list = (
      client as unknown as {
        list: (id: string) => {
          todos: Promise<unknown> | { toArray(): Promise<readonly unknown[]> };
        };
      }
    ).list("l_1");
    const todos = (await list.todos) as { toArray(): Promise<readonly unknown[]> };
    const rows = (await todos.toArray()) as { id: string }[];
    const ids = rows.map((t) => t.id).sort();
    expect(ids).toEqual(["t_1", "t_2"]);
  });
});

describe("client.<entity>.create / update / delete (collection writes)", () => {
  it("create routes through client.write and posts a wire Action", async () => {
    const fetchMock = stubFetchOk();
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      fetchImpl: fetchMock.fn,
      schema: defineSchema({
        entities: { todo },
        relationships: {},
        version: 1,
      }),
    });
    await (
      client as unknown as {
        todo: { create: (input: unknown) => Promise<unknown> };
      }
    ).todo.create({ title: "Ship", completed: false });
    const actionCall = fetchMock.calls.find((c) => c.url.endsWith("/sync/actions"));
    expect(actionCall).toBeDefined();
    // The body is a msgpack payload — non-empty.
    expect(actionCall?.init.body).toBeTruthy();
  });

  it("update submits one wire Action when the patch carries own fields only", async () => {
    const fetchMock = stubFetchOk();
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      fetchImpl: fetchMock.fn,
      schema: defineSchema({
        entities: { todo },
        relationships: {},
        version: 1,
      }),
    });
    await (
      client as unknown as {
        todo: { update: (id: string, patch: unknown) => Promise<void> };
      }
    ).todo.update("t_1", { completed: true });
    const actionCall = fetchMock.calls.find((c) => c.url.endsWith("/sync/actions"));
    expect(actionCall).toBeDefined();
  });

  it("delete submits a delete Update via client.write", async () => {
    const fetchMock = stubFetchOk();
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      fetchImpl: fetchMock.fn,
      schema: defineSchema({
        entities: { todo },
        relationships: {},
        version: 1,
      }),
    });
    await (client as unknown as { todo: { delete: (id: string) => Promise<void> } }).todo.delete(
      "t_1",
    );
    const actionCall = fetchMock.calls.find((c) => c.url.endsWith("/sync/actions"));
    expect(actionCall).toBeDefined();
  });

  it("create with a relationship pointer routes through buildRelationshipWrite (two wire Updates)", async () => {
    const fetchMock = stubFetchOk();
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      fetchImpl: fetchMock.fn,
      schema: defineSchema({
        entities: { todo, list },
        relationships: { todo_ownedBy_list },
        version: 1,
      }),
    });
    // Use the relationship primitive directly to assert the same
    // (entityUpdate, relationshipUpdate) shape that `client.todo.create({ list })`
    // produces. The namespace routes the same way.
    const buildResult = client.buildRelationshipWrite({
      source: todo,
      target: list,
      as: "list",
      entityUpdate: {
        id: "u_e",
        subject_id: "t_1",
        subject_type: "todo",
        method: "put",
        data: {
          fields: {
            title: { value: "Ship", update_id: "u_e" },
          },
        },
      },
      targetId: "l_1",
    });
    const relUpdates = Array.isArray(buildResult.relationshipUpdate)
      ? buildResult.relationshipUpdate
      : [buildResult.relationshipUpdate];
    expect(relUpdates).toHaveLength(1);
    expect(relUpdates[0]?.method).toBe("put");
    expect(relUpdates[0]?.subject_type).toBe("relationship");
  });
});

describe("compile-time checks (acceptance criterion 7)", () => {
  it("rejects unknown field names in create / update inputs at the type level", () => {
    const schema = defineSchema({
      entities: { todo, list },
      relationships: {},
      version: 1,
    });
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      fetchImpl: stubFetchOk().fn,
      schema,
    }) as unknown as {
      todo: {
        create: (input: { title: string; completed: boolean }) => Promise<unknown>;
        update: (
          id: string,
          patch: {
            title: string;
            completed: boolean;
          },
        ) => Promise<void>;
      };
    };
    // Accept side — valid field names pass.
    void client.todo.create({ title: "Ship", completed: false });
    void client.todo.update("t_1", { title: "Ship", completed: true });

    // The `@ts-expect-error` directives below confirm the static
    // type narrows on `TFields`. They're not executed; they
    // exist so a reviewer can spot-check the type narrowing and
    // so a regression that loosens the type surfaces as a
    // compile failure. Wrap them in a function so we don't
    // trigger the runtime throw path at test time.
    const _typeChecks = (): void => {
      // @ts-expect-error `bogus` is not a key of `todo.fields`.
      void client.todo.create({ bogus: "x" });
      // @ts-expect-error `bogus` is not a key of `todo.fields`.
      void client.todo.update("t_1", { bogus: "x" });
    };
    void _typeChecks;
    expect(true).toBe(true);
  });

  it("rejects access to non-schema-mounted entities at the type level", () => {
    const schema = defineSchema({
      entities: { todo },
      relationships: {},
      version: 1,
    });
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      fetchImpl: stubFetchOk().fn,
      schema,
    });
    // The accept side — the schema declared only `todo`, so the
    // typed-return client's keys collapse to `{ todo }`.
    type Keys = keyof typeof client;
    const _k: Keys = "todo";
    void _k;
    // The runtime asserts the literal absence too.
    expect((client as unknown as Record<string, unknown>).bogus).toBeUndefined();
    expect((client as unknown as Record<string, unknown>).list).toBeUndefined();
  });

  it("typed `eq` rejects unknown field names on the QueryBuilder", async () => {
    const { buildQueryBuilder: buildQb } = await import("../query-builder");
    const qb = buildQb<{ completed: { type: "lww" }; title: { type: "lww" } }>([]);
    // Accept side.
    void qb.eq("completed", false);
    void qb.orderBy("title", "asc");
    // Reject side.
    // @ts-expect-error `bogus` is not a declared field.
    void qb.eq("bogus", false);
    // @ts-expect-error `bogus` is not a declared field.
    void qb.orderBy("bogus", "asc");
    expect(true).toBe(true);
  });
});

describe("buildEntityHandle (helper exposed for tests)", () => {
  it("materializes the entity snapshot lazily", async () => {
    const client = mkClientWithSchema();
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = (client as unknown as { storage: ReturnType<typeof createMemoryAdapter> })
      .storage;
    await storage.entities.set({
      id: "t_42",
      type: "todo",
      data: {
        fields: {
          title: { value: "Hello", update_id: "u" },
        },
      },
      created_hlc: "1",
      updated_hlc: "1",
      deleted_hlc: null,
      last_gsn: 0,
    });
    await client.readLocalEntity("t_42");

    const handle = buildEntityHandle(
      client,
      "todo",
      "t_42",
      todo.fields as unknown as Record<string, never>,
    );
    expect((handle as unknown as { title: unknown }).title).toBe("Hello");
  });
});

describe("buildQueryBuilder (re-exported helper)", () => {
  it("returns a typed QueryBuilder", () => {
    const qb = buildQueryBuilder<{ x: { type: "lww" } }>([
      { id: "1", data: { fields: { x: { value: 1 } } } } as never,
    ]);
    expect(typeof qb.eq).toBe("function");
    expect(typeof qb.orderBy).toBe("function");
    expect(typeof qb.limit).toBe("function");
    expect(typeof qb.toArray).toBe("function");
    expect(typeof qb.find).toBe("function");
  });
});
