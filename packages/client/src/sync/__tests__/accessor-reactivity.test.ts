/**
 * Prototype (#489): a `relationship` write should wake the source
 * entity's accessor subscribers and re-fire the source type, so a
 * forward-one accessor and a relationship-filtered query stay live
 * without the app re-reading manually.
 */

import { describe, expect, it } from "vitest";
import type { Entity } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import { createClient } from "../client";
import { defineEntity, e } from "../../schema/entity";
import { defineRelationship } from "../../schema/relationship";
import { defineSchema } from "../../schema/schema";

const todo = defineEntity("todo", { title: e.string() });
const user = defineEntity("user", { name: e.string() });

const schema = defineSchema({
  entities: { todo, user },
  relationships: { todo_owner: defineRelationship({ source: todo, target: user, as: "owner" }) },
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

const mkRel = (id: string, sourceId: string, targetId: string): Entity => ({
  id,
  type: "relationship",
  data: {
    fields: {
      source_id: { value: sourceId, update_id: "u" },
      target_id: { value: targetId, update_id: "u" },
      type: { value: "todo", update_id: "u" },
      field: { value: "owner", update_id: "u" },
    },
  },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 0,
});

const mkMembership = (id: string, entityId: string, groupId: string): Entity => ({
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
});

const fresh = async (): Promise<{
  storage: ReturnType<typeof createMemoryAdapter>;
  client: ReturnType<typeof createClient<typeof schema>>;
}> => {
  const storage = createMemoryAdapter();
  const client = createClient({ serverUrl: "http://x", actorId: "a", storage, schema });
  await storage.entities.set(mkEntity("t1", "todo", { title: "T" }));
  await storage.entities.set(mkEntity("u1", "user", { name: "Ada" }));
  return { storage, client };
};

describe("prototype: relationship accessor reactivity (#489)", () => {
  it("wakes subscribeAccessors on link and unlink, and re-derives the accessor", async () => {
    const { storage, client } = await fresh();

    const before = await client.todo.get("t1");
    if (before === null) throw new Error("expected row");
    expect(await before.owner).toBeNull();

    let accessorFires = 0;
    let edgeTypeFires = 0;
    const unsubAccessor = before.subscribeAccessors(() => {
      accessorFires += 1;
    });
    const unsubType = storage.changeEmitter!.onTypeChange("relationship", () => {
      edgeTypeFires += 1;
    });

    await storage.entities.set(mkRel("rel_1", "t1", "u1"));
    expect(accessorFires).toBe(1);
    expect(edgeTypeFires).toBe(1);

    const linked = await client.todo.get("t1");
    const owner = await linked!.owner;
    expect(owner?.id).toBe("u1");

    const rel = await storage.entities.get("rel_1");
    if (rel === null) throw new Error("expected relationship row");
    await storage.entities.set({ ...rel, deleted_hlc: "2" });
    expect(accessorFires).toBe(2);

    const unlinked = await client.todo.get("t1");
    expect(await unlinked!.owner).toBeNull();

    unsubAccessor();
    unsubType();
  });

  it("re-materializes a relationship-filtered query on link and unlink", async () => {
    const { storage, client } = await fresh();

    const query = client.todo.query().where("owner", "u1");
    expect((await query).map((row) => row.id)).toEqual([]);

    let fires = 0;
    const unsub = query.subscribe(() => {
      fires += 1;
    });

    await storage.entities.set(mkRel("rel_1", "t1", "u1"));
    expect(fires).toBe(1);
    expect((await query).map((row) => row.id)).toEqual(["t1"]);

    const rel = await storage.entities.get("rel_1");
    if (rel === null) throw new Error("expected relationship row");
    await storage.entities.set({ ...rel, deleted_hlc: "2" });
    expect(fires).toBe(2);
    expect((await query).map((row) => row.id)).toEqual([]);

    unsub();
  });

  it("wakes subscribeAccessors on a membership write (id-keyed signal generalizes)", async () => {
    const { storage, client } = await fresh();
    await storage.entities.set(mkEntity("grp_1", "group", { name: "G" }));

    const row = await client.todo.get("t1");
    if (row === null) throw new Error("expected row");

    let fires = 0;
    const unsub = row.subscribeAccessors(() => {
      fires += 1;
    });

    await storage.entities.set(mkMembership("eg_1", "t1", "grp_1"));
    expect(fires).toBe(1);

    const moved = await client.todo.get("t1");
    expect((await moved!.groups).map((group) => group.id)).toEqual(["grp_1"]);

    unsub();
  });

  it("re-materializes a membership-filtered query on a membership write", async () => {
    const { storage, client } = await fresh();
    await storage.entities.set(mkEntity("grp_1", "group", { name: "G" }));

    const query = client.todo.query().where("groups", "grp_1");
    expect((await query).map((row) => row.id)).toEqual([]);

    let fires = 0;
    const unsub = query.subscribe(() => {
      fires += 1;
    });

    await storage.entities.set(mkMembership("eg_1", "t1", "grp_1"));
    expect(fires).toBe(1);
    expect((await query).map((row) => row.id)).toEqual(["t1"]);

    unsub();
  });
});
