/**
 * Tests for the relationship accessors in `relationship.ts`.
 *
 * `forwardOneNullable` is the new primitive (#181) — it distinguishes
 * "FK is null" from "FK is absent or target missing", unlike
 * `forwardOne` which collapses both to `undefined`.
 *
 * The other primitives (`forwardOne`, `forwardMany`, `reverse`) have
 * end-to-end coverage via `client.<entity>.get(id)` row-accessor
 * tests; this file pins the per-primitive contract.
 */

import { describe, it, expect } from "vitest";
import type { Entity } from "@ebbjs/core";

import { forwardOne, forwardOneNullable, forwardMany, reverse } from "../relationship";

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

const readLocalEntity =
  (store: Map<string, Entity>) =>
  async (id: string): Promise<Entity | null> =>
    store.get(id) ?? null;

const queryEntitiesByType =
  (store: Map<string, Entity>) =>
  async (type: string): Promise<readonly Entity[]> =>
    Array.from(store.values()).filter((e) => e.type === type);

describe("forwardOne", () => {
  it("resolves the target entity when the FK is a set string", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "todo", { parentList: "l1" }));
    store.set("l1", mkEntity("l1", "list", { name: "Work" }));
    const got = await forwardOne(readLocalEntity(store), "t1", "todo", "parentList");
    expect(got?.id).toBe("l1");
    expect(got?.type).toBe("list");
  });

  it("returns undefined when the source row is missing", async () => {
    const store = new Map<string, Entity>();
    const got = await forwardOne(readLocalEntity(store), "missing", "todo", "parentList");
    expect(got).toBeUndefined();
  });

  it("returns undefined when the FK field is absent", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "todo", { title: "x" }));
    const got = await forwardOne(readLocalEntity(store), "t1", "todo", "parentList");
    expect(got).toBeUndefined();
  });

  it("returns undefined when the FK value is null (collapsed with absent)", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "todo", { parentList: null }));
    const got = await forwardOne(readLocalEntity(store), "t1", "todo", "parentList");
    expect(got).toBeUndefined();
  });

  it("returns undefined when the FK target is missing (dangling)", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "todo", { parentList: "ghost" }));
    const got = await forwardOne(readLocalEntity(store), "t1", "todo", "parentList");
    expect(got).toBeUndefined();
  });
});

describe("forwardOneNullable", () => {
  it("returns null when the FK is explicitly null", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "todo", { parentList: null }));
    const got = await forwardOneNullable(readLocalEntity(store), "t1", "todo", "parentList");
    expect(got).toBeNull();
  });

  it("returns undefined when the FK field is absent", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "todo", { title: "x" }));
    const got = await forwardOneNullable(readLocalEntity(store), "t1", "todo", "parentList");
    expect(got).toBeUndefined();
  });

  it("returns the target entity when the FK resolves", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "todo", { parentList: "l1" }));
    store.set("l1", mkEntity("l1", "list", { name: "Work" }));
    const got = await forwardOneNullable(readLocalEntity(store), "t1", "todo", "parentList");
    expect(got?.id).toBe("l1");
  });

  it("returns undefined when the FK target is missing (dangling FK is not null)", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "todo", { parentList: "ghost" }));
    const got = await forwardOneNullable(readLocalEntity(store), "t1", "todo", "parentList");
    expect(got).toBeUndefined();
  });

  it("returns undefined when the source row itself is missing", async () => {
    const store = new Map<string, Entity>();
    const got = await forwardOneNullable(readLocalEntity(store), "missing", "todo", "parentList");
    expect(got).toBeUndefined();
  });
});

describe("forwardMany", () => {
  it("projects a list of targets that match the source's FK array", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "tag", { tag: ["tag-a", "tag-b"] }));
    store.set("tag-a", mkEntity("tag-a", "label", { name: "a" }));
    store.set("tag-b", mkEntity("tag-b", "label", { name: "b" }));
    store.set("tag-c", mkEntity("tag-c", "label", { name: "c" }));
    const qb = forwardMany(
      readLocalEntity(store),
      queryEntitiesByType(store),
      "t1",
      "tag",
      "label",
      // Target shape — the projection source for `await qb`.
      { type: "object", properties: { name: { type: "string" } } } as never,
      "tag",
    );
    const rows = await qb;
    expect(rows.map((r) => (r as { name: string }).name).sort()).toEqual(["a", "b"]);
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
      "tag",
    );
    expect(await qb).toEqual([]);
  });
});

describe("reverse", () => {
  it("projects sources that point at the target through the materialized Relationship cache", async () => {
    const store = new Map<string, Entity>();
    store.set("l1", mkEntity("l1", "list", { name: "Work" }));
    store.set("t1", mkEntity("t1", "todo", { parentList: "l1" }));
    store.set("t2", mkEntity("t2", "todo", { parentList: "l1" }));
    store.set("t3", mkEntity("t3", "todo", { parentList: "l2" }));
    store.set(
      "rel-1",
      mkEntity("rel-1", "relationship", {
        source_id: "t1",
        target_id: "l1",
        type: "todo",
        field: "parentList",
      }),
    );
    store.set(
      "rel-2",
      mkEntity("rel-2", "relationship", {
        source_id: "t2",
        target_id: "l1",
        type: "todo",
        field: "parentList",
      }),
    );
    store.set(
      "rel-3",
      mkEntity("rel-3", "relationship", {
        source_id: "t3",
        target_id: "l2",
        type: "todo",
        field: "parentList",
      }),
    );
    const qb = reverse(
      readLocalEntity(store),
      queryEntitiesByType(store),
      "l1",
      "todo",
      // Source shape drives the projection: rows carry `parentList`,
      // the FK field. The test asserts the ids via the underlying
      // Entity's lookup by walking the source list, not the
      // projection's keys.
      { type: "object", properties: { parentList: { type: "string" } } } as never,
      "parentList",
      "todo",
    );
    const projected = await qb;
    expect(projected).toHaveLength(2);
    // Match by FK field (the projection has `parentList`):
    const fks = projected.map((r) => (r as { parentList: string }).parentList).sort();
    expect(fks).toEqual(["l1", "l1"]);
  });
});
