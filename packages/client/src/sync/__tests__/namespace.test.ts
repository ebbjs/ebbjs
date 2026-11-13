/**
 * Tests for `client.<entity>.query()` namespace mount.
 */

import { describe, it, expect, vi } from "vitest";
import { type Static } from "@sinclair/typebox/type";
import { makeHlc, type Action } from "@ebbjs/core";
import type { Entity } from "@ebbjs/core";
import type { Replica, StorageAdapter } from "@ebbjs/storage/types";

import {
  defineComponent,
  defineModel,
  e,
  type GroupFields,
  type GroupMemberFields,
} from "@ebbjs/schema";
import { defineSchema } from "@ebbjs/schema";
import { defineRelationship } from "@ebbjs/schema";
import type { GrantFieldMap, GroupFieldMap } from "../system-row";
import { EntityValidationError } from "@ebbjs/schema";
import { defineAction } from "../../schema/action";
import type { EntityFields, WireStatic } from "../namespace";
import type { QueryBuilder } from "../query-builder";
import { createClient } from "../client";
import { platformEntity, seedReplicaRow } from "../test-utils";
import { rowReadComponentsFor } from "../query-plan";

const todo = defineModel("todo", {
  title: e.string(),
  completed: e.boolean(),
});

const user = defineModel("user", {
  name: e.string(),
});

const schema = defineSchema({
  models: { todo, user },
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
  exists: true,
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 0,
});

describe("client.<entity>.query()", () => {
  it("a tombstoned leaf projects as absent, same as a missing one, through query() and get()", async () => {
    const todoWithBody = defineModel("todo", {
      title: e.string(),
      body: e.string(),
    });
    const schemaWithBody = defineSchema({
      models: { todo: todoWithBody },
      version: 1,
    });
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithBody,
    });
    await seedQueryRow(
      storage,
      client.replica,
      mkEntity("t1", "todo", { title: "a", body: "note" }),
    );
    await seedQueryRow(storage, client.replica, mkEntity("t2", "todo", { title: "b", body: null }));
    await seedQueryRow(storage, client.replica, mkEntity("t3", "todo", { title: "c" }));

    const rows = await client.todo.query();
    expect(rows.find((r) => r.title === "a")?.body).toBe("note");
    expect(rows.find((r) => r.title === "b")?.body).toBeUndefined();
    expect(rows.find((r) => r.title === "c")?.body).toBeUndefined();

    // `get()` projects through its own path; a tombstone and a missing
    // component must read the same there too.
    expect((await client.todo.get("t1"))?.body).toBe("note");
    expect((await client.todo.get("t2"))?.body).toBeUndefined();
    expect((await client.todo.get("t3"))?.body).toBeUndefined();
  });

  it("fills a declared default through query() and get()", async () => {
    const task = defineModel("task", {
      title: e.string(),
      priority: e.string().default("normal"),
    });
    const taskSchema = defineSchema({ models: { task }, version: 1 });
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: taskSchema,
    });
    await seedQueryRow(storage, client.replica, mkEntity("t1", "task", { title: "a" }));

    const rows = await client.task.query();
    expect(rows[0]?.priority).toBe("normal");
    expect((await client.task.get("t1"))?.priority).toBe("normal");
  });

  it(".toRaw() returns readonly Entity[] — the untyped wire shape", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await seedQueryRow(
      storage,
      client.replica,
      mkEntity("t1", "todo", { title: "a", completed: false }),
    );

    const out = await client.todo.query().where("completed", false).toRaw();
    expect(out[0]?.type).toBe("todo");
    expect(out[0]?.data?.fields?.title?.value).toBe("a");
  });

  it("query rows carry the entity id", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await seedQueryRow(
      storage,
      client.replica,
      mkEntity("t1", "todo", { title: "a", completed: false }),
    );
    await seedQueryRow(
      storage,
      client.replica,
      mkEntity("t2", "todo", { title: "b", completed: true }),
    );

    // Compile-time proof: the projected row exposes `id` with no cast.
    const rows = await client.todo.query();
    expect(rows.map((r) => r.id).sort()).toEqual(["t1", "t2"]);
    expect(rows.map((r) => r.title).sort()).toEqual(["a", "b"]);
  });

  it("rows are readonly Todo[] where Todo = Static<typeof schema.models.todo.shape>", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await seedQueryRow(
      storage,
      client.replica,
      mkEntity("t1", "todo", { title: "Ship", completed: false }),
    );

    type Todo = Static<typeof schema.models.todo.shape>;
    const rows: readonly Todo[] = await client.todo.query();
    expect(rows[0]?.title).toBe("Ship");
    expect(rows[0]?.completed).toBe(false);
  });

  it("rows.map((r) => r.bogus) is a compile error", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await seedQueryRow(
      storage,
      client.replica,
      mkEntity("t1", "todo", { title: "Ship", completed: false }),
    );

    const rows = await client.todo.query();
    rows.map((r) => r.title);
    // @ts-expect-error — `bogus` is not in the field map.
    rows.map((r) => r.bogus);
    expect(true).toBe(true);
  });

  it("exposes a separate namespace per schema entity", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    await seedQueryRow(storage, client.replica, mkEntity("u1", "user", { name: "Ada" }));
    await seedQueryRow(
      storage,
      client.replica,
      mkEntity("t1", "todo", { title: "a", completed: false }),
    );

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
  it("resolves to Todo | null where Todo = Static<typeof schema.models.todo.shape>", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    type Todo = Static<typeof schema.models.todo.shape>;
    const row: Todo | null = await client.todo.get("t1");
    expect(row).not.toBeNull();
    expect(row?.title).toBe("Ship");
    expect(row?.completed).toBe(false);
  });

  it("the entity id wins over a relationship accessor named `id`", async () => {
    const idAccessorSchema = defineSchema({
      models: { todo, user },
      relationships: {
        todo_user_id: defineRelationship({
          source: todo,
          target: user,
          as: "id",
          sourceCardinality: "one",
        }),
      },
      version: 1,
    });
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: idAccessorSchema,
    });
    const row = await client.todo.get("t1");
    // Compile-time proof: the row's `id` stays `string`, not the accessor's promise.
    const entityId: string | undefined = row?.id;
    expect(entityId).toBe("t1");
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

  it("does not expose the untyped wire envelope on the projected row", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
    const row = await client.todo.get("t1");
    // `id` is the addressing key, not envelope access; the wire
    // envelope itself (`data`, `type`) stays off the row. Users wanting
    // it use `client.readLocalEntity(id)` instead.
    expect(row?.id).toBe("t1");
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
const todoEntity = defineModel("todo", {
  title: e.string(),
  completed: e.boolean(),
});
const labelEntity = defineModel("label", {
  name: e.string(),
});
const listEntity = defineModel("list", {
  name: e.string(),
});
const userEntity = defineModel("user", {
  name: e.string(),
});

const schemaWithRels = defineSchema({
  models: {
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
): Entity =>
  platformEntity(id, "relationship", { source_id: sourceId, target_id: targetId, type, field });

/** Materialize one `ebb/membership` row into the local cache. */
const mkEntityGroup = (id: string, entityId: string, groupId: string): Entity =>
  platformEntity(id, "entityGroup", { entity_id: entityId, group_id: groupId });

/**
 * Write `row` to the shim and fold it into the replica the query
 * reads. The fold runs first so the replica is current when the shim
 * read happens, matching `applyLocalAction`.
 */
const seedQueryRow = async (
  storage: StorageAdapter,
  replica: Replica,
  row: Entity,
): Promise<void> => {
  seedReplicaRow(replica, row);
  await storage.entities.set(row);
};

/**
 * The row accessors read the replica's adjacency (#520), so mirror the
 * shim's live link / membership rows into it. Entity rows stay on the shim —
 * only the adjacency indices feed traversal. Both kinds are `ebb` rows, so the
 * component index names them.
 */
const syncAdjacency = async (storage: StorageAdapter, replica: Replica): Promise<void> => {
  for (const component of ["ebb/link", "ebb/membership"]) {
    for (const id of await storage.entities.queryByComponent(component)) {
      const row = await storage.entities.get(id);
      if (row !== null && row.deleted_hlc === null) seedReplicaRow(replica, row, "replace");
    }
  }
};

// ---------------------------------------------------------------------------
// client.<entity>.query().where() — registry-aware predicate (#247)
// ---------------------------------------------------------------------------

/**
 * `todo` carries an `owner` FIELD alongside an `owner` RELATIONSHIP so
 * the collision test can prove the relationship wins. `document`
 * exercises built-in `groups` membership, answered from `entityGroup`
 * rows rather than a declared relationship.
 */
const whereTodo = defineModel("todo", {
  title: e.string(),
  completed: e.boolean(),
  owner: e.string(),
});
const whereDocument = defineModel("document", { title: e.string() });

const schemaForWhere = defineSchema({
  models: {
    todo: whereTodo,
    list: listEntity,
    document: whereDocument,
    user: userEntity,
  },
  relationships: {
    todo_list: defineRelationship({ source: whereTodo, target: listEntity, as: "list" }),
    todo_owner: defineRelationship({ source: whereTodo, target: userEntity, as: "owner" }),
  },
  version: 1,
});

describe("client.<entity>.query().where() — registry-aware predicate", () => {
  const buildClient = async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaForWhere,
    });
    const seed = (row: Entity) => seedQueryRow(storage, client.replica, row);
    return { storage, client, seed };
  };

  const todo = (id: string, title: string, completed = false, owner: string | null = null) =>
    mkEntity(id, "todo", { title, completed, owner });

  it("infers a field predicate when the key is not a registered relationship", async () => {
    const { client, seed } = await buildClient();
    await seed(todo("t1", "a", false));
    await seed(todo("t2", "b", true));
    const out = await client.todo.query().where("completed", false);
    expect(out.map((r) => r.title)).toEqual(["a"]);
  });

  it('infers a relationship predicate from the registry: where("list", listId)', async () => {
    const { client, seed } = await buildClient();
    await seed(todo("t1", "a"));
    await seed(todo("t2", "b"));
    await seed(mkRelEntity("r1", "t1", "l1", "list", "todo"));
    await seed(mkRelEntity("r2", "t2", "l2", "list", "todo"));
    const out = await client.todo.query().where("list", "l1");
    expect(out.map((r) => r.title)).toEqual(["a"]);
  });

  it('where("groups", groupId) returns the documents whose membership includes it', async () => {
    const { client, seed } = await buildClient();
    await seed(mkEntity("d1", "document", { title: "one" }));
    await seed(mkEntity("d2", "document", { title: "two" }));
    await seed(mkEntityGroup("eg1", "d1", "g1"));
    await seed(mkEntityGroup("eg2", "d2", "g2"));
    const out = await client.document.query().where("groups", "g1");
    expect(out.map((r) => r.title)).toEqual(["one"]);
  });

  it('where("groups", groupId) does not scan entityGroup (uses the membership index)', async () => {
    const { storage, client, seed } = await buildClient();
    await seed(mkEntity("d1", "document", { title: "one" }));
    await seed(mkEntityGroup("eg1", "d1", "g1"));
    const querySpy = vi.spyOn(storage.entities, "query");
    const membershipSpy = vi.spyOn(client.replica, "memberships");

    const out = await client.document.query().where("groups", "g1");

    expect(out.map((r) => r.title)).toEqual(["one"]);
    expect(membershipSpy).toHaveBeenCalledWith({ groupId: "g1" });
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("query rows expose their group ids from the membership index", async () => {
    const { storage, client, seed } = await buildClient();
    await seed(mkEntity("d1", "document", { title: "one" }));
    await seed(mkEntity("d2", "document", { title: "two" }));
    await seed(mkEntityGroup("eg1", "d1", "g1"));
    await seed(mkEntityGroup("eg2", "d1", "g2"));
    await seed(mkEntityGroup("eg3", "d2", "g1"));
    const querySpy = vi.spyOn(storage.entities, "query");
    const membershipSpy = vi.spyOn(client.replica, "memberships");

    const rows = await client.document.query().orderBy("title", "asc");

    expect(rows.map((row) => ({ title: row.title, groupIds: row.groupIds }))).toEqual([
      { title: "one", groupIds: ["g1", "g2"] },
      { title: "two", groupIds: ["g1"] },
    ]);
    // One entity-keyed index lookup per projected row, no entityGroup scan.
    expect(membershipSpy.mock.calls).toEqual([[{ entityId: "d1" }], [{ entityId: "d2" }]]);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("a row with no membership exposes an empty groupIds", async () => {
    const { client, seed } = await buildClient();
    await seed(mkEntity("d1", "document", { title: "one" }));
    const [row] = await client.document.query();
    expect(row?.groupIds).toEqual([]);
  });

  it(".first() carries groupIds", async () => {
    const { client, seed } = await buildClient();
    await seed(mkEntity("d1", "document", { title: "one" }));
    await seed(mkEntityGroup("eg1", "d1", "g1"));
    const row = await client.document.query().first();
    expect(row?.groupIds).toEqual(["g1"]);
  });

  it("a tombstoned entityGroup row is not in groupIds", async () => {
    const { client, seed } = await buildClient();
    await seed(mkEntity("d1", "document", { title: "one" }));
    await seed(mkEntityGroup("eg1", "d1", "g1"));
    await seed({ ...mkEntityGroup("eg1", "d1", "g1"), deleted_hlc: "2" });
    const [row] = await client.document.query();
    expect(row?.groupIds).toEqual([]);
  });

  it('where("groups", [...]) unions the named groups (any-of)', async () => {
    const { client, seed } = await buildClient();
    await seed(mkEntity("d1", "document", { title: "one" }));
    await seed(mkEntity("d2", "document", { title: "two" }));
    await seed(mkEntity("d3", "document", { title: "three" }));
    await seed(mkEntityGroup("eg1", "d1", "g1"));
    await seed(mkEntityGroup("eg2", "d2", "g2"));
    await seed(mkEntityGroup("eg3", "d3", "g3"));
    const out = await client.document.query().where("groups", ["g1", "g3"]);
    expect(out.map((r) => r.title).sort()).toEqual(["one", "three"]);
  });

  it("a tombstoned entityGroup row is not a membership", async () => {
    const { client, seed } = await buildClient();
    await seed(mkEntity("d1", "document", { title: "one" }));
    await seed(mkEntityGroup("eg1", "d1", "g1"));
    expect(await client.document.query().where("groups", "g1")).toHaveLength(1);
    await seed({ ...mkEntityGroup("eg1", "d1", "g1"), deleted_hlc: "2" });
    expect(await client.document.query().where("groups", "g1")).toEqual([]);
  });

  it("accepts a { id } handle and a materialized entity as membership targets", async () => {
    const { storage, client, seed } = await buildClient();
    await seed(mkEntity("d1", "document", { title: "one" }));
    await seed(mkEntity("grp1", "group", { name: "team" }));
    await seed(mkEntityGroup("eg1", "d1", "grp1"));
    const byHandle = await client.document.query().where("groups", { id: "grp1" });
    expect(byHandle.map((r) => r.title)).toEqual(["one"]);
    const handle = await storage.entities.get("grp1");
    if (handle === null) throw new Error("unreachable");
    const byRow = await client.document.query().where("groups", handle);
    expect(byRow.map((r) => r.title)).toEqual(["one"]);
  });

  it("a null / undefined / empty membership target matches nothing", async () => {
    const { client, seed } = await buildClient();
    await seed(mkEntity("d1", "document", { title: "one" }));
    await seed(mkEntityGroup("eg1", "d1", "g1"));
    expect(await client.document.query().where("groups", null)).toEqual([]);
    expect(await client.document.query().where("groups", undefined)).toEqual([]);
    expect(await client.document.query().where("groups", [])).toEqual([]);
  });

  it("intersects membership with a field predicate", async () => {
    const { client, seed } = await buildClient();
    await seed(mkEntity("d1", "document", { title: "one" }));
    await seed(mkEntity("d2", "document", { title: "two" }));
    await seed(mkEntityGroup("eg1", "d1", "g1"));
    await seed(mkEntityGroup("eg2", "d2", "g1"));
    const out = await client.document.query().where("groups", "g1").where("title", "one");
    expect(out.map((r) => r.title)).toEqual(["one"]);
  });

  it("intersects membership with a domain relationship predicate", async () => {
    const { client, seed } = await buildClient();
    await seed(todo("t1", "a"));
    await seed(todo("t2", "b"));
    await seed(mkEntityGroup("eg1", "t1", "g1"));
    await seed(mkEntityGroup("eg2", "t2", "g1"));
    await seed(mkRelEntity("r1", "t1", "l1", "list", "todo"));
    const out = await client.todo.query().where("groups", "g1").where("list", "l1");
    expect(out.map((r) => r.title)).toEqual(["a"]);
  });

  it("intersects membership with membership (both groups must include the entity)", async () => {
    const { client, seed } = await buildClient();
    await seed(mkEntity("d1", "document", { title: "one" }));
    await seed(mkEntity("d2", "document", { title: "two" }));
    await seed(mkEntityGroup("eg1", "d1", "g1"));
    await seed(mkEntityGroup("eg2", "d1", "g2"));
    await seed(mkEntityGroup("eg3", "d2", "g1"));
    const out = await client.document.query().where("groups", "g1").where("groups", "g2");
    expect(out.map((r) => r.title)).toEqual(["one"]);
  });

  it("picks up a membership row that is only in the action log (dirty replay)", async () => {
    const { storage, client, seed } = await buildClient();
    await seed(mkEntity("d1", "document", { title: "one" }));
    // The membership exists only as an Action: `entities.set` was never
    // called, so the shim row is dirty and unmaterialized. Hydrating the
    // replica replays the log, so the predicate's membership index sees it.
    const hlc = makeHlc(1711036800000);
    const action: Action = {
      id: "a_1",
      actor_id: "a_1",
      hlc,
      gsn: 1,
      updates: [
        {
          id: "u_1",
          subject_id: "eg1",
          component: "ebb/membership",
          method: "replace",
          data: { value: { entity_id: "d1", group_id: "g1" }, update_id: "u_1", hlc },
        },
      ],
    };
    await storage.actions.append(action);
    expect(await storage.dirtyTracker.isDirty("eg1")).toBe(true);
    const out = await client.document.query().where("groups", "g1");
    expect(out.map((r) => r.title)).toEqual(["one"]);
  });

  it("a relationship key wins over a same-named field", async () => {
    const { client, seed } = await buildClient();
    // t1's field says u1, but its edge points at u2.
    await seed(todo("t1", "a", false, "u1"));
    // t2's field says u2, but it has no edge at all.
    await seed(todo("t2", "b", false, "u2"));
    await seed(mkRelEntity("r1", "t1", "u2", "owner", "todo"));
    const out = await client.todo.query().where("owner", "u2");
    expect(out.map((r) => r.title)).toEqual(["a"]);
  });

  it("an array target means any-of", async () => {
    const { client, seed } = await buildClient();
    await seed(todo("t1", "a"));
    await seed(todo("t2", "b"));
    await seed(todo("t3", "c"));
    await seed(mkRelEntity("r1", "t1", "l1", "list", "todo"));
    await seed(mkRelEntity("r2", "t2", "l2", "list", "todo"));
    await seed(mkRelEntity("r3", "t3", "l3", "list", "todo"));
    const out = await client.todo.query().where("list", ["l1", "l3"]);
    expect(out.map((r) => r.title).sort()).toEqual(["a", "c"]);
  });

  it("chained where(...) calls are ANDed (all-of)", async () => {
    const { client, seed } = await buildClient();
    await seed(todo("t1", "a"));
    await seed(todo("t2", "b"));
    await seed(todo("t3", "c"));
    await seed(mkRelEntity("r1", "t1", "l1", "list", "todo"));
    await seed(mkRelEntity("r2", "t2", "l1", "list", "todo"));
    await seed(mkRelEntity("r3", "t3", "l2", "list", "todo"));
    await seed(mkRelEntity("o1", "t1", "u1", "owner", "todo"));
    await seed(mkRelEntity("o2", "t2", "u2", "owner", "todo"));
    const out = await client.todo.query().where("list", "l1").where("owner", "u1");
    expect(out.map((r) => r.title)).toEqual(["a"]);
  });

  it(".or unions a relationship branch with a field branch", async () => {
    const { client, seed } = await buildClient();
    await seed(todo("t1", "a", false));
    await seed(todo("t2", "b", false));
    await seed(todo("t3", "c", true));
    await seed(mkRelEntity("r1", "t1", "l1", "list", "todo"));
    const out = await client.todo.query().where("list", "l1").or("completed", true);
    expect(out.map((r) => r.title).sort()).toEqual(["a", "c"]);
  });

  it('.or("groups", ...) unions a membership branch with a relationship branch', async () => {
    const { client, seed } = await buildClient();
    await seed(todo("t1", "a"));
    await seed(todo("t2", "b"));
    await seed(todo("t3", "c"));
    await seed(mkRelEntity("r1", "t1", "l1", "list", "todo"));
    await seed(mkEntityGroup("eg1", "t2", "g1"));
    const out = await client.todo.query().where("list", "l1").or("groups", "g1");
    expect(out.map((r) => r.title).sort()).toEqual(["a", "b"]);
  });

  it("an .or membership branch unions with a field branch and dedupes", async () => {
    const { client, seed } = await buildClient();
    await seed(mkEntity("d1", "document", { title: "one" }));
    await seed(mkEntity("d2", "document", { title: "two" }));
    await seed(mkEntity("d3", "document", { title: "three" }));
    await seed(mkEntityGroup("eg1", "d1", "g1"));
    // d1 is in g1 AND matches the field branch: it must appear once.
    const out = await client.document.query().where("title", "one").or("groups", "g1");
    expect(out.map((r) => r.title)).toEqual(["one"]);
  });

  it("an .or relationship group with no live edge contributes nothing", async () => {
    const { client, seed } = await buildClient();
    await seed(todo("t1", "a", false));
    await seed(todo("t2", "b", true));
    expect(
      (await client.todo.query().where("completed", false).or("list", "missing")).map(
        (r) => r.title,
      ),
    ).toEqual(["a"]);
    expect(await client.todo.query().where("completed", false).or("list", null)).toHaveLength(1);
    expect(await client.todo.query().where("completed", false).or("list", [])).toHaveLength(1);
  });

  it(".or array target stays any-of within that branch", async () => {
    const { client, seed } = await buildClient();
    await seed(todo("t1", "a"));
    await seed(todo("t2", "b"));
    await seed(todo("t3", "c"));
    await seed(mkRelEntity("r1", "t1", "l1", "list", "todo"));
    await seed(mkRelEntity("r2", "t2", "l2", "list", "todo"));
    await seed(mkRelEntity("r3", "t3", "l3", "list", "todo"));
    const out = await client.todo.query().where("completed", true).or("list", ["l1", "l3"]);
    expect(out.map((r) => r.title).sort()).toEqual(["a", "c"]);
  });

  it('.or("groups", [...]) stays any-of within the membership branch', async () => {
    const { client, seed } = await buildClient();
    await seed(mkEntity("d1", "document", { title: "one" }));
    await seed(mkEntity("d2", "document", { title: "two" }));
    await seed(mkEntity("d3", "document", { title: "three" }));
    await seed(mkEntityGroup("eg1", "d1", "g1"));
    await seed(mkEntityGroup("eg2", "d2", "g2"));
    const out = await client.document.query().or("groups", ["g1", "g2"]);
    expect(out.map((r) => r.title).sort()).toEqual(["one", "two"]);
  });

  it("throws on an .or key that is neither a field nor a declared relationship", async () => {
    const { client } = await buildClient();
    expect(() => client.todo.query().or("nope", "x")).toThrow(/or\("nope"\)/);
  });

  it("intersects a field predicate with a relationship predicate", async () => {
    const { client, seed } = await buildClient();
    await seed(todo("t1", "a", false));
    await seed(todo("t2", "b", false));
    await seed(todo("t3", "c", true));
    await seed(mkRelEntity("r1", "t1", "l1", "list", "todo"));
    await seed(mkRelEntity("r2", "t2", "l2", "list", "todo"));
    await seed(mkRelEntity("r3", "t3", "l1", "list", "todo"));
    const out = await client.todo.query().where("completed", false).where("list", "l1");
    expect(out.map((r) => r.title)).toEqual(["a"]);
  });

  it("excludes a source whose relationship row is tombstoned", async () => {
    const { client, seed } = await buildClient();
    await seed(todo("t1", "a"));
    await seed(mkRelEntity("r1", "t1", "l1", "list", "todo"));
    expect(await client.todo.query().where("list", "l1")).toHaveLength(1);
    await seed({
      ...mkRelEntity("r1", "t1", "l1", "list", "todo"),
      deleted_hlc: "2",
    });
    expect(await client.todo.query().where("list", "l1")).toEqual([]);
  });

  it("accepts a { id } handle and a materialized entity as relationship targets", async () => {
    const { storage, client, seed } = await buildClient();
    await seed(todo("t1", "a"));
    await seed(mkEntity("l1", "list", { name: "inbox" }));
    await seed(mkRelEntity("r1", "t1", "l1", "list", "todo"));
    const byHandle = await client.todo.query().where("list", { id: "l1" });
    expect(byHandle.map((r) => r.title)).toEqual(["a"]);
    const handle = await storage.entities.get("l1");
    if (handle === null) throw new Error("unreachable");
    const byRow = await client.todo.query().where("list", handle);
    expect(byRow.map((r) => r.title)).toEqual(["a"]);
  });

  it("a null / undefined / empty target names no live edge and matches nothing", async () => {
    const { client, seed } = await buildClient();
    await seed(todo("t1", "a"));
    await seed(mkRelEntity("r1", "t1", "l1", "list", "todo"));
    expect(await client.todo.query().where("list", null)).toEqual([]);
    expect(await client.todo.query().where("list", undefined)).toEqual([]);
    expect(await client.todo.query().where("list", [])).toEqual([]);
  });

  it("composes predicates with orderBy and limit", async () => {
    const { client, seed } = await buildClient();
    await seed(mkEntity("d1", "document", { title: "b" }));
    await seed(mkEntity("d2", "document", { title: "a" }));
    await seed(mkEntity("d3", "document", { title: "c" }));
    await seed(mkEntityGroup("eg1", "d1", "g1"));
    await seed(mkEntityGroup("eg2", "d2", "g1"));
    await seed(mkEntityGroup("eg3", "d3", "g1"));
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
    await syncAdjacency(storage, client.replica);
    const row = await client.todo.get("t1");
    if (row === null) throw new Error("expected row");
    const tags: QueryBuilder<EntityFields<typeof labelEntity>> = row.tags;
    const resolved: readonly { name?: string }[] = await tags;
    expect(resolved.map((t) => t.name).sort()).toEqual(["a", "b", "c"]);
  });

  it("routes traversal through the replica's adjacency index, not the storage scan", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    await storage.entities.set(mkEntity("lbl-a", "label", { name: "a" }));
    await storage.entities.set(mkEntity("l1", "list", { name: "Work" }));
    await storage.entities.set(mkEntity("g1", "group", { name: "G" }));
    await storage.entities.set(mkRelEntity("rel-a", "t1", "lbl-a", "tags", "todo"));
    await storage.entities.set(mkRelEntity("rel-parent", "t1", "l1", "parentList", "todo"));
    await storage.entities.set(mkEntityGroup("eg-1", "t1", "g1"));

    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithRels,
    });
    await syncAdjacency(storage, client.replica);

    const query = vi.spyOn(storage.entities, "query");
    const storageForward = vi.spyOn(storage.entities, "queryByRelationshipSource");
    const storageReverse = vi.spyOn(storage.entities, "queryByRelationship");
    const storageMemberships = vi.spyOn(storage.entities, "queryByMembershipEntity");
    const forward = vi.spyOn(client.replica, "relationshipLinks");
    const reverse = vi.spyOn(client.replica, "relationships");
    const memberships = vi.spyOn(client.replica, "membershipLinks");

    const todo = await client.todo.get("t1");
    if (todo === null) throw new Error("expected row");
    await todo.tags;
    await todo.parentList;
    await todo.groups;
    const list = await client.list.get("l1");
    if (list === null) throw new Error("expected row");
    await list.parentList;

    const scannedTypes = query.mock.calls.map(([type]) => type);
    expect(scannedTypes).not.toContain("relationship");
    expect(scannedTypes).not.toContain("entityGroup");
    // The storage adapter's async indices are bypassed; the replica's
    // synchronous ones carry the traversal (#520).
    expect(storageForward).not.toHaveBeenCalled();
    expect(storageReverse).not.toHaveBeenCalled();
    expect(storageMemberships).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalled();
    expect(reverse).toHaveBeenCalled();
    expect(memberships).toHaveBeenCalled();
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
    await syncAdjacency(storage, client.replica);
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
    // No Relationship record for t1.parentList.
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaWithRels,
    });
    await syncAdjacency(storage, client.replica);
    const row = await client.todo.get("t1");
    if (row === null) throw new Error("expected row");
    const parentList: Promise<Entity | null | undefined> = row.parentList;
    const list: Entity | null | undefined = await parentList;
    // No edge in metadata → null.
    expect(list).toBeNull();
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
    await syncAdjacency(storage, client.replica);
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
    await syncAdjacency(storage, client.replica);
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
    const card = defineModel("card", {
      title: e.string(),
      tags: { type: "array", items: { type: "string" } } as never,
    });
    const tag = defineModel("tag", { name: e.string() });
    const schemaWithOverlap = defineSchema({
      models: { card, tag },
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
    await syncAdjacency(storage, client.replica);
    const row = await client.card.get("c1");
    if (row === null) throw new Error("expected row");
    // The accessor type (a QueryBuilder), not the `string[]` field type.
    const tags: QueryBuilder<EntityFields<typeof tag>> = row.tags;
    const resolved: readonly { name?: string }[] = await tags;
    expect(resolved.map((t) => t.name)).toEqual(["a"]);
  });

  it("a self-referential relationship's reverse accessor shadows the forward slot", async () => {
    // `node.parent` is both a forward-one (`node` → `node`) and a
    // reverse (`node` ← `node`). The runtime attaches forward then
    // reverse, so the reverse `QueryBuilder` wins; the static type
    // mirrors that precedence rather than producing an intersection.
    const node = defineModel("node", { label: e.string() });
    const schemaWithSelf = defineSchema({
      models: { node },
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
    await syncAdjacency(storage, client.replica);
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
});

describe("client.group / client.membership — value namespaces", () => {
  const groupsSchema = defineSchema({ models: { todo: todoEntity }, version: 1 });

  const mkClient = async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: groupsSchema,
    });
    return { client, storage };
  };

  it("pins each value field map to the schema's value type", () => {
    // The namespace needs a field map; `@ebbjs/schema` exports the value type.
    // If a component's shape changes, one of these assertions fails to compile
    // rather than the projection silently drifting.
    type Assert<T extends true> = T;
    type GroupPinned = Assert<
      WireStatic<GroupFieldMap> extends GroupFields
        ? GroupFields extends WireStatic<GroupFieldMap>
          ? true
          : false
        : false
    >;
    type GrantPinned = Assert<
      WireStatic<GrantFieldMap> extends GroupMemberFields
        ? GroupMemberFields extends WireStatic<GrantFieldMap>
          ? true
          : false
        : false
    >;
    const groupPinned: GroupPinned = true;
    const grantPinned: GrantPinned = true;
    expect([groupPinned, grantPinned]).toEqual([true, true]);
  });

  it("scopes a group query's read set to ebb/group, never the whole platform model", async () => {
    const { client } = await mkClient();
    const query = client.group.query().toQuery();

    expect(query.source).toBe("ebb");
    // Exact component: `ebb/*` would invalidate a page query built over groups
    // on every grant or membership write.
    expect(query.sourceComponents).toEqual(["ebb/group"]);
    const reads = rowReadComponentsFor(query);
    expect(reads).toContain("ebb/group");
    expect(reads).not.toContain("ebb/*");
  });

  it("reads a group row as {id, name, apps}, not as an ebb envelope", async () => {
    const { client, storage } = await mkClient();
    const row = platformEntity("g1", "group", { name: "Demo", apps: ["notes"] });
    seedReplicaRow(client.replica, row);
    await storage.entities.set(row);

    expect(await client.group.query()).toEqual([
      { id: "g1", name: "Demo", apps: ["notes"], groupIds: [] },
    ]);
    const read = await client.group.get("g1");
    expect(read).toMatchObject({ id: "g1", name: "Demo", apps: ["notes"] });
  });

  it("returns null for a row that carries another platform component", async () => {
    const { client, storage } = await mkClient();
    const grant = platformEntity("gm_1", "groupMember", {
      actor_id: "a",
      group_id: "g1",
      permissions: [],
    });
    seedReplicaRow(client.replica, grant);
    await storage.entities.set(grant);

    expect(await client.group.get("gm_1")).toBeNull();
    expect(await client.group.query()).toEqual([]);
  });
});

describe("doc.groups — built-in membership accessor", () => {
  const groupsSchema = defineSchema({ models: { todo: todoEntity }, version: 1 });

  it("resolves the group rows linked through ebb/membership rows", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    await storage.entities.set(mkEntity("t1", "todo", { title: "Ship", completed: false }));
    await storage.entities.set(platformEntity("g1", "group", { name: "Demo" }));
    await storage.entities.set(mkEntityGroup("eg-1", "t1", "g1"));
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: groupsSchema,
    });
    await syncAdjacency(storage, client.replica);
    const row = await client.todo.get("t1");
    if (row === null) throw new Error("expected row");
    const groups: QueryBuilder<GroupFieldMap> = row.groups;
    const resolved: readonly { name?: string }[] = await groups;
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

  it("exposes the group and membership system namespaces, but not entityGroup", async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: groupsSchema,
    });
    const namespaces = client as unknown as Record<string, unknown>;
    // `group` / `membership` are system namespaces; `entityGroup` stays internal.
    expect(namespaces["group"]).toBeDefined();
    expect(namespaces["membership"]).toBeDefined();
    expect(namespaces["entityGroup"]).toBeUndefined();
  });
});

/**
 * The draft `create` / `update` runtime validation the sibling draft
 * suites do not reach: the `validate: false` opt-out, the empty-patch
 * refusal, a create that omits a defaulted field, the strict create
 * rule, and one error carrying every violation.
 *
 * The stub records every URL so a test can prove a rejection never
 * reached the wire.
 */
describe("draft create / update — runtime validation", () => {
  const todoForCreate = defineModel("todo", {
    title: e.string(),
    completed: e.boolean(),
    // A declared default is what lets `create()` omit a field.
    priority: e.string().default("normal"),
  });

  const schemaForCreate = defineSchema({ models: { todo: todoForCreate }, version: 1 });

  interface CreateParams {
    readonly input: Record<string, unknown>;
    readonly groups: readonly string[];
    readonly validate?: boolean;
  }

  interface UpdateParams {
    readonly id: string;
    readonly patch: Record<string, unknown>;
    readonly validate?: boolean;
  }

  // The payloads are deliberately arbitrary: the runtime validation is the subject.
  const createTodo = defineAction(schemaForCreate, ({ todo: todos }, params: CreateParams) =>
    todos.create(params.input as never, { groups: params.groups, validate: params.validate }),
  );

  const updateTodo = defineAction(
    schemaForCreate,
    ({ todo: todos }, params: UpdateParams): void => {
      todos.update(params.id, params.patch, { validate: params.validate });
    },
  );

  /** Stub `fetch` recording every URL it sees; handshakes and writes both succeed. */
  const mkRecordingStubFetch = (seen: string[]): typeof fetch => {
    return (async (url: string): Promise<Response> => {
      seen.push(url);
      const body = url.endsWith("/sync/handshake")
        ? {
            actor_id: "actor_1",
            groups: [
              { id: "g_1", permissions: ["todo.*"], cursor_valid: true, reason: null, cursor: 0 },
            ],
          }
        : url.endsWith("/sync/actions")
          ? { rejected: [] }
          : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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
      actions: { createTodo, updateTodo },
      fetchImpl: mkRecordingStubFetch(seen),
    });
    await client.handshake();
    return { client, storage };
  };

  /** Membership option every `create()` in this block carries (#244). */
  const createOpts = { groups: ["g_1"] } as const;

  it("create() reports every violation in a single EntityValidationError", async () => {
    const seen: string[] = [];
    const { client } = await mkClient(seen);

    try {
      await client.actions.createTodo({
        input: { title: 42, completed: "no", bogus: "x" },
        ...createOpts,
      });
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
    await expect(
      client.actions.createTodo({
        input: { title: 42, completed: false },
        validate: false,
        ...createOpts,
      }),
    ).resolves.toBeDefined();
    expect(seen.some((u) => u.endsWith("/sync/actions"))).toBe(true);
  });

  it("update() rejects an empty patch as a no-op", async () => {
    const seen: string[] = [];
    const { client } = await mkClient(seen);
    await expect(client.actions.updateTodo({ id: "todo_1", patch: {} })).rejects.toBeInstanceOf(
      EntityValidationError,
    );
    expect(seen.some((u) => u.endsWith("/sync/actions"))).toBe(false);
  });

  it("update({ validate: false }) skips local validation and submits", async () => {
    const seen: string[] = [];
    const { client } = await mkClient(seen);
    await expect(
      client.actions.updateTodo({ id: "todo_1", patch: { title: 42 }, validate: false }),
    ).resolves.toBeUndefined();
    expect(seen.some((u) => u.endsWith("/sync/actions"))).toBe(true);
  });

  it("create() omits a defaulted field from the wire so the default stands", async () => {
    const seen: string[] = [];
    const { client, storage } = await mkClient(seen);
    await expect(
      client.actions.createTodo({
        input: { title: "Ship", completed: false },
        ...createOpts,
      }),
    ).resolves.toBeDefined();
    const rows = await storage.entities.query("todo");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data?.fields).not.toHaveProperty("priority");
  });

  it("create() requires a field with no default", async () => {
    const seen: string[] = [];
    const { client } = await mkClient(seen);
    await expect(
      client.actions.createTodo({
        input: { title: "Ship" },
        ...createOpts,
      }),
    ).rejects.toBeInstanceOf(EntityValidationError);
  });
});

const noteDraft = defineComponent("note/draft", e.string(), { optional: true });

const note = defineModel("note", {
  title: e.string(),
  draft: noteDraft,
});

const schemaForExistence = defineSchema({ models: { note }, version: 1 });

describe("client.<entity>.query().has() / hasNot() — component existence", () => {
  const buildClient = async () => {
    const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: "http://x",
      actorId: "a",
      storage,
      schema: schemaForExistence,
    });
    const seed = (id: string, fields: Record<string, unknown>) =>
      seedQueryRow(storage, client.replica, mkEntity(id, "note", fields));
    return { storage, client, seed };
  };

  const ids = async (chain: PromiseLike<readonly { readonly id: string }[]>) =>
    (await chain).map((row) => row.id).sort();

  it("keeps the rows carrying the component", async () => {
    const { client, seed } = await buildClient();
    await seed("n1", { title: "a", draft: "draft a" });
    await seed("n2", { title: "b" });
    await seed("n3", { title: "c", draft: "draft c" });

    expect(await ids(client.note.query().has("draft"))).toEqual(["n1", "n3"]);
  });

  it("keeps the rows the component is absent from", async () => {
    const { client, seed } = await buildClient();
    await seed("n1", { title: "a", draft: "draft a" });
    await seed("n2", { title: "b" });
    await seed("n3", { title: "c", draft: "draft c" });

    expect(await ids(client.note.query().hasNot("draft"))).toEqual(["n2"]);
  });

  it("counts a cleared component as present, though it projects undefined", async () => {
    const { client, seed } = await buildClient();
    await seed("n1", { title: "a", draft: null });
    await seed("n2", { title: "b" });

    const present = await client.note.query().has("draft");
    expect(present.map((row) => row.id)).toEqual(["n1"]);
    expect(present[0]?.draft).toBeUndefined();
  });

  it("projects a row that lost its last component as absent", async () => {
    const { client, seed } = await buildClient();
    // The row shape a `drop` of the last component leaves: alive, nothing
    // attached. An optional component has no default to fall back to.
    await seed("n1", {});

    const row = await client.note.get("n1");
    expect(row).not.toBeNull();
    expect(row?.draft).toBeUndefined();
    expect(row?.title).toBeUndefined();
    expect(await client.note.query().has("draft")).toEqual([]);
  });

  it("composes with where() in the same AND-group", async () => {
    const { client, seed } = await buildClient();
    await seed("n1", { title: "a", draft: "x" });
    await seed("n2", { title: "a" });
    await seed("n3", { title: "b", draft: "y" });

    const rows = await client.note.query().where("title", "a").has("draft");
    expect(rows.map((row) => row.id)).toEqual(["n1"]);
  });

  it("reads the component index, never the entity store", async () => {
    const { storage, client, seed } = await buildClient();
    await seed("n1", { title: "a", draft: "x" });
    const querySpy = vi.spyOn(storage.entities, "query");
    const componentsSpy = vi.spyOn(client.replica, "components");

    await client.note.query().has("draft");
    expect(componentsSpy).toHaveBeenCalledWith("note/draft");
    expect(querySpy).not.toHaveBeenCalled();

    componentsSpy.mockClear();
    await client.note.query().hasNot("draft");
    expect(componentsSpy).toHaveBeenCalledTimes(1);
    expect(componentsSpy).toHaveBeenCalledWith("note/draft");
  });

  it("records existence in the serializable query", async () => {
    const { client } = await buildClient();
    const chain = client.note.query().has("draft").hasNot("title");

    expect(chain.toQuery().groups).toEqual([
      [
        { kind: "existence", component: "note/draft", present: true },
        { kind: "existence", component: "note/title", present: false },
      ],
    ]);
  });

  it("refuses a field the source model does not declare", async () => {
    const { client } = await buildClient();
    expect(() => client.note.query().has("drafting" as never)).toThrow(/not a component on "note"/);
  });
});
