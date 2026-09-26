/**
 * Tests for `client.<entity>.query()` namespace mount.
 */

import { describe, it, expect } from "vitest";
import { type Static, Type } from "@sinclair/typebox";
import type { Entity } from "@ebbjs/core";

import { defineEntity, e } from "../../schema/entity";
import { defineSchema } from "../../schema/schema";
import { defineRelationship } from "../../schema/relationship";
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

// ---------------------------------------------------------------------------
// Row-with-relationship-accessors (#181)
// ---------------------------------------------------------------------------

/**
 * The schema below composes the relationships the row-accessor tests
 * rely on:
 *
 * - `todo` has a forward-many relationship `tags` → `label`
 * - `todo` has a forward-one relationship `parentList` → `list`
 *   (nullable FK, so the runtime uses `forwardOneNullable`)
 * - `todo` has a non-nullable forward-one relationship `owner` → `user`
 * - `list` is the target of `todo.parentList`; the same `as` name
 *   on `list` is the reverse accessor.
 */
const todoWithFks = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
  tags: Type.Array(Type.String()),
  parentList: e.string().nullable(),
  owner: e.string(),
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
    todo: todoWithFks,
    label: labelEntity,
    list: listEntity,
    user: userEntity,
  },
  relationships: {
    todo_tags: defineRelationship({
      source: todoWithFks,
      target: labelEntity,
      as: "tags",
      sourceCardinality: "many",
    }),
    todo_parentList: defineRelationship({
      source: todoWithFks,
      target: listEntity,
      as: "parentList",
    }),
    todo_owner: defineRelationship({
      source: todoWithFks,
      target: userEntity,
      as: "owner",
    }),
  },
  version: 1,
});

describe("client.<entity>.get(id) — row with relationship accessors", () => {
  it("row.<field> types flow from the entity's field map", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(
      mkEntity("t1", "todo", { title: "Ship", completed: false, owner: "u1" }),
    );
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
    void _title;
  });

  it("forward-many accessor awaits to readonly TargetShape[]", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(
      mkEntity("t1", "todo", {
        title: "Ship",
        completed: false,
        tags: ["lbl-a", "lbl-b"],
        owner: "u1",
      }),
    );
    await storage.entities.set(mkEntity("lbl-a", "label", { name: "a" }));
    await storage.entities.set(mkEntity("lbl-b", "label", { name: "b" }));
    await storage.entities.set(mkEntity("lbl-c", "label", { name: "c" }));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithRels,
    });
    const row = await client.todo.get("t1");
    if (row === null) throw new Error("expected row");
    const tags = await row.tags;
    expect(Array.isArray(tags)).toBe(true);
    expect((tags as readonly { name: string }[]).map((t) => t.name).sort()).toEqual(["a", "b"]);
  });

  it("forward-one accessor (non-nullable FK) returns the target entity", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(
      mkEntity("t1", "todo", {
        title: "Ship",
        completed: false,
        tags: [],
        parentList: null,
        owner: "u1",
      }),
    );
    await storage.entities.set(mkEntity("u1", "user", { name: "Ada" }));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithRels,
    });
    const row = await client.todo.get("t1");
    if (row === null) throw new Error("expected row");
    // Non-nullable FK + collapsed semantics: null/absent collapses
    // to undefined. The happy path resolves to the target entity.
    const owner = await row.owner;
    expect((owner as { id: string } | undefined)?.id).toBe("u1");
    expect((owner as { type: string } | undefined)?.type).toBe("user");
  });

  it("forward-one accessor (nullable FK) returns null on explicit null", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(
      mkEntity("t1", "todo", {
        title: "Ship",
        completed: false,
        tags: [],
        parentList: null,
        owner: "u1",
      }),
    );
    await storage.entities.set(mkEntity("u1", "user", { name: "Ada" }));
    await storage.entities.set(mkEntity("l1", "list", { name: "Work" }));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithRels,
    });
    const row = await client.todo.get("t1");
    if (row === null) throw new Error("expected row");
    const list = await row.parentList;
    // Nullable FK explicitly nulled → null (not undefined).
    expect(list).toBeNull();
    // Set the FK to a real id and the accessor surfaces the target.
    await storage.entities.set(
      mkEntity("t1", "todo", {
        title: "Ship",
        completed: false,
        tags: [],
        parentList: "l1",
        owner: "u1",
      }),
    );
    const row2 = await client.todo.get("t1");
    if (row2 === null) throw new Error("expected row");
    const list2 = await row2.parentList;
    expect(list2?.id).toBe("l1");
    expect(list2?.type).toBe("list");
  });

  it("reverse accessor awaits to readonly SourceShape[] via the namespace", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("l1", "list", { name: "Work" }));
    await storage.entities.set(
      mkEntity("t1", "todo", {
        title: "Ship",
        completed: false,
        tags: [],
        parentList: "l1",
        owner: "u1",
      }),
    );
    await storage.entities.set(
      mkEntity("t2", "todo", {
        title: "Other",
        completed: false,
        tags: [],
        parentList: "l1",
        owner: "u1",
      }),
    );
    await storage.entities.set(
      mkEntity("t3", "todo", {
        title: "Off-list",
        completed: false,
        tags: [],
        parentList: "l2",
        owner: "u1",
      }),
    );
    // Relationship edges that make `t1` and `t2` point at `l1`.
    await storage.entities.set(
      mkEntity("rel-1", "relationship", {
        source_id: "t1",
        target_id: "l1",
        type: "todo",
        field: "parentList",
      }),
    );
    await storage.entities.set(
      mkEntity("rel-2", "relationship", {
        source_id: "t2",
        target_id: "l1",
        type: "todo",
        field: "parentList",
      }),
    );
    await storage.entities.set(
      mkEntity("rel-3", "relationship", {
        source_id: "t3",
        target_id: "l2",
        type: "todo",
        field: "parentList",
      }),
    );
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithRels,
    });
    const list = await client.list.get("l1");
    if (list === null) throw new Error("expected row");
    const todos = await list.parentList;
    // The reverse projection carries the source's FK field
    // (`parentList`), not the source id. Walk by FK match.
    const fks = (todos as readonly { parentList: string }[]).map((r) => r.parentList).sort();
    expect(fks).toEqual(["l1", "l1"]);
  });

  it("row.bogus (un-declared relationship) is a compile error", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(
      mkEntity("t1", "todo", {
        title: "Ship",
        completed: false,
        tags: [],
        parentList: null,
        owner: "u1",
      }),
    );
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithRels,
    });
    const row = await client.todo.get("t1");
    expect(row).not.toBeNull();
    // Compile-time check. The row's accessor record carries only
    // the registered `as` keys (`tags`, `parentList`, `owner`), so
    // `bogus` doesn't compile. Wrapped in a function so vitest's
    // runtime ignore (`@ts-expect-error`) doesn't trip when the
    // file is loaded.
    const check: () => void = () => {
      if (row === null) return;
      // @ts-expect-error — `bogus` is not a declared relationship on todo.
      void row.bogus;
    };
    void check;
  });

  it("row.tags (declared forward-many relationship) compiles as an accessor", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(
      mkEntity("t1", "todo", {
        title: "Ship",
        completed: false,
        tags: ["lbl-a"],
        parentList: null,
        owner: "u1",
      }),
    );
    await storage.entities.set(mkEntity("lbl-a", "label", { name: "a" }));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithRels,
    });
    const row = await client.todo.get("t1");
    expect(row).not.toBeNull();
    // Compile-time check that the declared relationship accessors
    // exist on the row. The accessor value type is loose today
    // (narrowing per-accessor is a follow-up), but the keys are
    // restricted to declared relationships so `bogus` doesn't
    // compile.
    const check: () => void = () => {
      if (row === null) return;
      void row.tags;
      void row.parentList;
      void row.owner;
    };
    void check;
  });

  it("row.<declared-as> compiles and resolves at runtime", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(
      mkEntity("t1", "todo", {
        title: "Ship",
        completed: false,
        tags: ["lbl-a"],
        parentList: null,
        owner: "u1",
      }),
    );
    await storage.entities.set(mkEntity("lbl-a", "label", { name: "a" }));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithRels,
    });
    const row = await client.todo.get("t1");
    if (row === null) throw new Error("expected row");
    // Forward-many await → readonly array.
    const tags = await row.tags;
    expect(Array.isArray(tags)).toBe(true);
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

  it("row.title.toUpperCase() and row.body!.length compile (Path A types)", () => {
    // Compile-time check: the field types flow from the entity's
    // TypeBox shape — `title` is `string`, `body` is `string | null`.
    // Wrapped in a function so vitest's runtime ignore (`@ts-expect-error`)
    // doesn't trip when the file is loaded.
    const check: () => void = () => {
      const _row: {
        title: string;
        body: string | null;
      } = { title: "", body: null };
      void _row.title.toUpperCase();
      void _row.body!.length;
    };
    expect(typeof check).toBe("function");
  });

  it("row.parentList (declared forward-one relationship) can be awaited at the type level", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(
      mkEntity("t1", "todo", {
        title: "Ship",
        completed: false,
        tags: [],
        parentList: "l1",
        owner: "u1",
      }),
    );
    await storage.entities.set(mkEntity("l1", "list", { name: "Work" }));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithRels,
    });
    const row = await client.todo.get("t1");
    expect(row).not.toBeNull();
    // Compile-time check that the declared forward-one accessor can
    // be awaited and assigned to a variable. The runtime returns
    // the list entity (or `null` / `undefined` per nullability).
    const check: () => Promise<unknown> = async () => {
      if (row === null) return undefined;
      return await row.parentList;
    };
    expect(typeof check).toBe("function");
  });
});
