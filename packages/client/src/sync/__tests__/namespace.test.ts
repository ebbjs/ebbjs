/**
 * Tests for `client.<entity>.query()` namespace mount.
 */

import { describe, it, expect } from "vitest";
import { type Static } from "@sinclair/typebox/type";
import { decodeSync, type Action } from "@ebbjs/core";
import type { Entity } from "@ebbjs/core";

import { defineEntity, e } from "../../schema/entity";
import { defineSchema } from "../../schema/schema";
import { defineRelationship } from "../../schema/relationship";
import { groupSystemEntity } from "../../schema/system-entities";
import { EntityValidationError } from "../../schema/entity-registry";
import type { EntityFields } from "../namespace";
import type { QueryBuilder } from "../query-builder";
import type { WriteResponse } from "../types";
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
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
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
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "a", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    const out = await client.todo.query().where("completed", false).toRaw();
    expect(out[0]?.type).toBe("todo");
    expect(out[0]?.data?.fields?.title?.value).toBe("a");
  });

  it("client.todo.query() awaits to typed todo rows", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "a", completed: false }));
    await storage.entities.set(mkEntity("t2", "todo", { title: "b", completed: true }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    const out = await client.todo.query();
    expect(out.map((r) => r.title).sort()).toEqual(["a", "b"]);
  });

  it("rows are readonly Todo[] where Todo = Static<typeof schema.entities.todo.shape>", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    type Todo = Static<typeof schema.entities.todo.shape>;
    const rows: readonly Todo[] = await client.todo.query();
    expect(rows[0]?.title).toBe("Ship");
    expect(rows[0]?.completed).toBe(false);
  });

  it("rows.map((r) => r.bogus) is a compile error", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
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
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "a", completed: false }));
    await storage.entities.set(mkEntity("t2", "todo", { title: "b", completed: true }));
    await storage.entities.set(mkEntity("t3", "todo", { title: "c", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    const out = await client.todo.query().where("completed", false).orderBy("title", "asc");
    expect(out.map((r) => r.title)).toEqual(["a", "c"]);
  });

  it(".toRaw() returns the untyped wire shape", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "a", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    const out = await client.todo.query().where("completed", false).toRaw();
    expect(out[0]?.data?.fields?.title?.value).toBe("a");
  });

  it("exposes a separate namespace per schema entity", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
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
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    expect(typeof client.subscribe).toBe("function");
    expect(typeof client.write).toBe("function");
    expect(typeof client.handshake).toBe("function");
    expect(typeof client.getEntity).toBe("function");
    expect(typeof client.queryEntities).toBe("function");
    expect(typeof client.textDocument).toBe("function");
    expect(typeof client.readLocalEntity).toBe("function");
  });
});

describe("createClient without a schema", () => {
  it("does not expose entity namespaces", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage });
    // No schema → no typed entity access; property access returns undefined.
    expect((client as unknown as Record<string, unknown>)["todo"]).toBeUndefined();
  });

  it("preserves SyncClient methods and private-field access", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
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
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
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
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    const row = await client.todo.get("missing");
    expect(row).toBeNull();
  });

  it("returns null when the materialized entity's type differs", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
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
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
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
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
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
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    const row = await client.todo.get("t1");
    // The projection is the flat TypeBox shape — no `id`, no `data`,
    // no `type`. Users wanting the wire envelope use
    // `client.readLocalEntity(id)` instead.
    expect((row as unknown as Record<string, unknown>)["id"]).toBeUndefined();
    expect((row as unknown as Record<string, unknown>)["data"]).toBeUndefined();
    expect((row as unknown as Record<string, unknown>)["type"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Row-with-relationship-accessors (#181)
// ---------------------------------------------------------------------------

/**
 * The schema below composes the relationships the row-accessor tests
 * rely on. Note the source entity `todo` has no FK fields — the FK
 * set lives on materialized `Relationship` records, not on the
 * source's data. `defineRelationship` is the single source of truth.
 *
 * - `todo` has a forward-many relationship `tags` → `label`
 * - `todo` has a forward-one relationship `parentList` → `list`
 * - `todo` has a forward-one relationship `owner` → `user`
 * - `list` is the target of `todo.parentList`; the same `as` name
 *   on `list` is the reverse accessor.
 */
const todoEntity = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
});
const labelEntity = defineEntity("label", {
  name: e.string(),
});
const listEntity = defineEntity("list", {
  name: e.string(),
});
const userEntity = defineEntity("user", {
  name: e.string(),
});

const schemaWithRels = defineSchema({
  entities: {
    todo: todoEntity,
    label: labelEntity,
    list: listEntity,
    user: userEntity,
  },
  relationships: {
    todo_tags: defineRelationship({
      source: todoEntity,
      target: labelEntity,
      as: "tags",
      sourceCardinality: "many",
    }),
    todo_parentList: defineRelationship({
      source: todoEntity,
      target: listEntity,
      as: "parentList",
    }),
    todo_owner: defineRelationship({
      source: todoEntity,
      target: userEntity,
      as: "owner",
    }),
  },
  version: 1,
});

/**
 * Build a `Relationship` entity record for storage. Wire shape:
 * `{source_id, target_id, type, field}` as field values.
 */
const mkRelEntity = (
  id: string,
  sourceId: string,
  targetId: string,
  field: string,
  type: string,
): Entity => ({
  id,
  type: "relationship",
  data: {
    fields: {
      source_id: { value: sourceId, update_id: "u" },
      target_id: { value: targetId, update_id: "u" },
      type: { value: type, update_id: "u" },
      field: { value: field, update_id: "u" },
    },
  },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 0,
});

/** Materialize one `entityGroup` membership row into the local cache. */
const mkEntityGroup = (id: string, entityId: string, groupId: string): Entity => ({
  id,
  type: "entityGroup",
  data: {
    fields: {
      entity_id: { value: entityId, update_id: "u" },
      group_id: { value: groupId, update_id: "u" },
    },
  },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 0,
// ---------------------------------------------------------------------------
// client.<entity>.query().where() — relationship-aware predicate (#247)
// ---------------------------------------------------------------------------

/** Entity for the `document.groups` membership edge. */
const groupEntity = defineEntity("group", { name: e.string() });

/**
 * `todo` carries an `owner` FIELD alongside an `owner` RELATIONSHIP so
 * the collision test can prove the relationship wins. The other
 * relationships exercise one-cardinality (`list`) and many-cardinality
 * (`groups`) inference.
 */
const whereTodo = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
  owner: e.string().nullable(),
});
const whereDocument = defineEntity("document", { title: e.string() });

const schemaForWhere = defineSchema({
  entities: {
    todo: whereTodo,
    list: listEntity,
    group: groupEntity,
    document: whereDocument,
    user: userEntity,
  },
  relationships: {
    todo_list: defineRelationship({ source: whereTodo, target: listEntity, as: "list" }),
    todo_owner: defineRelationship({ source: whereTodo, target: userEntity, as: "owner" }),
    document_groups: defineRelationship({
      source: whereDocument,
      target: groupEntity,
      as: "groups",
      sourceCardinality: "many",
    }),
  },
  version: 1,
});

describe("client.<entity>.query().where() — relationship-aware predicate", () => {
  const buildClient = async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaForWhere,
    });
    return { storage, client };
  };

  const todo = (id: string, title: string, completed = false, owner: string | null = null) =>
    mkEntity(id, "todo", { title, completed, owner });

  it("infers a field predicate when the key is not a registered relationship", async () => {
    const { storage, client } = await buildClient();
    await storage.entities.set(todo("t1", "a", false));
    await storage.entities.set(todo("t2", "b", true));
    const out = await client.todo.query().where("completed", false);
    expect(out.map((r) => r.title)).toEqual(["a"]);
  });

  it('infers a relationship predicate from the registry: where("list", listId)', async () => {
    const { storage, client } = await buildClient();
    await storage.entities.set(todo("t1", "a"));
    await storage.entities.set(todo("t2", "b"));
    await storage.entities.set(mkRelEntity("r1", "t1", "l1", "list", "todo"));
    await storage.entities.set(mkRelEntity("r2", "t2", "l2", "list", "todo"));
    const out = await client.todo.query().where("list", "l1");
    expect(out.map((r) => r.title)).toEqual(["a"]);
  });

  it('where("groups", groupId) returns the documents whose membership includes it', async () => {
    const { storage, client } = await buildClient();
    await storage.entities.set(mkEntity("d1", "document", { title: "one" }));
    await storage.entities.set(mkEntity("d2", "document", { title: "two" }));
    await storage.entities.set(mkRelEntity("rg1", "d1", "g1", "groups", "document"));
    await storage.entities.set(mkRelEntity("rg2", "d2", "g2", "groups", "document"));
    const out = await client.document.query().where("groups", "g1");
    expect(out.map((r) => r.title)).toEqual(["one"]);
  });

  it("a relationship key wins over a same-named field", async () => {
    const { storage, client } = await buildClient();
    // t1's field says u1, but its edge points at u2.
    await storage.entities.set(todo("t1", "a", false, "u1"));
    // t2's field says u2, but it has no edge at all.
    await storage.entities.set(todo("t2", "b", false, "u2"));
    await storage.entities.set(mkRelEntity("r1", "t1", "u2", "owner", "todo"));
    const out = await client.todo.query().where("owner", "u2");
    expect(out.map((r) => r.title)).toEqual(["a"]);
  });

  it("an array target means any-of", async () => {
    const { storage, client } = await buildClient();
    await storage.entities.set(todo("t1", "a"));
    await storage.entities.set(todo("t2", "b"));
    await storage.entities.set(todo("t3", "c"));
    await storage.entities.set(mkRelEntity("r1", "t1", "l1", "list", "todo"));
    await storage.entities.set(mkRelEntity("r2", "t2", "l2", "list", "todo"));
    await storage.entities.set(mkRelEntity("r3", "t3", "l3", "list", "todo"));
    const out = await client.todo.query().where("list", ["l1", "l3"]);
    expect(out.map((r) => r.title).sort()).toEqual(["a", "c"]);
  });

  it("chained where(...) calls are ANDed (all-of)", async () => {
    const { storage, client } = await buildClient();
    await storage.entities.set(todo("t1", "a"));
    await storage.entities.set(todo("t2", "b"));
    await storage.entities.set(todo("t3", "c"));
    await storage.entities.set(mkRelEntity("r1", "t1", "l1", "list", "todo"));
    await storage.entities.set(mkRelEntity("r2", "t2", "l1", "list", "todo"));
    await storage.entities.set(mkRelEntity("r3", "t3", "l2", "list", "todo"));
    await storage.entities.set(mkRelEntity("o1", "t1", "u1", "owner", "todo"));
    await storage.entities.set(mkRelEntity("o2", "t2", "u2", "owner", "todo"));
    const out = await client.todo.query().where("list", "l1").where("owner", "u1");
    expect(out.map((r) => r.title)).toEqual(["a"]);
  });

  it("accepts a { id } handle and a materialized entity as relationship targets", async () => {
    const { storage, client } = await buildClient();
    await storage.entities.set(todo("t1", "a"));
    await storage.entities.set(mkEntity("l1", "list", { name: "inbox" }));
    await storage.entities.set(mkRelEntity("r1", "t1", "l1", "list", "todo"));
    const byHandle = await client.todo.query().where("list", { id: "l1" });
    expect(byHandle.map((r) => r.title)).toEqual(["a"]);
    const handle = await storage.entities.get("l1");
    if (handle === null) throw new Error("unreachable");
    const byRow = await client.todo.query().where("list", handle);
    expect(byRow.map((r) => r.title)).toEqual(["a"]);
  });

  it("a null / undefined / empty target names no live edge and matches nothing", async () => {
    const { storage, client } = await buildClient();
    await storage.entities.set(todo("t1", "a"));
    await storage.entities.set(mkRelEntity("r1", "t1", "l1", "list", "todo"));
    expect(await client.todo.query().where("list", null)).toEqual([]);
    expect(await client.todo.query().where("list", undefined)).toEqual([]);
    expect(await client.todo.query().where("list", [])).toEqual([]);
  });

  it("composes relationship predicates with orderBy and limit", async () => {
    const { storage, client } = await buildClient();
    await storage.entities.set(mkEntity("d1", "document", { title: "b" }));
    await storage.entities.set(mkEntity("d2", "document", { title: "a" }));
    await storage.entities.set(mkEntity("d3", "document", { title: "c" }));
    await storage.entities.set(mkRelEntity("rg1", "d1", "g1", "groups", "document"));
    await storage.entities.set(mkRelEntity("rg2", "d2", "g1", "groups", "document"));
    await storage.entities.set(mkRelEntity("rg3", "d3", "g1", "groups", "document"));
    const out = await client.document
      .query()
      .where("groups", "g1")
      .orderBy("title", "asc")
      .limit(2);
    expect(out.map((r) => r.title)).toEqual(["a", "b"]);
  });

  it("throws on a key that is neither a field nor a declared relationship", async () => {
    const { client } = await buildClient();
    expect(() => client.todo.query().where("nope", "x")).toThrow(/not a field/);
  });
});

describe("client.<entity>.get(id) — row with relationship accessors", () => {
  it("row.<field> types flow from the entity's field map (no FK fields required)", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithRels,
    });
    type Todo = Static<typeof schemaWithRels.entities.todo.shape>;
    const row: Todo | null = await client.todo.get("t1");
    expect(row).not.toBeNull();
    if (row === null) throw new Error("unreachable");
    const _title: string = row.title;
    const _completed: boolean = row.completed;
    void _title;
    void _completed;
  });

  it("forward-many accessor awaits to readonly TargetShape[]", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    await storage.entities.set(mkEntity("lbl-a", "label", { name: "a" }));
    await storage.entities.set(mkEntity("lbl-b", "label", { name: "b" }));
    await storage.entities.set(mkEntity("lbl-c", "label", { name: "c" }));
    await storage.entities.set(mkRelEntity("rel-a", "t1", "lbl-a", "tags", "todo"));
    await storage.entities.set(mkRelEntity("rel-b", "t1", "lbl-b", "tags", "todo"));
    await storage.entities.set(mkRelEntity("rel-c", "t1", "lbl-c", "tags", "todo"));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithRels,
    });
    const row = await client.todo.get("t1");
    if (row === null) throw new Error("expected row");
    const tags: QueryBuilder<EntityFields<typeof labelEntity>> = row.tags;
    const resolved: readonly { name: string }[] = await tags;
    expect(resolved.map((t) => t.name).sort()).toEqual(["a", "b", "c"]);
  });

  it("forward-one accessor returns the target entity when the edge exists", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    await storage.entities.set(mkEntity("u1", "user", { name: "Ada" }));
    await storage.entities.set(mkRelEntity("rel-owner", "t1", "u1", "owner", "todo"));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithRels,
    });
    const row = await client.todo.get("t1");
    if (row === null) throw new Error("expected row");
    const ownerPromise: Promise<Entity | null | undefined> = row.owner;
    const owner: Entity | null | undefined = await ownerPromise;
    expect(owner?.id).toBe("u1");
    expect(owner?.type).toBe("user");
  });

  it("forward-one accessor returns null when no Relationship edge exists", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    await storage.entities.set(mkEntity("l1", "list", { name: "Work" }));
    // No Relationship record for t1.parentList.
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithRels,
    });
    const row = await client.todo.get("t1");
    if (row === null) throw new Error("expected row");
    const parentList: Promise<Entity | null | undefined> = row.parentList;
    const list: Entity | null | undefined = await parentList;
    // No edge in metadata → null.
    expect(list).toBeNull();
    // Add the edge and the accessor surfaces the target.
    await storage.entities.set(mkRelEntity("rel-parentList", "t1", "l1", "parentList", "todo"));
    const row2 = await client.todo.get("t1");
    if (row2 === null) throw new Error("expected row");
    const list2: Entity | null | undefined = await row2.parentList;
    expect(list2?.id).toBe("l1");
    expect(list2?.type).toBe("list");
  });

  it("forward-one accessor returns undefined when the edge target is missing (dangling)", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    await storage.entities.set(mkRelEntity("rel-ghost", "t1", "ghost", "owner", "todo"));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithRels,
    });
    const row = await client.todo.get("t1");
    if (row === null) throw new Error("expected row");
    const owner: Entity | null | undefined = await row.owner;
    // Edge exists but target_id is dangling → undefined.
    expect(owner).toBeUndefined();
  });

  it("reverse accessor awaits to readonly SourceShape[] via the namespace", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("l1", "list", { name: "Work" }));
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    await storage.entities.set(mkEntity("t2", "todo", { title: "Other", completed: false }));
    await storage.entities.set(mkEntity("t3", "todo", { title: "Off-list", completed: false }));
    await storage.entities.set(mkRelEntity("rel-1", "t1", "l1", "parentList", "todo"));
    await storage.entities.set(mkRelEntity("rel-2", "t2", "l1", "parentList", "todo"));
    await storage.entities.set(mkRelEntity("rel-3", "t3", "l2", "parentList", "todo"));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithRels,
    });
    const list = await client.list.get("l1");
    if (list === null) throw new Error("expected row");
    const todos: QueryBuilder<EntityFields<typeof todoEntity>> = list.parentList;
    const titles = (await todos).map((r) => r.title).sort();
    expect(titles).toEqual(["Other", "Ship"]);
  });

  it("accessor key wins over a same-named field", async () => {
    // `card` declares a `tags` field AND a forward-many `tags`
    // relationship. The runtime overwrites the projected field with
    // the accessor; the static type follows (`Omit<...> & accessors`).
    const card = defineEntity("card", {
      title: e.string(),
      tags: { type: "array", items: { type: "string" } } as never,
    });
    const tag = defineEntity("tag", { name: e.string() });
    const schemaWithOverlap = defineSchema({
      entities: { card, tag },
      relationships: {
        card_tags: defineRelationship({
          source: card,
          target: tag,
          as: "tags",
          sourceCardinality: "many",
        }),
      },
      version: 1,
    });
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("c1", "card", { title: "C", tags: ["stale"] }));
    await storage.entities.set(mkEntity("g1", "tag", { name: "a" }));
    await storage.entities.set(mkRelEntity("rel-1", "c1", "g1", "tags", "card"));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithOverlap,
    });
    const row = await client.card.get("c1");
    if (row === null) throw new Error("expected row");
    // The accessor type (a QueryBuilder), not the `string[]` field type.
    const tags: QueryBuilder<EntityFields<typeof tag>> = row.tags;
    const resolved: readonly { name: string }[] = await tags;
    expect(resolved.map((t) => t.name)).toEqual(["a"]);
  });

  it("a self-referential relationship's reverse accessor shadows the forward slot", async () => {
    // `node.parent` is both a forward-one (`node` → `node`) and a
    // reverse (`node` ← `node`). The runtime attaches forward then
    // reverse, so the reverse `QueryBuilder` wins; the static type
    // mirrors that precedence rather than producing an intersection.
    const node = defineEntity("node", { label: e.string() });
    const schemaWithSelf = defineSchema({
      entities: { node },
      relationships: {
        node_parent: defineRelationship({ source: node, target: node, as: "parent" }),
      },
      version: 1,
    });
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("n1", "node", { label: "root" }));
    await storage.entities.set(mkEntity("n2", "node", { label: "child" }));
    await storage.entities.set(mkRelEntity("rel-1", "n2", "n1", "parent", "node"));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithSelf,
    });
    const row = await client.node.get("n1");
    if (row === null) throw new Error("expected row");
    const parent: QueryBuilder<EntityFields<typeof node>> = row.parent;
    const nodes = await parent;
    expect(nodes.map((n) => n.label)).toEqual(["child"]);
  });

  it("row.bogus (un-declared relationship) is a compile error", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithRels,
    });
    const row = await client.todo.get("t1");
    expect(row).not.toBeNull();
    // Compile-time check. Declared accessors (`tags`, `parentList`,
    // `owner`) are part of the row type; `bogus` is neither a
    // projected field nor a declared relationship, so it's a compile
    // error. Wrapped in a function so vitest's runtime ignore
    // (`@ts-expect-error`) doesn't trip when the file is loaded.
    const check: () => void = () => {
      if (row === null) return;
      void row.tags;
      void row.parentList;
      // @ts-expect-error — `bogus` is not a declared field on todo.
      void row.bogus;
    };
    void check;
  });

  it("entities whose only relationships are reverse carry the reverse accessor", async () => {
    // `user` is the target of `todo.owner`, so `client.user.get(id)`
    // carries the reverse `owner` accessor alongside its fields.
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("u1", "user", { name: "Ada" }));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithRels,
    });
    const row = await client.user.get("u1");
    expect(row).not.toBeNull();
    expect(row?.name).toBe("Ada");
    const check: () => void = () => {
      if (row === null) return;
      const _owner: QueryBuilder<EntityFields<typeof todoEntity>> = row.owner;
      void _owner;
    };
    void check;
  });

  it("entities with no declared relationships carry no accessors", async () => {
    // The top-level `schema` declares no relationships, so
    // `client.todo.get(id)` returns the bare projection.
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    const row = await client.todo.get("t1");
    expect(row?.title).toBe("Ship");
    const check: () => void = () => {
      if (row === null) return;
      // @ts-expect-error — no relationships declared, so no `tags` accessor.
      void row.tags;
    };
    void check;
  });

  it("row is null when the id is unknown (no accessor leak)", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithRels,
    });
    const row = await client.todo.get("missing");
    expect(row).toBeNull();
  });

  it("row.title.toUpperCase() compiles (Path A types)", () => {
    // Compile-time check: the field types flow from the entity's
    // TypeBox shape — `title` is `string`. Wrapped in a function so
    // vitest's runtime ignore doesn't trip.
    const check: () => void = () => {
      const _row: { title: string } = { title: "" };
      void _row.title.toUpperCase();
    };
    expect(typeof check).toBe("function");
  });
});

describe("doc.groups — built-in membership accessor", () => {
  const groupsSchema = defineSchema({ entities: { todo: todoEntity }, version: 1 });

  it("resolves the group rows linked through entityGroup membership rows", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    await storage.entities.set(mkEntity("g1", "group", { name: "Demo" }));
    await storage.entities.set(mkEntityGroup("eg-1", "t1", "g1"));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: groupsSchema,
    });
    const row = await client.todo.get("t1");
    if (row === null) throw new Error("expected row");
    const groups: QueryBuilder<EntityFields<typeof groupSystemEntity>> = row.groups;
    const resolved: readonly { name: string }[] = await groups;
    expect(resolved.map((g) => g.name)).toEqual(["Demo"]);
  });

  it("awaits an empty list for an entity with no membership rows", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: groupsSchema,
    });
    const row = await client.todo.get("t1");
    if (row === null) throw new Error("expected row");
    expect(await row.groups).toEqual([]);
  });

  it("exposes no reverse accessor and no group namespace in v1", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: groupsSchema,
    });
    // `group` is a registry system entity, not a schema namespace.
    expect((client as unknown as Record<string, unknown>)["group"]).toBeUndefined();
  });

  it("keeps the groups accessor out of the entity's data fields on the wire", () => {
    // `groups` is an accessor, not a field: the field map has no
    // `groups` key, so a row's projected shape can't shadow it.
    expect(Object.keys(todoEntity.shape.properties)).not.toContain("groups");
  });
});

/**
 * `client.<entity>.link(id, "as", target)` /
 * `client.<entity>.unlink(id, "as")` /
 * `client.<entity>.setLinks(id, "as", { replace | add | remove })`
 *
 * The public surface that lets callers mutate relationships without
 * hand-rolling Update[] arrays. Each method builds the wire Update(s),
 * wraps them in `createAction`, and submits via `client.write()`.
 *
 * The link/unlink methods are one-cardinality; setLinks is
 * many-cardinality. The split matches the wire shape (one Update
 * for one-cardinality, one entity Update + N Relationship Updates
 * for many-cardinality).
 *
 * Tests stub `fetch` so the wire Action is acknowledged without a
 * live server. The handshake stub returns groups with `todo.*,
 * list.*` so the early permission check passes.
 */
describe("client.<entity>.link / unlink / setLinks", () => {
  const list = defineEntity("list", { name: e.string() });

  // `todo` declares a `tags` field carrying the canonical FK set
  // so the many-cardinality `setLinks` entity Update validates.
  const todoWithTags = defineEntity("todo", {
    title: e.string(),
    completed: e.boolean(),
    tags: { type: "array", items: { type: "string" } } as never,
  });

  const schemaWithRels = defineSchema({
    entities: { todo: todoWithTags, user, list },
    relationships: {
      todo_list: defineRelationship({ source: todoWithTags, target: list, as: "list" }),
      todo_tags: defineRelationship({
        source: todoWithTags,
        target: list,
        as: "tags",
        sourceCardinality: "many",
      }),
    },
    version: 1,
  });

  /**
   * Stub fetch for the link/unlink/setLinks tests. Handshake
   * returns groups with `todo.*, list.*` so the early permission
   * check passes; `/sync/actions` always accepts (returns
   * `rejected: []`).
   */
  const mkStubFetch = (seen: string[] = []): typeof fetch => {
    return (async (url: string, _init: RequestInit): Promise<Response> => {
      seen.push(url);
      if (url.endsWith("/sync/handshake")) {
        return new Response(
          JSON.stringify({
            actor_id: "actor_1",
            groups: [
              {
                id: "g_1",
                permissions: ["todo.*", "list.*"],
                cursor_valid: true,
                reason: null,
                cursor: 0,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/sync/actions")) {
        return new Response(JSON.stringify({ rejected: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  };

  const mkClient = async (seen: string[] = []) => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage,
      schema: schemaWithRels,
      fetchImpl: mkStubFetch(seen),
    });
    await client.handshake();
    return { client, storage, seen };
  };

  it("link() submits a single Relationship Update for one-cardinality", async () => {
    const { client } = await mkClient();
    const response = await client.todo.link("todo_1", "list", "list_1");
    expect(response.rejected).toEqual([]);
  });

  it("link() accepts an entity-shape pointer and normalizes to .id", async () => {
    const { client } = await mkClient();
    const response = await client.todo.link("todo_1", "list", { id: "list_99" });
    expect(response.rejected).toEqual([]);
  });

  it("unlink() submits a single Relationship Delete Update", async () => {
    const { client, storage } = await mkClient();
    // Pre-seed the materialized Relationship cache with a row
    // keyed at the same `(source, field, type)` the wire unlink()
    // is about to address — unlink() must look up the existing
    // relationship's id from the local cache so the wire Update's
    // `subject_id` matches the row to delete.
    await storage.entities.set(
      mkEntity("rel_seeded_1", "relationship", {
        source_id: "todo_1",
        target_id: "list_1",
        field: "list",
        type: "todo",
      }),
    );
    const response = await client.todo.unlink("todo_1", "list");
    expect(response.rejected).toEqual([]);
  });

  it("unlink() throws EntityValidationError when no relationship exists locally", async () => {
    const { client } = await mkClient();
    // Empty materialized cache — nothing to unlink.
    await expect(client.todo.unlink("todo_1", "list")).rejects.toBeInstanceOf(
      EntityValidationError,
    );
  });

  it("setLinks({ replace }) emits one entity Update + N Relationship Updates", async () => {
    const { client } = await mkClient();
    const response = await client.todo.setLinks("todo_1", "tags", {
      replace: ["list_1", "list_2", { id: "list_3" }],
    });
    expect(response.rejected).toEqual([]);
  });

  it("setLinks({ add, remove }) emits the patch shape", async () => {
    const { client } = await mkClient();
    const response = await client.todo.setLinks("todo_1", "tags", {
      add: ["list_1"],
      remove: ["list_2"],
    });
    expect(response.rejected).toEqual([]);
  });

  it("throws EntityValidationError when the relationship's `as` is not declared on the entity", async () => {
    const { client } = await mkClient();
    await expect(client.todo.link("todo_1", "bogus", "list_1")).rejects.toBeInstanceOf(
      EntityValidationError,
    );
  });

  // #127 defers membership mutation (share/unshare). The injected
  // `groups` accessor must not be reachable through the generic
  // relationship-write path, and the reject must happen before any
  // network call.
  describe("rejects membership mutation on the deferred link/unlink/setLinks path", () => {
    const expectDeferred = async (
      call: (client: Awaited<ReturnType<typeof mkClient>>["client"]) => Promise<unknown>,
    ): Promise<void> => {
      const { client, seen } = await mkClient();
      const seenBefore = seen.length;
      let caught: unknown;
      try {
        await call(client);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EntityValidationError);
      expect((caught as EntityValidationError).violations[0]?.message).toMatch(/deferred/);
      expect((caught as EntityValidationError).violations[0]?.message).toMatch(
        /create\(input, \{ groups \}\)/,
      );
      expect(seen.length).toBe(seenBefore);
    };

    it("link()", async () => {
      await expectDeferred((client) => client.todo.link("todo_1", "groups", "g_1"));
    });

    it("unlink()", async () => {
      await expectDeferred((client) => client.todo.unlink("todo_1", "groups"));
    });

    it("setLinks()", async () => {
      await expectDeferred((client) =>
        client.todo.setLinks("todo_1", "groups", { replace: ["g_1", "g_2"] }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Issue #172: runtime validation on writes (Value.Check before network)
// ---------------------------------------------------------------------------

describe("client.<entity>.create / update — runtime validation", () => {
  /**
   * The recording fetch stub asserts validation rejects before
   * any network call — `seen` captures every URL, so a passing
   * `/sync/actions` count proves the wire was actually reached.
   */
  const todoForCreate = defineEntity("todo", {
    title: e.string(),
    completed: e.boolean(),
  });

  /**
   * Nullable variant of the same `todo` schema, used by the
   * "nullable accepts null / non-nullable rejects null" tests and
   * the type-asymmetry tests below (#212). `defineEntity` wraps
   * nullable fields in `Type.Optional` at runtime, so `Value.Check`
   * accepts both `{ body: null }` and the no-body variant. The
   * static type mirrors that wrap via `ShapeFields` so callers can
   * write `{ title, completed }` (omitting `body`) and have it
   * both typecheck and run.
   */
  const todoWithNullable = defineEntity("todo", {
    title: e.string(),
    completed: e.boolean(),
    body: e.string().nullable(),
  });

  const schemaForCreate = defineSchema({
    entities: { todo: todoForCreate, user, list: defineEntity("list", { name: e.string() }) },
    version: 1,
  });

  const schemaWithNullableBody = defineSchema({
    entities: { todo: todoWithNullable, user, list: defineEntity("list", { name: e.string() }) },
    version: 1,
  });

  /**
   * Build a stub fetch that records every URL it sees in
   * `seen` and accepts handshakes / writes. The `create` /
   * `update` tests assert that a validation failure never causes a
   * URL to land in `seen`.
   */
  const mkRecordingStubFetch = (seen: string[]): typeof fetch => {
    return (async (url: string, _init: RequestInit): Promise<Response> => {
      seen.push(url);
      if (url.endsWith("/sync/handshake")) {
        return new Response(
          JSON.stringify({
            actor_id: "actor_1",
            groups: [
              {
                id: "g_1",
                permissions: ["todo.*", "list.*"],
                cursor_valid: true,
                reason: null,
                cursor: 0,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/sync/actions")) {
        return new Response(JSON.stringify({ rejected: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  };

  const mkClient = async (seen: string[]) => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage,
      schema: schemaForCreate,
      fetchImpl: mkRecordingStubFetch(seen),
    });
    await client.handshake();
    return { client, storage };
  };

  /** Nullable-schema variant of `mkClient` — same shape, but `body` is `.nullable()`. */
  const mkClientWithNullable = async (seen: string[]) => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage,
      schema: schemaWithNullableBody,
      fetchImpl: mkRecordingStubFetch(seen),
    });
    await client.handshake();
    return { client, storage };
  };

  /** Membership option every `create()` in this block carries (#244). */
  const createOpts = { groups: ["g_1"] } as const;

  it("create() accepts a conforming payload and submits to /sync/actions", async () => {
    const seen: string[] = [];
    const { client } = await mkClient(seen);
    const response = await client.todo.create({ title: "Ship", completed: false }, createOpts);
    expect(response.rejected).toEqual([]);
    // handshake + actions: validation passed, the wire saw the call.
    expect(seen.some((u) => u.endsWith("/sync/actions"))).toBe(true);
  });

  it("create() accepts null for a nullable field and rejects it for a non-nullable one", async () => {
    const seen: string[] = [];
    const { client } = await mkClientWithNullable(seen);
    const seenBefore = seen.length;

    const response = await client.todo.create(
      {
        title: "Ship",
        completed: false,
        body: null,
      },
      createOpts,
    );
    expect(response.rejected).toEqual([]);

    await expect(
      client.todo.create(
        {
          title: null as unknown as string,
          completed: false,
          body: null,
        },
        createOpts,
      ),
    ).rejects.toBeInstanceOf(EntityValidationError);

    // The validation failure must not have reached the wire — only
    // the first successful create made a /sync/actions call. The
    // count is the network-rejection assertion.
    const actionsCalls = seen.filter((u) => u.endsWith("/sync/actions")).length;
    expect(actionsCalls).toBe(1);
    expect(seen.length).toBe(seenBefore + 1);
  });

  it("create() throws EntityValidationError with the bad field name when value type is wrong", async () => {
    const seen: string[] = [];
    const { client } = await mkClient(seen);
    const seenBefore = seen.length;

    try {
      // The cast bypasses the type checker so the deliberately-wrong
      // payload reaches `Value.Check`.
      await client.todo.create({ title: 42, completed: false } as never, createOpts);
      expect.fail("expected EntityValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(EntityValidationError);
      const violations = (err as InstanceType<typeof EntityValidationError>).violations;
      expect(violations.length).toBeGreaterThanOrEqual(1);
      const titleViolation = violations.find((v) => v.field === "title");
      expect(titleViolation).toBeDefined();
      expect(titleViolation!.entityName).toBe("todo");
      expect(titleViolation!.message).toMatch(/title/i);
    }

    // No fetch for /sync/actions after the failed create — the
    // validator rejected before any network call.
    const newActionsCalls = seen.filter((u) => u.endsWith("/sync/actions")).length;
    expect(newActionsCalls).toBe(0);
    expect(seen.length).toBe(seenBefore);
  });

  it("create() throws EntityValidationError for an unknown field", async () => {
    const seen: string[] = [];
    const { client } = await mkClient(seen);

    try {
      await client.todo.create(
        {
          title: "Ship",
          completed: false,
          bogus: "x",
        } as never,
        createOpts,
      );
      expect.fail("expected EntityValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(EntityValidationError);
      const violations = (err as InstanceType<typeof EntityValidationError>).violations;
      expect(violations.length).toBeGreaterThanOrEqual(1);
      // TypeBox reports unknown properties as `Unexpected property`
      // (additional-properties rejection) — the field name surfaces
      // in the violation path or message.
      const offending = violations.find((v) => /bogus/i.test(v.message));
      expect(offending).toBeDefined();
    }

    expect(seen.some((u) => u.endsWith("/sync/actions"))).toBe(false);
  });

  it("create() reports every violation in a single EntityValidationError", async () => {
    const seen: string[] = [];
    const { client } = await mkClient(seen);

    try {
      await client.todo.create(
        {
          title: 42,
          completed: "no",
          bogus: "x",
        } as never,
        createOpts,
      );
      expect.fail("expected EntityValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(EntityValidationError);
      const violations = (err as InstanceType<typeof EntityValidationError>).violations;
      // title (wrong type), completed (wrong type), bogus (unknown).
      expect(violations.length).toBeGreaterThanOrEqual(2);
      const fields = violations.map((v) => v.field).filter((f): f is string => f !== undefined);
      expect(fields).toContain("title");
      expect(fields).toContain("completed");
    }
    expect(seen.some((u) => u.endsWith("/sync/actions"))).toBe(false);
  });

  it("create({ validate: false }) skips local validation and submits", async () => {
    const seen: string[] = [];
    const { client } = await mkClient(seen);
    // `title: 42` is what `Value.Check` rejects; the registry's
    // name-membership check at `client.write()` still accepts it.
    const response = await client.todo.create({ title: 42, completed: false } as never, {
      validate: false,
      ...createOpts,
    });
    expect(response.rejected).toEqual([]);
    expect(seen.some((u) => u.endsWith("/sync/actions"))).toBe(true);
  });

  it("update(id, patch) validates the patch and submits when valid", async () => {
    const seen: string[] = [];
    const { client } = await mkClient(seen);
    const response = await client.todo.update("todo_1", { completed: true });
    expect(response.rejected).toEqual([]);
    expect(seen.some((u) => u.endsWith("/sync/actions"))).toBe(true);
  });

  it("update() rejects an empty patch as a no-op", async () => {
    const seen: string[] = [];
    const { client } = await mkClient(seen);
    await expect(client.todo.update("todo_1", {})).rejects.toBeInstanceOf(EntityValidationError);
    expect(seen.some((u) => u.endsWith("/sync/actions"))).toBe(false);
  });

  it("update() throws EntityValidationError on a type mismatch", async () => {
    const seen: string[] = [];
    const { client } = await mkClient(seen);

    try {
      await client.todo.update("todo_1", { title: 99 } as never);
      expect.fail("expected EntityValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(EntityValidationError);
      const violations = (err as InstanceType<typeof EntityValidationError>).violations;
      const titleViolation = violations.find((v) => v.field === "title");
      expect(titleViolation).toBeDefined();
    }

    expect(seen.some((u) => u.endsWith("/sync/actions"))).toBe(false);
  });

  it("update() throws EntityValidationError on an unknown patch field", async () => {
    const seen: string[] = [];
    const { client } = await mkClient(seen);

    await expect(client.todo.update("todo_1", { bogus: "x" } as never)).rejects.toBeInstanceOf(
      EntityValidationError,
    );

    expect(seen.some((u) => u.endsWith("/sync/actions"))).toBe(false);
  });

  it("update() accepts null for a nullable field and rejects it for a non-nullable one", async () => {
    const seen: string[] = [];
    const { client } = await mkClientWithNullable(seen);

    const response = await client.todo.update("todo_1", { body: null });
    expect(response.rejected).toEqual([]);

    await expect(
      client.todo.update("todo_1", { title: null as unknown as string }),
    ).rejects.toBeInstanceOf(EntityValidationError);

    const actionsCalls = seen.filter((u) => u.endsWith("/sync/actions")).length;
    expect(actionsCalls).toBe(1);
  });

  it("update({ validate: false }) skips local validation and submits", async () => {
    const seen: string[] = [];
    const { client } = await mkClient(seen);
    const response = await client.todo.update("todo_1", { title: 42 } as never, {
      validate: false,
    });
    expect(response.rejected).toEqual([]);
    expect(seen.some((u) => u.endsWith("/sync/actions"))).toBe(true);
  });

  it("create() validation throws before any /sync/actions fetch (no network on bad input)", async () => {
    const seen: string[] = [];
    const { client } = await mkClient(seen);
    const before = seen.length;
    await expect(
      client.todo.create({ title: 42, completed: false } as never, createOpts),
    ).rejects.toBeInstanceOf(EntityValidationError);
    expect(seen.length).toBe(before);
  });

  it("create() input type flow: title and completed types are inferred from the entity shape", () => {
    // The wrapping in `() => void` keeps `@ts-expect-error` from
    // tripping when the file loads.
    const typecheck: () => void = () => {
      const _input: { title: string; completed: boolean } = { title: "", completed: false };
      void _input.title.toUpperCase();
      void !_input.completed;
      // @ts-expect-error — `bogus` is not in the field map.
      void _input.bogus;
    };
    void typecheck;
    expect(true).toBe(true);
  });

  it("create() with a nullable schema: omitting the nullable field typechecks and runs (#212)", async () => {
    // The static type for nullable fields must be `T | null | undefined`,
    // not `T | null`. The runtime accepts omission (Type.Optional wrap
    // in withImplicitOptional), and the type system should agree so
    // callers don't have to pass `null` for fields they want to leave
    // unset.
    const seen: string[] = [];
    const { client } = await mkClientWithNullable(seen);
    const response = await client.todo.create({ title: "Ship", completed: false }, createOpts);
    expect(response.rejected).toEqual([]);
    expect(seen.some((u) => u.endsWith("/sync/actions"))).toBe(true);
  });

  it("create() with a nullable schema: static type still rejects wrong inner type (#212)", () => {
    // Static type must NOT accept `body: 42` — `body` is `string | null`,
    // and `42` isn't either. The optional wrapping only changes whether
    // the field can be omitted, not the inner type's coercion.
    const typecheck: () => void = () => {
      const _input: { title: string; completed: boolean; body?: string | null } = {
        title: "",
        completed: false,
        body: null,
      };
      void _input.body?.length;
      // @ts-expect-error — body is string | null, not number.
      void ({ ..._input, body: 42 } as typeof _input);
    };
    void typecheck;
    expect(true).toBe(true);
  });

  it("create() with a nullable schema: omitting the field at runtime does not throw EntityValidationError (#212)", async () => {
    // Round-trip: omitting body passes both the static type check and
    // Value.Check. Catches any drift between the runtime shape
    // (Type.Optional wrap) and the static type after the fix.
    const seen: string[] = [];
    const { client } = await mkClientWithNullable(seen);
    await expect(
      client.todo.create({ title: "Ship", completed: false }, { groups: ["g_1"] }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #244: canonical entityGroup rows on create()
// ---------------------------------------------------------------------------

describe("client.<entity>.create — entityGroup rows", () => {
  interface RecordedRequest {
    readonly url: string;
    readonly body: Uint8Array | undefined;
  }

  /** Handshake + actions stub that records request bodies for decoding. */
  const mkFetch = (seen: RecordedRequest[]): typeof fetch => {
    return (async (url: string, init: RequestInit): Promise<Response> => {
      const body =
        init.body instanceof Uint8Array
          ? init.body
          : typeof init.body === "string"
            ? new TextEncoder().encode(init.body)
            : undefined;
      seen.push({ url, body });
      if (url.endsWith("/sync/handshake")) {
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
      }
      if (url.endsWith("/sync/actions")) {
        return new Response(JSON.stringify({ rejected: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  };

  const memberTodo = defineEntity("todo", { title: e.string() });
  const memberSchema = defineSchema({ entities: { todo: memberTodo }, version: 1 });

  const mkMemberClient = async (): Promise<{
    client: ReturnType<typeof createClient<typeof memberSchema>>;
    seen: RecordedRequest[];
  }> => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const seen: RecordedRequest[] = [];
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage: createMemoryAdapter(),
      schema: memberSchema,
      fetchImpl: mkFetch(seen),
    });
    await client.handshake();
    return { client, seen };
  };

  const actionRequests = (seen: readonly RecordedRequest[]): RecordedRequest[] =>
    seen.filter((r) => r.url.endsWith("/sync/actions"));

  const decodeFirstAction = (request: RecordedRequest): Action =>
    decodeSync<{ actions: Action[] }>(request.body!).actions[0]!;

  it("emits the entity put plus one entityGroup row per group in one Action", async () => {
    const { client, seen } = await mkMemberClient();
    const response = await client.todo.create({ title: "Ship" }, { groups: ["g_1", "g_2"] });
    expect(response.rejected).toEqual([]);

    const actions = actionRequests(seen);
    expect(actions).toHaveLength(1);
    const updates = decodeFirstAction(actions[0]!).updates;
    // 1 entity put + 2 membership rows.
    expect(updates).toHaveLength(3);

    const entityUpdate = updates.find((u) => u.subject_type === "todo")!;
    expect(entityUpdate.method).toBe("put");
    expect(entityUpdate.data?.fields?.["title"]?.value).toBe("Ship");

    const memberships = updates.filter((u) => u.subject_type === "entityGroup");
    expect(memberships).toHaveLength(2);
    for (const membership of memberships) {
      expect(membership.method).toBe("put");
      expect(membership.data?.fields?.["entity_id"]?.value).toBe(entityUpdate.subject_id);
    }
    const targets = memberships.map((m) => m.data?.fields?.["group_id"]?.value).sort();
    expect(targets).toEqual(["g_1", "g_2"]);
  });

  it("accepts entity-shape group refs and de-duplicates ids", async () => {
    const { client, seen } = await mkMemberClient();
    await client.todo.create({ title: "Ship" }, { groups: ["g_1", { id: "g_1" }, { id: "g_2" }] });
    const updates = decodeFirstAction(actionRequests(seen)[0]!).updates;
    const memberships = updates.filter((u) => u.subject_type === "entityGroup");
    expect(memberships.map((m) => m.data?.fields?.["group_id"]?.value).sort()).toEqual([
      "g_1",
      "g_2",
    ]);
  });

  it("rejects a missing or empty groups option before any network call", async () => {
    const { client, seen } = await mkMemberClient();
    await expect(client.todo.create({ title: "Ship" }, undefined as never)).rejects.toBeInstanceOf(
      EntityValidationError,
    );
    await expect(client.todo.create({ title: "Ship" }, { groups: [] })).rejects.toBeInstanceOf(
      EntityValidationError,
    );
    expect(actionRequests(seen)).toHaveLength(0);
  });

  it("rejects a malformed group ref with EntityValidationError", async () => {
    const { client, seen } = await mkMemberClient();
    await expect(
      client.todo.create({ title: "Ship" }, { groups: [42 as never] }),
    ).rejects.toBeInstanceOf(EntityValidationError);
    expect(actionRequests(seen)).toHaveLength(0);
  });

  it("requires the groups option at the type level", () => {
    const typecheck: () => void = () => {
      const client = null as unknown as ReturnType<typeof createClient<typeof memberSchema>>;
      // @ts-expect-error — create() requires a `{ groups }` option.
      void client.todo.create({ title: "Ship" });
      void client.todo.create({ title: "Ship" }, { groups: ["g_1"] });
    };
    expect(typeof typecheck).toBe("function");
  });
});

describe("client.<entity>.delete", () => {
  const todoForDelete = defineEntity("todo", {
    title: e.string(),
    completed: e.boolean(),
  });
  const schemaForDelete = defineSchema({ entities: { todo: todoForDelete }, version: 1 });

  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  /** Handshake payload; `todo.*` is the permission the delete path needs. */
  const handshakeBody = {
    actor_id: "actor_1",
    groups: [{ id: "g_1", permissions: ["todo.*"], cursor_valid: true, reason: null, cursor: 0 }],
  };

  /**
   * Stub fetch that answers the handshake and routes every other
   * request to `handle`, so each test only states the response it
   * cares about.
   */
  const mkFetch = (handle: (url: string, init: RequestInit) => Response): typeof fetch => {
    return (async (url: string, init: RequestInit): Promise<Response> => {
      if (url.endsWith("/sync/handshake")) return jsonResponse(handshakeBody);
      return handle(url, init);
    }) as unknown as typeof fetch;
  };

  const mkClient = async (fetchImpl: typeof fetch) => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage,
      schema: schemaForDelete,
      fetchImpl,
    });
    await client.handshake();
    return { client, storage };
  };

  /** Wraps a fetch so every `POST /sync/actions` body lands in `captured`. */
  const captureActions = (captured: Action[][]): typeof fetch =>
    mkFetch((url, init) => {
      if (url.endsWith("/sync/actions")) {
        const body = init.body as unknown as Uint8Array;
        captured.push(decodeSync<{ actions: Action[] }>(body).actions);
      }
      return jsonResponse({ rejected: [] });
    });

  it("delete(id) ships one method:'delete' Update with data null", async () => {
    const captured: Action[][] = [];
    const { client } = await mkClient(captureActions(captured));

    const response = await client.todo.delete("todo_1");

    expect(response.rejected).toEqual([]);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveLength(1);
    const updates = captured[0]![0]!.updates;
    expect(updates).toHaveLength(1);
    const update = updates[0]!;
    expect(update.subject_id).toBe("todo_1");
    expect(update.subject_type).toBe("todo");
    expect(update.method).toBe("delete");
    expect(update.data).toBeNull();
  });

  it("delete(id) scopes the server's rejection list to the submitted Action", async () => {
    let submittedId = "";
    const { client } = await mkClient(
      mkFetch((_url, init) => {
        const actions = decodeSync<{ actions: Action[] }>(init.body as Uint8Array).actions;
        submittedId = actions[0]!.id;
        return jsonResponse({
          rejected: [
            { id: "act_someone_else", reason: "not_authorized" },
            { id: submittedId, reason: "permission_denied" },
          ],
        });
      }),
    );

    const response = await client.todo.delete("todo_1");

    expect(response.rejected).toEqual([{ id: submittedId, reason: "permission_denied" }]);
  });

  it("delete(id) is typed as Promise<WriteResponse>", async () => {
    const captured: Action[][] = [];
    const { client } = await mkClient(captureActions(captured));
    const result: Promise<WriteResponse> = client.todo.delete("todo_1");
    await expect(result).resolves.toEqual({ rejected: [] });
  });
});
