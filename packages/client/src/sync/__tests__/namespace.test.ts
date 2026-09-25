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
  it("AC #3: nullable fields project to null (set) or undefined (absent)", async () => {
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

  it("AC #4: .toRaw() returns readonly Entity[] — the untyped wire shape", async () => {
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

  it("AC #1: rows are readonly Todo[] where Todo = Static<typeof schema.entities.todo.shape>", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    type Todo = Static<typeof schema.entities.todo.shape>;
    const rows: readonly Todo[] = await client.todo.query();
    expect(rows[0]?.title).toBe("Ship");
    expect(rows[0]?.completed).toBe(false);
  });

  it("AC #2: rows.map((r) => r.bogus) is a compile error", async () => {
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
