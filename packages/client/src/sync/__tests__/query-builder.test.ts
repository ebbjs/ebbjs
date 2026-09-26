/**
 * Tests for the typed thenable QueryBuilder.
 *
 * The three-state projection (set / nulled / absent) is the heart
 * of the chain's typing surface — those cases are pinned here.
 */

import { describe, it, expect } from "vitest";
import { Type, type Static } from "@sinclair/typebox";

import type { Entity } from "@ebbjs/core";

import { defineEntity, e } from "../../schema/entity";
import { buildQueryBuilder, projectEntity, projectRows } from "../query-builder";

const todo = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
  body: e.string().nullable(),
});

type Todo = Static<typeof todo.shape>;

const mkEntity = (id: string, fields: Record<string, unknown>): Entity => ({
  id,
  type: "todo",
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

describe("projectEntity", () => {
  it("projects set fields to their value", () => {
    const entity = mkEntity("1", { title: "Ship", completed: false });
    const row = projectEntity(entity, todo.shape);
    expect(row).toEqual({ title: "Ship", completed: false, body: undefined });
  });

  it("projects nulled fields to null", () => {
    const entity = mkEntity("1", { title: "Ship", completed: false, body: null });
    const row = projectEntity(entity, todo.shape);
    expect(row.body).toBeNull();
  });

  it("projects absent fields to undefined", () => {
    const entity = mkEntity("1", { title: "Ship", completed: false });
    const row = projectEntity(entity, todo.shape);
    expect(row.body).toBeUndefined();
  });
});

describe("projectRows", () => {
  it("projects each row in the list", () => {
    const rows = [
      mkEntity("1", { title: "a", completed: false }),
      mkEntity("2", { title: "b", completed: true }),
    ];
    const projected = projectRows(rows, todo.shape);
    expect(projected).toHaveLength(2);
    expect(projected[0]?.title).toBe("a");
    expect(projected[1]?.title).toBe("b");
  });
});

describe("buildQueryBuilder — chain mutators", () => {
  it("eq filters by field equality", async () => {
    const rows = [
      mkEntity("1", { title: "a", completed: false }),
      mkEntity("2", { title: "b", completed: true }),
      mkEntity("3", { title: "c", completed: false }),
    ];
    const out = await buildQueryBuilder(rows, todo.shape).eq("completed", false);
    expect(out.map((r) => r.title)).toEqual(["a", "c"]);
  });

  it("orderBy sorts by field", async () => {
    const rows = [
      mkEntity("1", { title: "banana", completed: false }),
      mkEntity("2", { title: "apple", completed: false }),
      mkEntity("3", { title: "cherry", completed: false }),
    ];
    const out = await buildQueryBuilder(rows, todo.shape).orderBy("title", "asc");
    expect(out.map((r) => r.title)).toEqual(["apple", "banana", "cherry"]);
  });

  it("limit caps the result count", async () => {
    const rows = [
      mkEntity("1", { title: "a", completed: false }),
      mkEntity("2", { title: "b", completed: false }),
      mkEntity("3", { title: "c", completed: false }),
    ];
    const out = await buildQueryBuilder(rows, todo.shape).limit(2);
    expect(out.map((r) => r.title)).toEqual(["a", "b"]);
  });

  it("chains eq + orderBy + limit", async () => {
    const rows = [
      mkEntity("1", { title: "a", completed: false }),
      mkEntity("2", { title: "b", completed: true }),
      mkEntity("3", { title: "c", completed: true }),
      mkEntity("4", { title: "d", completed: true }),
    ];
    const out = await buildQueryBuilder(rows, todo.shape)
      .eq("completed", true)
      .orderBy("title", "desc")
      .limit(2);
    expect(out.map((r) => r.title)).toEqual(["d", "c"]);
  });

  it("returns a new builder on every chain call (no shared state)", async () => {
    const rows = [
      mkEntity("1", { title: "a", completed: false }),
      mkEntity("2", { title: "b", completed: true }),
    ];
    const base = buildQueryBuilder(rows, todo.shape);
    const a = base.eq("completed", true);
    const b = base.eq("completed", false);
    expect((await a).map((r) => r.title)).toEqual(["b"]);
    expect((await b).map((r) => r.title)).toEqual(["a"]);
    expect((await base).map((r) => r.title).sort()).toEqual(["a", "b"]);
  });
});

describe("buildQueryBuilder — thenable projection", () => {
  it("await qb resolves to readonly Static<typeof shape>[]", async () => {
    const rows = [mkEntity("1", { title: "a", completed: false, body: null })];
    const out: readonly Todo[] = await buildQueryBuilder(rows, todo.shape);
    expect(out[0]?.title).toBe("a");
    expect(out[0]?.completed).toBe(false);
    expect(out[0]?.body).toBeNull();
  });

  it("projection honors all three field states", async () => {
    const setEntity = mkEntity("1", { title: "set", completed: true, body: "note" });
    const nulledEntity = mkEntity("2", { title: "nulled", completed: false, body: null });
    const absentEntity = mkEntity("3", { title: "absent", completed: false });
    const out: readonly Todo[] = await buildQueryBuilder(
      [setEntity, nulledEntity, absentEntity],
      todo.shape,
    );
    expect(out[0]?.body).toBe("note");
    expect(out[1]?.body).toBeNull();
    expect(out[2]?.body).toBeUndefined();
  });

  it("thenable's .then invokes the projection callback", async () => {
    const rows = [mkEntity("1", { title: "a", completed: false })];
    const builder = buildQueryBuilder(rows, todo.shape);
    const out = await builder.then((rows) => rows.map((r) => r.title));
    expect(out).toEqual(["a"]);
  });
});

describe("buildQueryBuilder — .toRaw() escape hatch", () => {
  it("returns readonly Entity[] without projection", async () => {
    const rows = [mkEntity("1", { title: "a", completed: false })];
    const out = await buildQueryBuilder(rows, todo.shape).eq("completed", false).toRaw();
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("1");
    expect(out[0]?.data?.fields?.title?.value).toBe("a");
  });

  it("await qb.toRaw() resolves through the chain's filters", async () => {
    const rows = [
      mkEntity("1", { title: "a", completed: false }),
      mkEntity("2", { title: "b", completed: true }),
    ];
    const out = await buildQueryBuilder(rows, todo.shape).eq("completed", false).toRaw();
    expect(out.map((e) => e.id)).toEqual(["1"]);
  });

  it("returns the untyped wire shape (no row projection)", async () => {
    const rows = [mkEntity("1", { title: "a", completed: false, body: null })];
    const out = await buildQueryBuilder(rows, todo.shape).toRaw();
    // Wire envelope is intact: `data.fields.title.value` is "a", not the projected string.
    expect(out[0]?.data?.fields?.title).toEqual({ value: "a", update_id: "u" });
    expect(out[0]?.data?.fields?.body).toEqual({ value: null, update_id: "u" });
  });
});

describe("buildQueryBuilder — value narrowing against the field map", () => {
  it("eq's value narrows to the field's TypeBox static type", () => {
    const rows: Entity[] = [];
    const builder = buildQueryBuilder(rows, todo.shape);
    // Title is e.string() → value is string.
    builder.eq("title", "hello");
    builder.eq("title", "world");
    // Body is e.string().nullable() → value is string | null.
    builder.eq("body", null);
    builder.eq("body", "note");
    // Completed is e.boolean() → value is boolean.
    builder.eq("completed", false);
    builder.eq("completed", true);
    expect(true).toBe(true);
  });

  it("rejects a mismatched value type at compile time", () => {
    const rows: Entity[] = [];
    const builder = buildQueryBuilder(rows, todo.shape);
    // @ts-expect-error — `completed` is e.boolean(); "not a boolean" is not assignable.
    builder.eq("completed", "not a boolean");
    // @ts-expect-error — `title` is e.string(); 42 is not assignable.
    builder.eq("title", 42);
    expect(true).toBe(true);
  });

  it("rejects an unknown field name at compile time", () => {
    const rows: Entity[] = [];
    const builder = buildQueryBuilder(rows, todo.shape);
    // @ts-expect-error — `bogus` is not in the field map.
    builder.eq("bogus", true);
    expect(true).toBe(true);
  });
});

describe("buildQueryBuilder — Type.Optional field", () => {
  const defWithOptional = defineEntity("todo", {
    title: e.string(),
    note: Type.Optional(e.string()),
  });

  it("projects optional fields the same as nullable+absent (undefined)", async () => {
    const present = mkEntity("1", { title: "a", note: "x" });
    const absent = mkEntity("2", { title: "b" });
    const out = await buildQueryBuilder([present, absent], defWithOptional.shape);
    expect(out[0]?.note).toBe("x");
    expect(out[1]?.note).toBeUndefined();
  });
});

describe("buildLazyQueryBuilder", () => {
  it("loads candidates at materialization time, not at build time", async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return [mkEntity("1", { title: "a", completed: false })];
    };
    const { buildLazyQueryBuilder } = await import("../query-builder");
    const builder = buildLazyQueryBuilder(loader, todo.shape).eq("completed", false);
    expect(calls).toBe(0);
    const out = await builder;
    expect(calls).toBe(1);
    expect(out.map((r) => r.title)).toEqual(["a"]);
  });

  it("re-loads on every await (reflects the latest snapshot)", async () => {
    let n = 0;
    const loader = async () => [mkEntity("1", { title: String(n++), completed: false })];
    const { buildLazyQueryBuilder } = await import("../query-builder");
    const builder = buildLazyQueryBuilder(loader, todo.shape);
    expect((await builder)[0]?.title).toBe("0");
    expect((await builder)[0]?.title).toBe("1");
  });

  it("toRaw() also re-loads candidates", async () => {
    const loader = async () => [mkEntity("1", { title: "a", completed: false })];
    const { buildLazyQueryBuilder } = await import("../query-builder");
    const out = await buildLazyQueryBuilder(loader, todo.shape).toRaw();
    expect(out).toHaveLength(1);
    expect(out[0]?.data?.fields?.title?.value).toBe("a");
  });
});
