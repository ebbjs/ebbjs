/**
 * Tests for `sync/query-builder.ts` — the typed `QueryBuilder<TFields>`
 * chain DSL.
 *
 * Covers:
 * - equality, ordering, limit evaluation against an `Entity[]`
 *   candidates set;
 * - terminal shape (`toArray()`, `find()` alias);
 * - chain mutator immutability (each method returns a new builder);
 * - typed `eq` / `orderBy` against a phantom `TFields` parameter,
 *   asserted via compile-time type usage on `q.eq(...)` and
 *   `q.orderBy(...)`.
 */

import { describe, it, expect } from "vitest";
import type { Entity } from "@ebbjs/core";

import { apply, buildQueryBuilder, type QueryBuilder } from "../query-builder";
import type { FieldMarker } from "../../schema/entity";

/**
 * Build an `Entity` row for tests. The chain DSL only reads
 * `data.fields[field].value`, so the rest is just enough to satisfy
 * `Entity`'s shape.
 */
const buildEntity = (id: string, fields: Record<string, unknown>): Entity => ({
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

/** Loose TFields for tests that don't assert type narrowing. */
type LooseFields = Record<string, FieldMarker>;
type TodoFields = {
  completed: { type: "lww" };
  title: { type: "lww" };
  x: { type: "lww" };
  y: { type: "lww" };
};

describe("buildQueryBuilder / apply", () => {
  it("apply returns the input unchanged when no constraints are set", () => {
    const rows = [buildEntity("1", { x: 1 }), buildEntity("2", { x: 2 })];
    const out = apply({ candidates: rows, filters: [], order: null, limitN: null });
    expect(out.map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("apply filters by an EqFilter", () => {
    const rows = [
      buildEntity("1", { completed: false }),
      buildEntity("2", { completed: true }),
      buildEntity("3", { completed: false }),
    ];
    const out = apply({
      candidates: rows,
      filters: [{ field: "completed", value: false }],
      order: null,
      limitN: null,
    });
    expect(out.map((r) => r.id)).toEqual(["1", "3"]);
  });
});

describe("QueryBuilder (toArray / find terminals)", () => {
  it("toArray is the public terminal and find is its alias", async () => {
    const rows = [buildEntity("1", { x: 1 }), buildEntity("2", { x: 2 })];
    const qb = buildQueryBuilder<LooseFields>(rows);
    const a = await qb.toArray();
    const b = await qb.find();
    expect(a.map((r) => (r as Entity).id)).toEqual(["1", "2"]);
    expect(b.map((r) => (r as Entity).id)).toEqual(["1", "2"]);
  });

  it("eq filters by field equality", async () => {
    const rows = [
      buildEntity("1", { completed: false }),
      buildEntity("2", { completed: true }),
      buildEntity("3", { completed: false }),
    ];
    const out = await buildQueryBuilder<LooseFields>(rows).eq("completed", false).toArray();
    expect(out.map((r) => (r as Entity).id)).toEqual(["1", "3"]);
  });

  it("orderBy sorts by field", async () => {
    const rows = [
      buildEntity("1", { title: "banana" }),
      buildEntity("2", { title: "apple" }),
      buildEntity("3", { title: "cherry" }),
    ];
    const out = await buildQueryBuilder<LooseFields>(rows).orderBy("title", "asc").toArray();
    expect(out.map((r) => (r as Entity).id)).toEqual(["2", "1", "3"]);
  });

  it("limit caps the result count", async () => {
    const rows = [
      buildEntity("1", { x: 1 }),
      buildEntity("2", { x: 2 }),
      buildEntity("3", { x: 3 }),
    ];
    const out = await buildQueryBuilder<LooseFields>(rows).limit(2).toArray();
    expect(out.map((r) => (r as Entity).id)).toEqual(["1", "2"]);
  });

  it("chains eq + orderBy + limit", async () => {
    const rows = [
      buildEntity("1", { x: 1, y: false }),
      buildEntity("2", { x: 2, y: true }),
      buildEntity("3", { x: 3, y: true }),
      buildEntity("4", { x: 4, y: true }),
    ];
    const out = await buildQueryBuilder<LooseFields>(rows)
      .eq("y", true)
      .orderBy("x", "desc")
      .limit(2)
      .toArray();
    expect(out.map((r) => (r as Entity).id)).toEqual(["4", "3"]);
  });

  it("chains return new builders (no shared state)", async () => {
    const rows = [buildEntity("1", { y: false }), buildEntity("2", { y: true })];
    const base = buildQueryBuilder<LooseFields>(rows);
    const a = base.eq("y", true);
    const b = base.eq("y", false);
    // `base` is untouched; both `a` and `b` carry their own filter.
    expect((await a.toArray()).map((r) => (r as Entity).id)).toEqual(["2"]);
    expect((await b.toArray()).map((r) => (r as Entity).id)).toEqual(["1"]);
    // And calling `.toArray()` on the base again returns everything.
    expect((await base.toArray()).map((r) => (r as Entity).id)).toEqual(["1", "2"]);
  });

  it("limit and orderBy stack correctly across chain calls", async () => {
    const rows = [
      buildEntity("1", { x: 3 }),
      buildEntity("2", { x: 1 }),
      buildEntity("3", { x: 2 }),
    ];
    const qb = buildQueryBuilder<LooseFields>(rows);
    const sorted = await qb.orderBy("x", "asc").limit(2).toArray();
    expect(sorted.map((r) => (r as Entity).id)).toEqual(["2", "3"]);
  });
});

/**
 * Compile-time checks: typing `eq` / `orderBy` against a typed
 * `TFields` so callers pass the right value shape.
 *
 * The static type punishes unknown field names; we don't run these
 * at test time (they're 100% type-level assertions), but they live
 * next to the runtime tests so reviewers can spot-check the
 * ergonomics.
 */
describe("QueryBuilder (typed eq / orderBy against TFields)", () => {
  it("eq rejects unknown field names at compile time", () => {
    const qb = buildQueryBuilder<TodoFields>([]);
    // @ts-expect-error `bogus` is not a key of TodoFields
    void qb.eq("bogus", false);
    // @ts-expect-error `bogus` is not a key of TodoFields
    void qb.orderBy("bogus", "asc");
    // Valid key passes.
    void qb.eq("completed", false);
    void qb.eq("completed", null);
    void qb.eq("completed", "yes");
    void qb.orderBy("title", "asc");
    expect(typeof qb).toBe("object");
  });

  it("eq rejects value-shape mismatches at compile time", () => {
    const qb = buildQueryBuilder<TodoFields>([]);
    // The `title` field is `lww`-typed → the value union is
    // `string | number | boolean | null`. Numbers and objects are
    // not allowed at the static level.
    // @ts-expect-error objects aren't assignable to FieldValueFor<lww>
    void qb.eq("title", { not: "a string" });
    // Valid: a string.
    void qb.eq("title", "Ship");
    expect(typeof qb).toBe("object");
  });

  it("`TFields` is phantom: it does not bleed into the terminal row type", async () => {
    const rows = [buildEntity("1", { title: "X" })];
    const qb = buildQueryBuilder<TodoFields>(rows);
    const out: readonly unknown[] = await qb.toArray();
    // The terminal rows are `unknown[]` because the phantom
    // parameter doesn't constrain the row type; the cast at the
    // caller is intentional and surfaces in the namespace mount.
    const first = out[0] as Entity;
    expect(first.id).toBe("1");
  });

  it("`QueryBuilder<TFields>` is structurally assignable to itself", () => {
    const qb: QueryBuilder<TodoFields> = buildQueryBuilder<TodoFields>([]);
    expect(typeof qb).toBe("object");
    expect(typeof qb.eq).toBe("function");
    expect(typeof qb.orderBy).toBe("function");
    expect(typeof qb.limit).toBe("function");
    expect(typeof qb.toArray).toBe("function");
    expect(typeof qb.find).toBe("function");
  });
});
