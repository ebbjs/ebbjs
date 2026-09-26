/**
 * Tests for the relationship accessors in `relationship.ts`.
 *
 * Forward accessors (`forwardOne`, `forwardMany`) read the canonical
 * FK set from materialized `Relationship` system entities (scanned by
 * `source_id + field + type`), not from the source's data fields.
 * `reverse` walks Relationship entities for `target_id === targetId`.
 *
 * The `Entity` shape for `Relationship` records carries
 * `{source_id, target_id, type, field}` as field values.
 */

import { describe, it, expect } from "vitest";
import type { Entity } from "@ebbjs/core";

import { forwardMany, forwardOne, reverse } from "../relationship";

const mkEntity = (
  id: string,
  type: string,
  fields: Record<string, unknown>,
  deletedHlc: string | null = null,
): Entity => ({
  id,
  type,
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, { value: v, update_id: "u" }]),
    ),
  },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: deletedHlc,
  last_gsn: 0,
});

const mkRel = (
  id: string,
  sourceId: string,
  targetId: string,
  field: string,
  type: string,
): Entity =>
  mkEntity(id, "relationship", {
    source_id: sourceId,
    target_id: targetId,
    field,
    type,
  });

const readLocalEntity =
  (store: Map<string, Entity>) =>
  async (id: string): Promise<Entity | null> =>
    store.get(id) ?? null;

const queryEntitiesByType =
  (store: Map<string, Entity>) =>
  async (type: string): Promise<readonly Entity[]> =>
    Array.from(store.values()).filter((e) => e.type === type);

describe("forwardOne", () => {
  it("resolves the target entity when a Relationship edge exists", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "todo", {}));
    store.set("l1", mkEntity("l1", "list", { name: "Work" }));
    store.set("rel-1", mkRel("rel-1", "t1", "l1", "parentList", "todo"));
    const got = await forwardOne(
      readLocalEntity(store),
      queryEntitiesByType(store),
      "t1",
      "todo",
      "parentList",
      "todo",
    );
    expect(got?.id).toBe("l1");
    expect(got?.type).toBe("list");
  });

  it("returns undefined when the source row is missing", async () => {
    const store = new Map<string, Entity>();
    const got = await forwardOne(
      readLocalEntity(store),
      queryEntitiesByType(store),
      "missing",
      "todo",
      "parentList",
      "todo",
    );
    expect(got).toBeUndefined();
  });

  it("returns undefined when the source row exists but has the wrong type", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "user", {}));
    store.set("l1", mkEntity("l1", "list", { name: "Work" }));
    store.set("rel-1", mkRel("rel-1", "t1", "l1", "parentList", "todo"));
    const got = await forwardOne(
      readLocalEntity(store),
      queryEntitiesByType(store),
      "t1",
      "todo",
      "parentList",
      "todo",
    );
    expect(got).toBeUndefined();
  });

  it("returns null when no Relationship edge exists for (source, field, type)", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "todo", {}));
    store.set("l1", mkEntity("l1", "list", { name: "Work" }));
    // No Relationship record for t1.parentList.
    const got = await forwardOne(
      readLocalEntity(store),
      queryEntitiesByType(store),
      "t1",
      "todo",
      "parentList",
      "todo",
    );
    expect(got).toBeNull();
  });

  it("returns undefined when the edge exists but the target is missing (dangling)", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "todo", {}));
    store.set("rel-1", mkRel("rel-1", "t1", "ghost", "parentList", "todo"));
    const got = await forwardOne(
      readLocalEntity(store),
      queryEntitiesByType(store),
      "t1",
      "todo",
      "parentList",
      "todo",
    );
    expect(got).toBeUndefined();
  });
});

describe("forwardMany", () => {
  it("projects the targets whose Relationship edges point at this source", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "tag", {}));
    store.set("label-a", mkEntity("label-a", "label", { name: "a" }));
    store.set("label-b", mkEntity("label-b", "label", { name: "b" }));
    store.set("label-c", mkEntity("label-c", "label", { name: "c" }));
    store.set("rel-a", mkRel("rel-a", "t1", "label-a", "tags", "tag"));
    store.set("rel-b", mkRel("rel-b", "t1", "label-b", "tags", "tag"));
    store.set("rel-c", mkRel("rel-c", "t1", "label-c", "tags", "tag"));
    const qb = forwardMany(
      readLocalEntity(store),
      queryEntitiesByType(store),
      "t1",
      "tag",
      "label",
      // Target shape — drives the projection on `await qb`.
      { type: "object", properties: { name: { type: "string" } } } as never,
      "tags",
      "tag",
    );
    const rows = await qb;
    expect(rows.map((r) => (r as { name: string }).name).sort()).toEqual(["a", "b", "c"]);
  });

  it("returns an empty list when the source is missing", async () => {
    const store = new Map<string, Entity>();
    const qb = forwardMany(
      readLocalEntity(store),
      queryEntitiesByType(store),
      "missing",
      "tag",
      "label",
      { type: "object", properties: { name: { type: "string" } } } as never,
      "tags",
      "tag",
    );
    expect(await qb).toEqual([]);
  });

  it("returns an empty list when no Relationship edges exist", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "tag", {}));
    store.set("label-a", mkEntity("label-a", "label", { name: "a" }));
    const qb = forwardMany(
      readLocalEntity(store),
      queryEntitiesByType(store),
      "t1",
      "tag",
      "label",
      { type: "object", properties: { name: { type: "string" } } } as never,
      "tags",
      "tag",
    );
    expect(await qb).toEqual([]);
  });
});

describe("reverse", () => {
  it("projects sources that point at the target through the materialized Relationship cache", async () => {
    const store = new Map<string, Entity>();
    store.set("l1", mkEntity("l1", "list", { name: "Work" }));
    store.set("t1", mkEntity("t1", "todo", { title: "Ship" }));
    store.set("t2", mkEntity("t2", "todo", { title: "Other" }));
    store.set("t3", mkEntity("t3", "todo", { title: "Off-list" }));
    store.set("rel-1", mkRel("rel-1", "t1", "l1", "parentList", "todo"));
    store.set("rel-2", mkRel("rel-2", "t2", "l1", "parentList", "todo"));
    store.set("rel-3", mkRel("rel-3", "t3", "l2", "parentList", "todo"));
    const qb = reverse(
      readLocalEntity(store),
      queryEntitiesByType(store),
      "l1",
      "todo",
      // Source shape drives the projection on `await qb`.
      { type: "object", properties: { title: { type: "string" } } } as never,
      "parentList",
      "todo",
    );
    const rows = await qb;
    expect(rows.map((r) => (r as { title: string }).title)).toEqual(["Ship", "Other"]);
  });
});
