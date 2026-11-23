/**
 * Tests for the typed thenable QueryBuilder.
 *
 * The projection states (stored / absent / tombstoned) are the heart of
 * the chain's typing surface — those cases are pinned here. A tombstone
 * reads as absence, or as the field's declared default.
 */

import { describe, it, expect } from "vitest";
import { Type, type Static } from "@sinclair/typebox";

import type { Entity, FieldValue } from "@ebbjs/core";

import { defineComponent, defineModel, e } from "@ebbjs/schema";
import { EntityValidationError } from "@ebbjs/schema";
import {
  buildQueryBuilder,
  buildLazyQueryBuilder,
  projectEntity,
  projectFieldValue,
  projectQueryRow,
  projectRow,
} from "../query-builder";
import { entityRow } from "../test-utils";

const todo = defineModel("todo", {
  title: e.string(),
  completed: e.boolean(),
  body: e.string(),
});

type Todo = Static<typeof todo.shape>;

describe("projectEntity", () => {
  it("projects set fields to their value", () => {
    const entity = entityRow("1", "todo", { title: "Ship", completed: false });
    const row = projectEntity(entity, todo.shape);
    expect(row).toEqual({ title: "Ship", completed: false, body: undefined });
  });

  it("projects a tombstoned leaf to undefined when it has no default", () => {
    const entity = entityRow("1", "todo", { title: "Ship", completed: false, body: null });
    const row = projectEntity(entity, todo.shape);
    expect(row.body).toBeUndefined();
  });
});

describe("projectEntity — map fields", () => {
  const doc = Type.Object({ content: Type.Record(Type.String(), Type.Unknown()) });

  const mkDoc = (content: FieldValue): Entity => ({
    id: "d1",
    model: "doc",
    data: { fields: { content } },
    exists: true,
    created_hlc: "1",
    updated_hlc: "1",
    deleted_hlc: null,
    last_gsn: 0,
  });

  it("projects a map field entry by entry, recursively", () => {
    const entity = mkDoc({
      map: {
        a: { value: "x", update_id: "u" },
        b: { map: { c: { value: 1, update_id: "u" } } },
      },
    });

    expect(projectEntity(entity, doc)).toEqual({ content: { a: "x", b: { c: 1 } } });
  });

  it("omits a tombstoned key but keeps its siblings", () => {
    const entity = mkDoc({
      map: {
        gone: { value: null, update_id: "u" },
        kept: { value: "keep", update_id: "u" },
      },
    });

    expect(projectEntity(entity, doc)).toEqual({ content: { kept: "keep" } });
  });

  it("projects a top-level tombstone as absent (no default)", () => {
    const entity = mkDoc({ value: null, update_id: "u" });

    expect(projectEntity(entity, doc)).toEqual({ content: undefined });
  });
});

describe("projected rows carry the entity id", () => {
  it("projectRow adds the entity id to the shape projection", () => {
    const entity = entityRow("t1", "todo", { title: "a", completed: false });
    expect(projectRow(entity, todo.shape)).toEqual({
      title: "a",
      completed: false,
      body: undefined,
      id: "t1",
    });
  });

  it("projectQueryRow adds the entity id and its group ids", () => {
    const entity = entityRow("t1", "todo", { title: "a", completed: false });
    expect(projectQueryRow(entity, todo.shape, ["g1", "g2"])).toEqual({
      title: "a",
      completed: false,
      body: undefined,
      id: "t1",
      groupIds: ["g1", "g2"],
    });
  });

  it("the injected groupIds wins over a same-named projected field", () => {
    const withGroupIdsField = defineModel("withGroupIdsField", {
      groupIds: e.string(),
      title: e.string(),
    });
    const entity = entityRow("t1", "todo", { groupIds: "field-value", title: "a" });
    expect(projectQueryRow(entity, withGroupIdsField.shape, ["g1"]).groupIds).toEqual(["g1"]);
  });

  it("the injected id wins over a same-named field, and reads as a string", () => {
    const withIdField = defineModel("withIdField", { id: e.string(), title: e.string() });
    expect(projectRow(entityRow("t1", "todo", { id: "field-value" }), withIdField.shape).id).toBe(
      "t1",
    );

    const withNumberId = defineModel("withNumberId", { id: e.number(), title: e.string() });
    // Compile-time proof: the row's `id` is the injected string, not the field's number.
    const id: string = projectRow(entityRow("t1", "todo", { id: 42 }), withNumberId.shape).id;
    expect(id).toBe("t1");
  });

  it("a candidate row carries no groupIds (no membership source)", async () => {
    const rows = [entityRow("1", "todo", { title: "a", completed: false })];
    const [row] = await buildQueryBuilder(rows, todo.shape);
    expect(row).not.toHaveProperty("groupIds");
    if (row !== undefined) {
      // @ts-expect-error a candidate chain has no membership index to read.
      void row.groupIds;
    }
  });
});

describe("buildQueryBuilder — chain mutators", () => {
  it("where filters by field equality", async () => {
    const rows = [
      entityRow("1", "todo", { title: "a", completed: false }),
      entityRow("2", "todo", { title: "b", completed: true }),
      entityRow("3", "todo", { title: "c", completed: false }),
    ];
    const out = await buildQueryBuilder(rows, todo.shape).where("completed", false);
    expect(out.map((r) => r.title)).toEqual(["a", "c"]);
  });

  it("has / hasNot refuse a chain over already-materialized rows", () => {
    const chain = buildQueryBuilder([entityRow("1", "todo", { title: "a" })], todo.shape);
    expect(() => chain.has("title")).toThrow(/carries no component index/);
    expect(() => chain.hasNot("title")).toThrow(/carries no component index/);
  });

  it("result refuses a chain over already-materialized rows", () => {
    const chain = buildQueryBuilder([entityRow("1", "todo", { title: "a" })], todo.shape);
    expect(() => chain.result()).toThrow(/no engine store/);
  });

  it("orderBy sorts by field", async () => {
    const rows = [
      entityRow("1", "todo", { title: "banana", completed: false }),
      entityRow("2", "todo", { title: "apple", completed: false }),
      entityRow("3", "todo", { title: "cherry", completed: false }),
    ];
    const out = await buildQueryBuilder(rows, todo.shape).orderBy("title", "asc");
    expect(out.map((r) => r.title)).toEqual(["apple", "banana", "cherry"]);
  });

  it("limit caps the result count", async () => {
    const rows = [
      entityRow("1", "todo", { title: "a", completed: false }),
      entityRow("2", "todo", { title: "b", completed: false }),
      entityRow("3", "todo", { title: "c", completed: false }),
    ];
    const out = await buildQueryBuilder(rows, todo.shape).limit(2);
    expect(out.map((r) => r.title)).toEqual(["a", "b"]);
  });

  it("chains where + orderBy + limit", async () => {
    const rows = [
      entityRow("1", "todo", { title: "a", completed: false }),
      entityRow("2", "todo", { title: "b", completed: true }),
      entityRow("3", "todo", { title: "c", completed: true }),
      entityRow("4", "todo", { title: "d", completed: true }),
    ];
    const out = await buildQueryBuilder(rows, todo.shape)
      .where("completed", true)
      .orderBy("title", "desc")
      .limit(2);
    expect(out.map((r) => r.title)).toEqual(["d", "c"]);
  });

  it("returns a new builder on every chain call (no shared state)", async () => {
    const rows = [
      entityRow("1", "todo", { title: "a", completed: false }),
      entityRow("2", "todo", { title: "b", completed: true }),
    ];
    const base = buildQueryBuilder(rows, todo.shape);
    const a = base.where("completed", true);
    const b = base.where("completed", false);
    expect((await a).map((r) => r.title)).toEqual(["b"]);
    expect((await b).map((r) => r.title)).toEqual(["a"]);
    expect((await base).map((r) => r.title).sort()).toEqual(["a", "b"]);
  });
});

describe("buildQueryBuilder — .or(...) disjunction", () => {
  it("unions two single-filter groups", async () => {
    const rows = [
      entityRow("1", "todo", { title: "a", completed: true }),
      entityRow("2", "todo", { title: "b", completed: false }),
      entityRow("3", "todo", { title: "c", completed: false }),
    ];
    const out = await buildQueryBuilder(rows, todo.shape).where("completed", true).or("title", "b");
    expect(out.map((r) => r.title)).toEqual(["a", "b"]);
  });

  it("(a AND b) OR (c AND d) truth table", async () => {
    const rows = [
      entityRow("r1", "todo", { title: "a", completed: false }), // a=true, b → match
      entityRow("r2", "todo", { title: "b", completed: true }), // c=true, d → match
      entityRow("r3", "todo", { title: "b", completed: false }), // d but not c
      entityRow("r4", "todo", { title: "a", completed: true }), // b but not a
    ];
    const out = await buildQueryBuilder(rows, todo.shape)
      .where("completed", false)
      .where("title", "a")
      .or("completed", true)
      .where("title", "b");
    expect(out.map((r) => r.title)).toEqual(["a", "b"]);
  });

  it("leading .or starts the first group, like .where", async () => {
    const rows = [
      entityRow("1", "todo", { title: "a", completed: true }),
      entityRow("2", "todo", { title: "b", completed: false }),
    ];
    const viaOr = await buildQueryBuilder(rows, todo.shape).or("completed", true);
    const viaWhere = await buildQueryBuilder(rows, todo.shape).where("completed", true);
    expect(viaOr.map((r) => r.title)).toEqual(["a"]);
    expect(viaOr.map((r) => r.title)).toEqual(viaWhere.map((r) => r.title));
  });

  it("an empty branch contributes nothing to the union", async () => {
    const rows = [
      entityRow("1", "todo", { title: "a", completed: false }),
      entityRow("2", "todo", { title: "b", completed: true }),
    ];
    // The leading group matches nothing, so only the `.or` branch survives.
    const out = await buildQueryBuilder(rows, todo.shape)
      .where("title", "missing")
      .or("completed", true);
    expect(out.map((r) => r.title)).toEqual(["b"]);
  });

  it("composes with orderBy, limit, first, count, exists and async iteration", async () => {
    const rows = [
      entityRow("1", "todo", { title: "banana", completed: false }),
      entityRow("2", "todo", { title: "apple", completed: false }),
      entityRow("3", "todo", { title: "cherry", completed: true }),
    ];
    const qb = buildQueryBuilder(rows, todo.shape).where("completed", false).or("title", "cherry");
    expect((await qb.orderBy("title", "asc")).map((r) => r.title)).toEqual([
      "apple",
      "banana",
      "cherry",
    ]);
    expect((await qb.orderBy("title", "asc").limit(2)).map((r) => r.title)).toEqual([
      "apple",
      "banana",
    ]);
    expect((await qb.first())?.title).toBe("banana");
    expect(await qb.count()).toBe(3);
    expect(await qb.exists()).toBe(true);
    const titles: string[] = [];
    for await (const row of qb) titles.push(row.title ?? "");
    expect(titles).toEqual(["banana", "apple", "cherry"]);
    expect((await qb.toRaw()).map((e) => e.id)).toEqual(["1", "2", "3"]);
  });

  it("returns empty when every group matches nothing", async () => {
    const rows = [entityRow("1", "todo", { title: "a", completed: false })];
    const out = await buildQueryBuilder(rows, todo.shape)
      .where("title", "nope")
      .or("completed", true);
    expect(out).toEqual([]);
  });

  it("or's field value narrows to the field's TypeBox static type", () => {
    const rows: Entity[] = [];
    const builder = buildQueryBuilder(rows, todo.shape);
    builder.or("title", "hello");
    builder.or("body", null);
    builder.or("completed", false);
    // The relationship overload accepts a pointer string on any key.
    builder.or("completed", "not a boolean");
    expect(true).toBe(true);
  });

  it("rejects a value that is neither a field type nor a pointer on .or", () => {
    const rows: Entity[] = [];
    const builder = buildQueryBuilder(rows, todo.shape);
    const invoke = () => {
      // @ts-expect-error — 42 is neither `completed`'s boolean nor a PointerValue.
      builder.or("completed", 42);
      // @ts-expect-error — 42 is neither `title`'s string nor a PointerValue.
      builder.or("title", 42);
      // @ts-expect-error — an object without a string `.id` is not a PointerValue.
      builder.or("title", { id: 42 });
    };
    expect(invoke).toBeTypeOf("function");
  });

  it("rejects an unknown field name on .or at compile time", () => {
    const rows: Entity[] = [];
    const builder = buildQueryBuilder(rows, todo.shape);
    const invoke = () => {
      // @ts-expect-error — `bogus` is not in the field map and `true` is not a pointer.
      builder.or("bogus", true);
    };
    expect(invoke).toBeTypeOf("function");
  });

  it("throws on an unknown key passed to .or at runtime", () => {
    const rows: Entity[] = [];
    const builder = buildQueryBuilder(rows, todo.shape);
    expect(() => builder.or("bogus", "x")).toThrow(/or\("bogus"\)/);
  });

  it("returns a new builder on every .or call (no shared state)", async () => {
    const rows = [
      entityRow("1", "todo", { title: "a", completed: false }),
      entityRow("2", "todo", { title: "b", completed: true }),
    ];
    const base = buildQueryBuilder(rows, todo.shape).where("completed", false);
    const withOr = base.or("completed", true);
    expect((await base).map((r) => r.title)).toEqual(["a"]);
    expect((await withOr).map((r) => r.title)).toEqual(["a", "b"]);
  });
});

describe("buildQueryBuilder — thenable projection", () => {
  it("await qb resolves to readonly Static<typeof shape>[]", async () => {
    const rows = [entityRow("1", "todo", { title: "a", completed: false, body: null })];
    const out: readonly Todo[] = await buildQueryBuilder(rows, todo.shape);
    expect(out[0]?.title).toBe("a");
    expect(out[0]?.completed).toBe(false);
    expect(out[0]?.body).toBeUndefined();
  });

  it("projection honors all three field states", async () => {
    const setEntity = entityRow("1", "todo", { title: "set", completed: true, body: "note" });
    const nulledEntity = entityRow("2", "todo", { title: "nulled", completed: false, body: null });
    const absentEntity = entityRow("3", "todo", { title: "absent", completed: false });
    const out: readonly Todo[] = await buildQueryBuilder(
      [setEntity, nulledEntity, absentEntity],
      todo.shape,
    );
    expect(out[0]?.body).toBe("note");
    expect(out[1]?.body).toBeUndefined();
    expect(out[2]?.body).toBeUndefined();
  });

  it("awaited thenable rejects when the candidate loader rejects", async () => {
    // Regression: a rejecting loader must settle the awaited builder
    // rather than leaving it pending with an unhandled inner rejection.
    const builder = buildLazyQueryBuilder(
      () => Promise.reject(new Error("loader down")),
      todo.shape,
    );
    await expect(builder).rejects.toThrow("loader down");
  });
});

describe("buildQueryBuilder — .toRaw() escape hatch", () => {
  it("await qb.toRaw() resolves through the chain's filters", async () => {
    const rows = [
      entityRow("1", "todo", { title: "a", completed: false }),
      entityRow("2", "todo", { title: "b", completed: true }),
    ];
    const out = await buildQueryBuilder(rows, todo.shape).where("completed", false).toRaw();
    expect(out.map((e) => e.id)).toEqual(["1"]);
  });

  it("returns the untyped wire rows, not the projected shape", async () => {
    const rows = [
      entityRow("1", "todo", { title: "a", completed: false, body: null }, { updateId: "u" }),
    ];
    const out = await buildQueryBuilder(rows, todo.shape).toRaw();
    expect(out[0]?.id).toBe("1");
    // Wire envelope is intact: `data.fields.title.value` is "a", not the projected string.
    expect(out[0]?.data?.fields?.title).toEqual({ value: "a", update_id: "u" });
    expect(out[0]?.data?.fields?.body).toEqual({ value: null, update_id: "u" });
  });
});

describe("buildQueryBuilder — tombstone exclusion", () => {
  const tombstone = (entity: Entity): Entity => ({ ...entity, deleted_hlc: "9" });

  it("excludes a tombstoned candidate from every terminal", async () => {
    const dead = tombstone(entityRow("1", "todo", { title: "gone", completed: false }));
    const live = entityRow("2", "todo", { title: "here", completed: false });
    const builder = buildQueryBuilder([dead, live], todo.shape);

    expect((await builder).map((r) => r.title)).toEqual(["here"]);
    expect(await builder.count()).toBe(1);
    expect((await builder.first())?.title).toBe("here");
    expect((await builder.toRaw()).map((e) => e.id)).toEqual(["2"]);
  });

  it("keeps a live row that carries the same fields as a tombstone", async () => {
    const fields = { title: "same", completed: false };
    const rows = [tombstone(entityRow("1", "todo", fields)), entityRow("2", "todo", fields)];
    const out = await buildQueryBuilder(rows, todo.shape);
    expect(out.map((r) => r.title)).toEqual(["same"]);
  });
});

describe("buildQueryBuilder — value narrowing against the field map", () => {
  it("where's field value narrows to the field's TypeBox static type", () => {
    const rows: Entity[] = [];
    const builder = buildQueryBuilder(rows, todo.shape);
    // Title is e.string() → value is string.
    builder.where("title", "hello");
    builder.where("title", "world");
    // Body is e.string() → value is string | undefined.
    builder.where("body", null);
    builder.where("body", "note");
    // Completed is e.boolean() → value is boolean.
    builder.where("completed", false);
    builder.where("completed", true);
    expect(true).toBe(true);
  });

  it("the relationship overload accepts a pointer string on any key", () => {
    const rows: Entity[] = [];
    const builder = buildQueryBuilder(rows, todo.shape);
    // The relationship overload's target is `PointerValue`, and a
    // string is one — so this type-checks even though `completed` is
    // boolean. The registry decides field vs. edge at runtime; this
    // is the documented escape hatch of the overload pair.
    builder.where("completed", "not a boolean");
    expect(true).toBe(true);
  });

  it("rejects a value that is neither a field type nor a pointer", () => {
    const rows: Entity[] = [];
    const builder = buildQueryBuilder(rows, todo.shape);
    // Never invoked: the @ts-expect-error lines below are the assertion.
    const invoke = () => {
      // @ts-expect-error — 42 is neither `completed`'s boolean nor a PointerValue.
      builder.where("completed", 42);
      // @ts-expect-error — 42 is neither `title`'s string nor a PointerValue.
      builder.where("title", 42);
      // @ts-expect-error — an object without a string `.id` is not a PointerValue.
      builder.where("title", { id: 42 });
    };
    expect(invoke).toBeTypeOf("function");
  });

  it("rejects an unknown field name at compile time", () => {
    const rows: Entity[] = [];
    const builder = buildQueryBuilder(rows, todo.shape);
    // Never invoked: the @ts-expect-error below is the assertion. The
    // runtime throw for an unknown key is pinned by the test that follows.
    const invoke = () => {
      // @ts-expect-error — `bogus` is not in the field map and `true` is not a pointer.
      builder.where("bogus", true);
    };
    expect(invoke).toBeTypeOf("function");
  });

  it("throws on an unknown key at runtime", () => {
    const rows: Entity[] = [];
    const builder = buildQueryBuilder(rows, todo.shape);
    // `bogus` is accepted by the relationship overload (any string
    // key, string pointer) but no field or relationship declares it.
    expect(() => builder.where("bogus", "x")).toThrow(/not a field/);
  });

  it("rejects a pointer-shaped value that cannot predicate a scalar field", () => {
    const rows: Entity[] = [];
    const builder = buildQueryBuilder(rows, todo.shape);
    // Both type-check against the open relationship overload; the field
    // branch must reject them instead of comparing a scalar to them.
    expect(() => builder.where("title", { id: "x" })).toThrow(EntityValidationError);
    expect(() => builder.where("completed", ["a", "b"])).toThrow(EntityValidationError);
  });

  it("still accepts an array value for an array-typed field", async () => {
    const tagged = defineModel("tagged", {
      title: e.string(),
      tags: e.array(e.string()),
    });
    // Field equality is structural (see `valuesEqual`), so a fresh array
    // with the same elements matches. The point here is that a schema-valid
    // array reaches the field filter rather than throwing.
    const rows: Entity[] = [entityRow("1", "todo", { title: "x", tags: ["a", "b"] })];
    const out = await buildQueryBuilder(rows, tagged.shape).where("tags", ["a", "b"]);
    expect(out.map((r) => r.title)).toEqual(["x"]);
  });

  it(".eq is gone", () => {
    const rows: Entity[] = [];
    const builder = buildQueryBuilder(rows, todo.shape);
    // @ts-expect-error — `.eq` was removed in #247; `.where` is the single predicate.
    const legacy = builder.eq;
    expect(legacy).toBeUndefined();
  });
});

describe("buildQueryBuilder — .first()", () => {
  it("returns the first projected survivor", async () => {
    const rows = [
      entityRow("1", "todo", { title: "a", completed: false }),
      entityRow("2", "todo", { title: "b", completed: true }),
      entityRow("3", "todo", { title: "c", completed: false }),
    ];
    const first = await buildQueryBuilder(rows, todo.shape).where("completed", false).first();
    expect(first?.title).toBe("a");
  });

  it("returns undefined when no rows match", async () => {
    const rows = [entityRow("1", "todo", { title: "a", completed: true })];
    const first = await buildQueryBuilder(rows, todo.shape).where("completed", false).first();
    expect(first).toBeUndefined();
  });

  it("honors orderBy before picking the first", async () => {
    const rows = [
      entityRow("1", "todo", { title: "banana", completed: false }),
      entityRow("2", "todo", { title: "apple", completed: false }),
      entityRow("3", "todo", { title: "cherry", completed: false }),
    ];
    const first = await buildQueryBuilder(rows, todo.shape).orderBy("title", "asc").first();
    expect(first?.title).toBe("apple");
  });
});

describe("buildQueryBuilder — .count()", () => {
  it("counts the surviving rows", async () => {
    const rows = [
      entityRow("1", "todo", { title: "a", completed: false }),
      entityRow("2", "todo", { title: "b", completed: true }),
      entityRow("3", "todo", { title: "c", completed: false }),
    ];
    const n = await buildQueryBuilder(rows, todo.shape).where("completed", false).count();
    expect(n).toBe(2);
  });

  it("returns 0 when no rows match", async () => {
    const rows = [entityRow("1", "todo", { title: "a", completed: true })];
    const n = await buildQueryBuilder(rows, todo.shape).where("completed", false).count();
    expect(n).toBe(0);
  });

  it("honors limit when counting", async () => {
    const rows = [
      entityRow("1", "todo", { title: "a", completed: false }),
      entityRow("2", "todo", { title: "b", completed: false }),
      entityRow("3", "todo", { title: "c", completed: false }),
    ];
    const n = await buildQueryBuilder(rows, todo.shape).limit(2).count();
    expect(n).toBe(2);
  });
});

describe("buildQueryBuilder — .exists()", () => {
  it("returns true when at least one row matches", async () => {
    const rows = [
      entityRow("1", "todo", { title: "a", completed: false }),
      entityRow("2", "todo", { title: "b", completed: true }),
    ];
    const exists = await buildQueryBuilder(rows, todo.shape).where("completed", false).exists();
    expect(exists).toBe(true);
  });

  it("returns false when no rows match", async () => {
    const rows = [entityRow("1", "todo", { title: "a", completed: true })];
    const exists = await buildQueryBuilder(rows, todo.shape).where("completed", false).exists();
    expect(exists).toBe(false);
  });

  it("honors limit when checking existence", async () => {
    const rows = [entityRow("1", "todo", { title: "a", completed: false })];
    const exists = await buildQueryBuilder(rows, todo.shape).limit(0).exists();
    expect(exists).toBe(false);
  });
});

describe("buildQueryBuilder — [Symbol.asyncIterator]", () => {
  it("yields each projected survivor", async () => {
    const rows = [
      entityRow("1", "todo", { title: "a", completed: false }),
      entityRow("2", "todo", { title: "b", completed: true }),
      entityRow("3", "todo", { title: "c", completed: false }),
    ];
    const titles: string[] = [];
    for await (const row of buildQueryBuilder(rows, todo.shape).where("completed", false)) {
      titles.push(row.title ?? "");
    }
    expect(titles).toEqual(["a", "c"]);
  });

  it("yields nothing when no rows match", async () => {
    const rows = [entityRow("1", "todo", { title: "a", completed: true })];
    const out: Todo[] = [];
    for await (const row of buildQueryBuilder(rows, todo.shape).where("completed", false)) {
      out.push(row);
    }
    expect(out).toEqual([]);
  });
});

describe("buildLazyQueryBuilder", () => {
  it("loads candidates at materialization time, not at build time", async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return [entityRow("1", "todo", { title: "a", completed: false })];
    };
    const builder = buildLazyQueryBuilder(loader, todo.shape).where("completed", false);
    expect(calls).toBe(0);
    const out = await builder;
    expect(calls).toBe(1);
    expect(out.map((r) => r.title)).toEqual(["a"]);
  });

  it("re-loads on every await (reflects the latest snapshot)", async () => {
    let n = 0;
    const loader = async () => [entityRow("1", "todo", { title: String(n++), completed: false })];
    const builder = buildLazyQueryBuilder(loader, todo.shape);
    expect((await builder)[0]?.title).toBe("0");
    expect((await builder)[0]?.title).toBe("1");
  });

  it("toRaw() also re-loads candidates", async () => {
    const loader = async () => [entityRow("1", "todo", { title: "a", completed: false })];
    const out = await buildLazyQueryBuilder(loader, todo.shape).toRaw();
    expect(out).toHaveLength(1);
    expect(out[0]?.data?.fields?.title?.value).toBe("a");
  });
});

describe("projectFieldValue caching", () => {
  it("returns the same projection for the same map version", () => {
    const field: FieldValue = { map: { a: { value: "x", update_id: "u" } } };

    expect(projectFieldValue(field)).toBe(projectFieldValue(field));
  });
});

describe("projectEntity — declarative defaults (non-optional)", () => {
  const task = defineModel("task", {
    priority: e.string().default("normal"),
    title: e.string(),
    tags: e.map(e.string()).default({}),
  });

  it("fills an absent leaf with the declared default", () => {
    const entity = entityRow("1", "todo", { title: "Ship" });
    const row = projectEntity(entity, task.shape);
    expect(row.priority).toBe("normal");
    expect(row.tags).toEqual({});
  });

  it("fills a tombstoned leaf with the declared default", () => {
    const entity = entityRow("1", "todo", { title: "Ship", priority: null, tags: null });
    const row = projectEntity(entity, task.shape);
    expect(row.priority).toBe("normal");
    expect(row.tags).toEqual({});
  });

  it("keeps a stored value over the default", () => {
    const entity = entityRow("1", "todo", { title: "Ship", priority: "urgent", tags: { a: "x" } });
    const row = projectEntity(entity, task.shape);
    expect(row.priority).toBe("urgent");
    expect(row.tags).toEqual({ a: "x" });
  });
});

describe("ordering — declarative defaults", () => {
  const task = defineModel("task", {
    priority: e.string().default("normal"),
    title: e.string(),
  });

  const rows = [
    entityRow("a", "todo", { priority: "zzz", title: "b" }),
    entityRow("b", "todo", {}),
    entityRow("c", "todo", { priority: "aaa", title: "a" }),
  ];

  it("compares a defaulted field as it reads", async () => {
    const ascending = await buildQueryBuilder(rows, task.shape).orderBy("priority", "asc");
    const descending = await buildQueryBuilder(rows, task.shape).orderBy("priority", "desc");
    // b has no stored priority, so it reads as "normal" and sorts between
    // the two stored values.
    expect(ascending.map((row) => row.id)).toEqual(["c", "b", "a"]);
    expect(descending.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts an undefaulted absent field last in both directions", async () => {
    const ascending = await buildQueryBuilder(rows, task.shape).orderBy("title", "asc");
    const descending = await buildQueryBuilder(rows, task.shape).orderBy("title", "desc");
    expect(ascending.map((row) => row.id)).toEqual(["c", "a", "b"]);
    expect(descending.map((row) => row.id)).toEqual(["a", "c", "b"]);
  });
});

describe("projectEntity — optional components", () => {
  const note = defineModel("note", {
    title: e.string(),
    draft: defineComponent("note/draft", e.string(), { optional: true }),
  });

  it("reads an absent component as undefined, with no default to resolve", () => {
    expect(
      projectEntity(entityRow("1", "todo", { title: "Ship" }), note.shape).draft,
    ).toBeUndefined();
  });

  it("reads a cleared component as undefined too: only existence separates them", () => {
    expect(
      projectEntity(entityRow("1", "todo", { title: "Ship", draft: null }), note.shape).draft,
    ).toBe(undefined);
  });

  it("reads a present leaf as its stored value", () => {
    expect(
      projectEntity(entityRow("1", "todo", { title: "Ship", draft: "v1" }), note.shape).draft,
    ).toBe("v1");
  });
});
