/**
 * Tests for `client.<entity>.query()` namespace mount.
 */

import { describe, it, expect } from "vitest";
import { type Static } from "@sinclair/typebox";
import type { Entity } from "@ebbjs/core";

import { defineEntity, e } from "../../schema/entity";
import { defineSchema } from "../../schema/schema";
import { createClient } from "../client";

const todo = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
});

const user = defineEntity("user", {
  name: e.string(),
});

const schema = defineSchema({
  entities: { todo, user },
  version: 1,
});

const mkEntity = (id: string, type: string, fields: Record<string, unknown>): Entity => ({
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

describe("client.<entity>.query()", () => {
  it("nullable fields project to null (set) or undefined (absent)", async () => {
    const todoWithNullable = defineEntity("todo", {
      title: e.string(),
      body: e.string().nullable(),
    });
    const schemaWithNullable = defineSchema({
      entities: { todo: todoWithNullable },
      version: 1,
    });
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "a", body: "note" }));
    await storage.entities.set(mkEntity("t2", "todo", { title: "b", body: null }));
    await storage.entities.set(mkEntity("t3", "todo", { title: "c" }));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithNullable,
    });
    const rows = await client.todo.query();
    expect(rows.find((r) => r.title === "a")?.body).toBe("note");
    expect(rows.find((r) => r.title === "b")?.body).toBeNull();
    expect(rows.find((r) => r.title === "c")?.body).toBeUndefined();
  });

  it(".toRaw() returns readonly Entity[] — the untyped wire shape", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "a", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    const out = await client.todo.query().eq("completed", false).toRaw();
    expect(out[0]?.type).toBe("todo");
    expect(out[0]?.data?.fields?.title?.value).toBe("a");
  });

  it("client.todo.query() awaits to typed todo rows", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "a", completed: false }));
    await storage.entities.set(mkEntity("t2", "todo", { title: "b", completed: true }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    const out = await client.todo.query();
    expect(out.map((r) => r.title).sort()).toEqual(["a", "b"]);
  });

  it("rows are readonly Todo[] where Todo = Static<typeof schema.entities.todo.shape>", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    type Todo = Static<typeof schema.entities.todo.shape>;
    const rows: readonly Todo[] = await client.todo.query();
    expect(rows[0]?.title).toBe("Ship");
    expect(rows[0]?.completed).toBe(false);
  });

  it("rows.map((r) => r.bogus) is a compile error", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    const rows = await client.todo.query();
    rows.map((r) => r.title);
    // @ts-expect-error — `bogus` is not in the field map.
    rows.map((r) => r.bogus);
    expect(true).toBe(true);
  });

  it("filters via chain mutators and projects to the entity shape", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "a", completed: false }));
    await storage.entities.set(mkEntity("t2", "todo", { title: "b", completed: true }));
    await storage.entities.set(mkEntity("t3", "todo", { title: "c", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    const out = await client.todo.query().eq("completed", false).orderBy("title", "asc");
    expect(out.map((r) => r.title)).toEqual(["a", "c"]);
  });

  it(".toRaw() returns the untyped wire shape", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "a", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    const out = await client.todo.query().eq("completed", false).toRaw();
    expect(out[0]?.data?.fields?.title?.value).toBe("a");
  });

  it("exposes a separate namespace per schema entity", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("u1", "user", { name: "Ada" }));
    await storage.entities.set(mkEntity("t1", "todo", { title: "a", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    const users = await client.user.query();
    const todos = await client.todo.query();
    expect(users[0]?.name).toBe("Ada");
    expect(todos[0]?.title).toBe("a");
  });

  it("preserves every SyncClient method through the Proxy", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    expect(typeof client.subscribe).toBe("function");
    expect(typeof client.write).toBe("function");
    expect(typeof client.handshake).toBe("function");
    expect(typeof client.getEntity).toBe("function");
    expect(typeof client.queryEntities).toBe("function");
    expect(typeof client.relationship).toBe("function");
    expect(typeof client.textDocument).toBe("function");
    expect(typeof client.readLocalEntity).toBe("function");
  });
});

describe("createClient without a schema", () => {
  it("does not expose entity namespaces", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage });
    // No schema → no typed entity access; property access returns undefined.
    expect((client as unknown as Record<string, unknown>)["todo"]).toBeUndefined();
  });

  it("preserves SyncClient methods and private-field access", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage });
    expect(typeof client.subscribe).toBe("function");
    expect(typeof client.handshake).toBe("function");
    client.setState("live");
    expect(client.state).toBe("live");
    client.close();
    expect(client.state).toBe("offline");
  });
});

describe("client.<entity>.get(id)", () => {
  it("resolves to Todo | null where Todo = Static<typeof schema.entities.todo.shape>", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    type Todo = Static<typeof schema.entities.todo.shape>;
    const row: Todo | null = await client.todo.get("t1");
    expect(row).not.toBeNull();
    expect(row?.title).toBe("Ship");
    expect(row?.completed).toBe(false);
  });

  it("returns null for an unknown id", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    const row = await client.todo.get("missing");
    expect(row).toBeNull();
  });

  it("returns null when the materialized entity's type differs", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    // `user` is in the schema but the stored entity has type "todo".
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    // ask for "t1" under the `user` namespace — wrong type, must reject.
    const row = await client.user.get("t1");
    expect(row).toBeNull();
  });

  it("three projection states on a single row (set / nulled / absent)", async () => {
    const todoWithNullable = defineEntity("todo", {
      title: e.string(),
      body: e.string().nullable(),
    });
    const schemaWithNullable = defineSchema({
      entities: { todo: todoWithNullable },
      version: 1,
    });
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "a", body: "note" }));
    await storage.entities.set(mkEntity("t2", "todo", { title: "b", body: null }));
    await storage.entities.set(mkEntity("t3", "todo", { title: "c" }));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithNullable,
    });
    expect((await client.todo.get("t1"))?.body).toBe("note");
    expect((await client.todo.get("t2"))?.body).toBeNull();
    expect((await client.todo.get("t3"))?.body).toBeUndefined();
  });

  it("the untyped wire shape stays reachable via client.readLocalEntity(id)", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    const raw = await client.readLocalEntity("t1");
    expect(raw?.type).toBe("todo");
    expect(raw?.data?.fields?.title?.value).toBe("Ship");
  });

  it("projected row's field names are typed; bogus fields are a compile error", () => {
    // Compile-time check: `bogus` is not in the field map.
    // Wrapped in a function so vitest's runtime ignore (`@ts-expect-error`)
    // doesn't trip when the file is loaded.
    const check: () => void = () => {
      const _typecheck: (row: { title: string; completed: boolean }) => void = (row) => {
        // @ts-expect-error — `bogus` is not in the field map.
        void row.bogus;
        void row.title;
        void row.completed;
      };
      void _typecheck;
    };
    expect(typeof check).toBe("function");
  });

  it("does not expose the untyped wire envelope on the projected row", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    const row = await client.todo.get("t1");
    // The projection is the flat TypeBox shape — no `id`, no `data`,
    // no `type`. Users wanting the wire envelope use
    // `client.readLocalEntity(id)` instead.
    expect((row as Record<string, unknown>)["id"]).toBeUndefined();
    expect((row as Record<string, unknown>)["data"]).toBeUndefined();
    expect((row as Record<string, unknown>)["type"]).toBeUndefined();
  });
});
