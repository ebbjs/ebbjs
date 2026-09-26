/**
 * Tests for `client.<entity>(id)` instance handle.
 *
 * The handle carries typed per-field getters (from the schema's
 * TypeBox field map), a `.entity` escape hatch, and relationship
 * accessors (forward + reverse). The handle's own-field getters
 * read from a synchronous snapshot kept on the client.
 */

import { describe, it, expect } from "vitest";
import type { Entity } from "@ebbjs/core";

import { defineEntity, e } from "../../schema/entity";
import { defineRelationship } from "../../schema/relationship";
import { defineSchema } from "../../schema/schema";
import { createClient } from "../client";

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

const mkRelEntity = (id: string, fields: Record<string, unknown>): Entity =>
  mkEntity(id, "relationship", fields);

const todo = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
  body: e.string().nullable(),
  // `parentList` is a nullable FK — the handle's forward-one
  // accessor for it surfaces the null case.
  parentList: e.string().nullable(),
});

const list = defineEntity("list", {
  name: e.string(),
});

const todoListParent = defineRelationship({
  source: todo,
  target: list,
  as: "parentList",
});

const todoTagsMany = defineRelationship({
  source: todo,
  target: list,
  as: "tags",
  sourceCardinality: "many",
});

// For the reverse accessor test, we need a relationship where the
// source is the entity we're calling on. Here, `list` is the
// source and `todo` is the target — `client.list(id).hasTodos`
// is the forward-many accessor on `list`; the relationship
// entities for it are what the reverse traversal walks.
const listHasTodos = defineRelationship({
  source: list,
  target: todo,
  as: "hasTodos",
  sourceCardinality: "many",
});

const schema = defineSchema({
  entities: { todo, list },
  relationships: {
    todoListParent,
    todoTagsMany,
    listHasTodos,
  },
  version: 1,
});

describe("client.<entity>(id) — typed per-field getters", () => {
  it("AC #1: title returns string for a non-nullable e.string() field", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await client.readLocalEntity("t1");
    // The static type of `title` is `string | undefined`; absent
    // fields resolve to undefined per Path A.
    const title: string | undefined = client.todo("t1").title;
    expect(title).toBe("Ship");
  });

  it("AC #2: body returns string | null for a nullable e.string().nullable() field", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(
      mkEntity("t1", "todo", { title: "Ship", completed: false, body: "note" }),
    );
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await client.readLocalEntity("t1");
    const body: string | null | undefined = client.todo("t1").body;
    expect(body).toBe("note");
  });

  it("AC #2 (null state): body resolves to null when explicitly nulled", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(
      mkEntity("t1", "todo", { title: "Ship", completed: false, body: null }),
    );
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await client.readLocalEntity("t1");
    expect(client.todo("t1").body).toBeNull();
  });

  it("AC #2 (absent state): body resolves to undefined when the field is absent", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await client.readLocalEntity("t1");
    expect(client.todo("t1").body).toBeUndefined();
  });

  it("AC #3: completed returns boolean for an e.boolean() field", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: true }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await client.readLocalEntity("t1");
    const completed: boolean | undefined = client.todo("t1").completed;
    expect(completed).toBe(true);
  });

  it("AC #8: handle.bogus is a compile-time error", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await client.readLocalEntity("t1");
    const handle = client.todo("t1");
    // @ts-expect-error — `bogus` is not in the field map.
    const _bogus = handle.bogus;
    expect(_bogus).toBeUndefined();
  });

  it("AC #8: handle.title.toUpperCase() compiles (string type is provable)", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await client.readLocalEntity("t1");
    const upper: string = client.todo("t1").title!.toUpperCase();
    expect(upper).toBe("SHIP");
  });

  it("handle.id is the entity id", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await client.readLocalEntity("t1");
    expect(client.todo("t1").id).toBe("t1");
  });

  it("returns undefined from every getter when the entity is not materialized", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    const handle = client.todo("missing");
    expect(handle.title).toBeUndefined();
    expect(handle.completed).toBeUndefined();
    expect(handle.body).toBeUndefined();
    expect(handle.id).toBe("missing");
  });
});

describe("client.<entity>(id) — handle.entity escape hatch", () => {
  it("AC #4: handle.entity returns the raw Entity envelope", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await client.readLocalEntity("t1");
    const entity = client.todo("t1").entity;
    expect(entity?.type).toBe("todo");
    expect(entity?.data?.fields?.title?.value).toBe("Ship");
  });

  it("lets users distinguish set / nulled / absent via entity.data?.fields?.[k]?.value", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(
      mkEntity("t1", "todo", { title: "Ship", completed: false, body: null }),
    );
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await client.readLocalEntity("t1");
    const entity = client.todo("t1").entity;
    const body = entity?.data?.fields?.body;
    expect(body).toBeDefined();
    expect(body?.value).toBeNull();
  });

  it("returns the materialized entity when present, undefined when not", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await client.readLocalEntity("t1");
    expect(client.todo("t1").entity?.type).toBe("todo");
    expect(client.todo("missing").entity).toBeUndefined();
  });
});

describe("client.<entity>(id) — forward-many relationship accessor", () => {
  it("AC #5: returns QueryBuilder<TargetFields> resolving to readonly TargetShape[] on await", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("l1", "list", { name: "A" }));
    await storage.entities.set(mkEntity("l2", "list", { name: "B" }));
    await storage.entities.set(mkEntity("l3", "list", { name: "C" }));
    await storage.entities.set(
      mkEntity("t1", "todo", { title: "x", completed: false, tags: ["l1", "l2"] }),
    );
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await client.readLocalEntity("t1");
    // `tags` is a forward-many relationship accessor; awaiting it
    // resolves to the projected list rows. The static type is
    // `unknown` (relationship accessors aren't narrowed at the
    // type level due to TS recursion limits — runtime projects
    // to typed rows via the QueryBuilder's `then`); we cast to
    // pin the runtime shape.
    const tagsHandle = (await client.todo("t1")) as unknown as {
      tags: Promise<readonly unknown[]>;
    };
    const tags = (await tagsHandle.tags) as readonly { name: string }[];
    expect(tags.map((l) => l.name).sort()).toEqual(["A", "B"]);
  });

  it("chains eq / limit on the forward-many accessor before materializing", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("l1", "list", { name: "A" }));
    await storage.entities.set(mkEntity("l2", "list", { name: "B" }));
    await storage.entities.set(
      mkEntity("t1", "todo", { title: "x", completed: false, tags: ["l1", "l2"] }),
    );
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await client.readLocalEntity("t1");
    const out = (
      (await client.todo("t1")) as unknown as {
        tags: { eq: (field: string, value: string) => Promise<readonly unknown[]> };
      }
    ).tags;
    const rows = (await out.eq("name", "A")) as readonly { name: string }[];
    expect(rows.map((l) => l.name)).toEqual(["A"]);
  });
});

describe("client.<entity>(id) — reverse relationship accessor", () => {
  it("AC #5: returns QueryBuilder<SourceFields> resolving to readonly SourceShape[] on await", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("l1", "list", { name: "A" }));
    await storage.entities.set(mkEntity("t1", "todo", { title: "x", completed: false }));
    await storage.entities.set(mkEntity("t2", "todo", { title: "y", completed: true }));
    await storage.entities.set(
      mkRelEntity("rel_1", {
        source_id: "t1",
        target_id: "l1",
        type: "todo",
        field: "parentList",
      }),
    );
    await storage.entities.set(
      mkRelEntity("rel_2", {
        source_id: "t2",
        target_id: "l1",
        type: "todo",
        field: "parentList",
      }),
    );
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await client.readLocalEntity("l1");
    // Reverse accessor for `parentList` (source: todo, target: list)
    // surfaces the source set on `list`. The static type is
    // `unknown` (see the forward-many test for the same caveat);
    // we cast to the runtime shape.
    const revHandle = (await client.list("l1")) as unknown as {
      parentList: Promise<readonly unknown[]>;
    };
    const todos = (await revHandle.parentList) as readonly { title: string }[];
    expect(todos.map((t) => t.title).sort()).toEqual(["x", "y"]);
  });

  it("chains eq / limit on the reverse accessor before materializing", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("l1", "list", { name: "A" }));
    await storage.entities.set(mkEntity("t1", "todo", { title: "x", completed: false }));
    await storage.entities.set(mkEntity("t2", "todo", { title: "y", completed: true }));
    await storage.entities.set(
      mkRelEntity("rel_1", {
        source_id: "t1",
        target_id: "l1",
        type: "todo",
        field: "parentList",
      }),
    );
    await storage.entities.set(
      mkRelEntity("rel_2", {
        source_id: "t2",
        target_id: "l1",
        type: "todo",
        field: "parentList",
      }),
    );
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await client.readLocalEntity("l1");
    const reverse = (await client.list("l1")) as unknown as {
      parentList: {
        eq: (field: string, value: boolean) => Promise<readonly unknown[]>;
      };
    };
    const open = (await reverse.parentList.eq("completed", false)) as readonly {
      title: string;
    }[];
    expect(open.map((t) => t.title)).toEqual(["x"]);
  });
});

describe("client.<entity>(id) — forward-one relationship accessor", () => {
  it("AC #6: nullable FK returns the target entity on await", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("l1", "list", { name: "A" }));
    await storage.entities.set(
      mkEntity("t1", "todo", { title: "Ship", completed: false, parentList: "l1" }),
    );
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await client.readLocalEntity("t1");
    // The `parentList` field is the FK; the forward-one accessor
    // is keyed by `rel.as`. We use a relationship whose `as` matches
    // the field name so the runtime can locate the FK. The static
    // type is `unknown` (relationship accessors aren't narrowed at
    // the type level); we cast to the runtime shape.
    const forwardHandle = client.todo("t1") as unknown as {
      parentList: Promise<{ id: string } | null | undefined>;
    };
    const result = await forwardHandle.parentList;
    expect(result?.id).toBe("l1");
  });

  it("returns null when the nullable FK is nulled", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(
      mkEntity("t1", "todo", { title: "Ship", completed: false, parentList: null }),
    );
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await client.readLocalEntity("t1");
    const forwardHandle = client.todo("t1") as unknown as {
      parentList: Promise<{ id: string } | null | undefined>;
    };
    expect(await forwardHandle.parentList).toBeNull();
  });

  it("returns undefined when the source is not materialized", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    const forwardHandle = client.todo("missing") as unknown as {
      parentList: Promise<{ id: string } | null | undefined>;
    };
    expect(await forwardHandle.parentList).toBeUndefined();
  });
});

describe("handle keeps writes through update path", () => {
  it("AC #7: getters stay consistent after re-hydration through readLocalEntity", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await client.readLocalEntity("t1");
    expect(client.todo("t1").title).toBe("Ship");
    // Simulate an inbound update (catchUp writes to storage).
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship it", completed: true }));
    // Re-hydrate the snapshot through readLocalEntity.
    await client.readLocalEntity("t1");
    expect(client.todo("t1").title).toBe("Ship it");
    expect(client.todo("t1").completed).toBe(true);
  });
});

describe("client without a schema", () => {
  it("does not expose entity handles", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage");
    const storage = createMemoryAdapter();
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage });
    // No schema → no typed entity access.
    expect((client as unknown as Record<string, unknown>)["todo"]).toBeUndefined();
  });
});
