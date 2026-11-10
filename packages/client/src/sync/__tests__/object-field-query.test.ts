/**
 * Query semantics for object- and array-valued leaves (#796).
 *
 * A compound value is an ordinary LWW leaf on the wire, so equality is
 * structural: `where` compares the value a row stores with the value the
 * caller wrote, ignoring key order. Ordering is scalar-only — an object or
 * array has no total order, so the executor refuses it rather than tying
 * every row on `"[object Object]"`.
 *
 * The field schemas are raw TypeBox so these assertions do not depend on
 * `e.object` landing first; `defineModel` accepts any `TSchema`.
 */

import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { makeHlc, type Entity, type FieldValue } from "@ebbjs/core";
import { defineModel, e, EntityValidationError } from "@ebbjs/schema";

import { buildQueryBuilder } from "../query-builder";
import { createRowsExecutor, executePlan } from "../query-execute";
import { planQuery } from "../query-plan";
import { emptyQuery } from "../query";

const wall = defineModel("wall", {
  anchor: Type.Object({ x: Type.Number(), y: Type.Number() }, { additionalProperties: false }),
  tags: Type.Array(Type.String()),
  bounds: e.map(e.number()),
  title: e.string(),
  kind: e.enum(["exterior", "interior"]).default("interior"),
  rating: e.number().default(0),
});

const field = (value: unknown, updateId: string): FieldValue => ({
  value,
  update_id: updateId,
  hlc: makeHlc(1),
});

/** A materialized row whose field entries are plain leaf values. */
const entity = (id: string, fields: Record<string, unknown>): Entity => ({
  id,
  type: "wall",
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, field(value, `u_${id}`)]),
    ),
  },
  created_hlc: makeHlc(1),
  updated_hlc: makeHlc(1),
  deleted_hlc: null,
  last_gsn: 0,
});

const ids = (rows: readonly { readonly id: string }[]): readonly string[] =>
  rows.map((row) => row.id);

const query = (rows: readonly Entity[]) => buildQueryBuilder(rows, wall.shape);

describe("where on an object leaf", () => {
  const rows: readonly Entity[] = [
    entity("wall_1", { anchor: { x: 1, y: 2 } }),
    entity("wall_2", { anchor: { x: 1, y: 3 } }),
    entity("wall_3", { anchor: { x: 2, y: 2 } }),
    entity("wall_4", {}),
  ];

  it("matches a stored object equal to the predicate", async () => {
    expect(ids(await query(rows).where("anchor", { x: 1, y: 2 }))).toEqual(["wall_1"]);
  });

  it("does not match a different object", async () => {
    expect(await query(rows).where("anchor", { x: 9, y: 9 })).toEqual([]);
  });

  it("compares key order irrelevantly", async () => {
    expect(ids(await query(rows).where("anchor", { y: 2, x: 1 }))).toEqual(["wall_1"]);
  });

  it("does not match a stored object with an extra key", async () => {
    const wider = [entity("wall_wide", { anchor: { x: 1, y: 2, z: 3 } })];
    expect(await query(wider).where("anchor", { x: 1, y: 2 })).toEqual([]);
  });

  it("does not match a row with no live value", async () => {
    expect(ids(await query(rows).where("anchor", { x: 1, y: 2 }))).not.toContain("wall_4");
  });

  it("keeps the null predicate as no-live-value", async () => {
    expect(ids(await query(rows).where("anchor", null))).toEqual(["wall_4"]);
  });

  it("keeps the map-envelope rule: a map never matches an object predicate", async () => {
    const mapped: readonly Entity[] = [
      { ...entity("wall_map", {}), data: { fields: { bounds: { map: { n: field(1, "u") } } } } },
    ];
    expect(await query(mapped).where("bounds", { n: 1 })).toEqual([]);
  });
});

describe("where on an array leaf", () => {
  it("compares arrays element-wise", async () => {
    const rows: readonly Entity[] = [
      entity("wall_ab", { tags: ["a", "b"] }),
      entity("wall_ac", { tags: ["a", "c"] }),
    ];
    expect(ids(await query(rows).where("tags", ["a", "b"]))).toEqual(["wall_ab"]);
  });

  it("does not match a different order or length", async () => {
    const rows: readonly Entity[] = [entity("wall_ab", { tags: ["a", "b"] })];
    expect(await query(rows).where("tags", ["b", "a"])).toEqual([]);
    expect(await query(rows).where("tags", ["a"])).toEqual([]);
    expect(await query(rows).where("tags", ["a", "b", "c"])).toEqual([]);
  });
});

describe("ordering a non-scalar field", () => {
  const rows: readonly Entity[] = [
    entity("wall_b", { anchor: { x: 1, y: 2 }, tags: ["a"], title: "Same" }),
    entity("wall_a", { anchor: { x: 1, y: 2 }, tags: ["a"], title: "Same" }),
  ];

  const order = (field: string) =>
    planQuery({ ...emptyQuery("wall"), groups: [], order: { field, direction: "asc" } });

  it("throws for an object field instead of tying on [object Object]", () => {
    const run = () => executePlan(order("anchor"), createRowsExecutor(rows));
    expect(run).toThrow(/anchor/);
    expect(run).toThrow(/not orderable/);
    expect(run).toThrow(/scalar/);
  });

  it("throws for an array field", () => {
    expect(() => executePlan(order("tags"), createRowsExecutor(rows))).toThrow(/tags/);
  });

  it("throws from the builder's orderBy with an EntityValidationError naming the field", () => {
    // The key type already rejects an object field; this pins the runtime
    // refusal for a chain that reached orderBy through an untyped path.
    const orderBy = query(rows).orderBy as unknown as (
      field: string,
      direction: "asc" | "desc",
    ) => unknown;
    expect(() => orderBy("anchor", "asc")).toThrow(EntityValidationError);
    expect(() => orderBy("anchor", "asc")).toThrow(/anchor/);
    expect(() => orderBy("tags", "asc")).toThrow(/not orderable/);
  });

  it("orders scalar, enum, and defaulted fields as before", async () => {
    const unordered: readonly Entity[] = [
      entity("wall_c", { title: "b", kind: "exterior", rating: 2 }),
      entity("wall_b", { title: "a" }),
      entity("wall_a", { title: "a", kind: "interior", rating: 0 }),
    ];
    expect(ids(await query(unordered).orderBy("title", "asc"))).toEqual([
      "wall_a",
      "wall_b",
      "wall_c",
    ]);
    expect(ids(await query(unordered).orderBy("kind", "asc"))).toEqual([
      "wall_c",
      "wall_a",
      "wall_b",
    ]);
    expect(ids(await query(unordered).orderBy("rating", "asc"))).toEqual([
      "wall_a",
      "wall_b",
      "wall_c",
    ]);
  });
});
