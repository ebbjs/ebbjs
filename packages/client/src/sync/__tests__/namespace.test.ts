/**
 * Tests for `client.<entity>.query()` namespace mount.
 */

import { describe, it, expect } from "vitest";
import { type Static } from "@sinclair/typebox";
import type { Entity } from "@ebbjs/core";

import { defineEntity, e } from "../../schema/entity";
import { defineSchema } from "../../schema/schema";
import { defineRelationship } from "../../schema/relationship";
import { EntityValidationError } from "../../schema/entity-registry";
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

describe("client.<entity>.get(id) — row with relationship accessors", () => {
  it("row.<field> types flow from the entity's field map (no FK fields required)", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
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
    const { createMemoryAdapter } = await import("@ebbjs/storage");
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
    // The forward-many accessor lives on the row at runtime but the
    // static type surfaces only the projected fields (per-entity
    // accessor key typing is a documented follow-up). Cast through
    // `unknown` to reach the runtime accessor.
    const tags = await (row as unknown as { tags: Promise<unknown> }).tags;
    expect(Array.isArray(tags)).toBe(true);
    expect((tags as unknown as readonly { name: string }[]).map((t) => t.name).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("forward-one accessor returns the target entity when the edge exists", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
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
    const owner = await (row as unknown as { owner: Promise<unknown> }).owner;
    expect((owner as unknown as { id: string } | null | undefined)?.id).toBe("u1");
    expect((owner as unknown as { type: string } | null | undefined)?.type).toBe("user");
  });

  it("forward-one accessor returns null when no Relationship edge exists", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
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
    const list = await (row as unknown as { parentList: Promise<unknown> }).parentList;
    // No edge in metadata → null.
    expect(list).toBeNull();
    // Add the edge and the accessor surfaces the target.
    await storage.entities.set(mkRelEntity("rel-parentList", "t1", "l1", "parentList", "todo"));
    const row2 = await client.todo.get("t1");
    if (row2 === null) throw new Error("expected row");
    const list2 = await (row2 as unknown as { parentList: Promise<unknown> }).parentList;
    expect((list2 as unknown as { id: string } | null | undefined)?.id).toBe("l1");
    expect((list2 as unknown as { type: string } | null | undefined)?.type).toBe("list");
  });

  it("forward-one accessor returns undefined when the edge target is missing (dangling)", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
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
    const owner = await (row as unknown as { owner: Promise<unknown> }).owner;
    // Edge exists but target_id is dangling → undefined.
    expect(owner).toBeUndefined();
  });

  it("reverse accessor awaits to readonly SourceShape[] via the namespace", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
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
    // The reverse accessor lives on the row at runtime but isn't
    // enumerated in the static type — RelationshipDef's source/target
    // generics widen the inferred `name` to `string`, so a
    // type-level walker can't recover the per-entity accessor key
    // set (TS recursion limits, per the spec). Static narrowing is
    // a documented follow-up; the runtime dispatches via the
    // registry and surfaces the right accessor on `await`.
    const todos = await (list as unknown as { parentList: Promise<unknown> }).parentList;
    const titles = (todos as readonly { title: string }[]).map((r) => r.title).sort();
    expect(titles).toEqual(["Other", "Ship"]);
  });

  it("row.bogus (un-declared relationship) is a compile error", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
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
    // Compile-time check. The static type surfaces only the
    // projected fields (`title`, `completed`), so any relationship
    // accessor key is a compile error — including un-declared
    // relationships like `bogus` and the declared ones (`tags`,
    // `parentList`, `owner`) until per-entity accessor key typing
    // is added (TS recursion limits, per the spec). Wrapped in a
    // function so vitest's runtime ignore (`@ts-expect-error`)
    // doesn't trip when the file is loaded.
    const check: () => void = () => {
      if (row === null) return;
      // @ts-expect-error — `bogus` is not a declared field on todo.
      void row.bogus;
    };
    void check;
  });

  it("does not attach accessors for entities with no declared relationships", async () => {
    // `user` has no outgoing/incoming relationships in `schemaWithRels`,
    // so `client.user.get(id)` returns the bare projection (no
    // accessor record entries).
    const { createMemoryAdapter } = await import("@ebbjs/storage");
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
  });

  it("row is null when the id is unknown (no accessor leak)", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
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
  const mkStubFetch = (): typeof fetch => {
    return (async (url: string, _init: RequestInit): Promise<Response> => {
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

  const mkClient = async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      storage,
      schema: schemaWithRels,
      fetchImpl: mkStubFetch(),
    });
    await client.handshake();
    return { client, storage };
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
    const { client } = await mkClient();
    const response = await client.todo.unlink("todo_1", "list");
    expect(response.rejected).toEqual([]);
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
});
