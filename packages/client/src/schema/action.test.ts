/**
 * Unit tests for `defineAction` — the pure declaration form of a
 * cross-entity Action.
 *
 * The declaration is data: a frozen `ActionDef` capturing the entity
 * types to create plus a declared `RelationshipDef` per edge to wire.
 * It allocates nothing and touches no wire state; `client.atomic`
 * lowers it through the same resolver the callback form uses (see
 * `../sync/__tests__/atomic.test.ts` for the equivalence test).
 */

import { describe, expect, it, expectTypeOf } from "vitest";
import { Type } from "@sinclair/typebox";

import { defineEntity, e } from "./entity";
import { defineRelationship } from "./relationship";
import { defineAction, type ActionPointer, type ActionValues, type ActionHandles } from "./action";

const todo = defineEntity("todo", { title: e.string() });
const list = defineEntity("list", { name: e.string() });
const rel = defineRelationship({ source: todo, target: list, as: "list" });

const writes = [todo, list, rel] as const;

describe("defineAction", () => {
  it("returns a frozen value carrying writes and values", () => {
    const def = defineAction({
      writes: [todo, list, rel],
      values: { todo: { title: "Ship it" }, list: { name: "Today" } },
    });

    expect(def.writes).toEqual([todo, list, rel]);
    expect(def.values).toEqual({ todo: { title: "Ship it" }, list: { name: "Today" } });
    expect(Object.isFrozen(def)).toBe(true);
    expect(Object.isFrozen(def.writes)).toBe(true);
  });

  it("allocates no ids and mutates nothing at definition time", () => {
    const todoValues = { title: "Ship it" };
    const listValues = { name: "Today" };

    const def = defineAction({
      writes: [todo, list, rel],
      values: { todo: todoValues, list: listValues },
    });

    // The declaration keeps the caller's values by reference; eager id
    // allocation happens on submit, never in `defineAction`.
    expect(def.values.todo).toBe(todoValues);
    expect(def.values.list).toBe(listValues);
    expect(todoValues).not.toHaveProperty("id");
    expect(listValues).not.toHaveProperty("id");
  });

  it("does not allocate an id even when the same definition is reused", () => {
    const def = defineAction({
      writes: [todo, list, rel],
      values: { todo: { title: "Ship it" }, list: { name: "Today" } },
    });
    const first = def.values.todo;
    expect(def.values.todo).toBe(first);
    expect(Object.isFrozen(def)).toBe(true);
  });
});

describe("defineAction types", () => {
  it("flows entity fields into the values map", () => {
    type Values = ActionValues<typeof writes>;
    expectTypeOf<Values["todo"]["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Values["list"]["name"]>().toEqualTypeOf<string>();
    expectTypeOf<Values>().not.toHaveProperty("label");
  });

  it("flows entity fields into the returned handles", () => {
    type Handles = ActionHandles<typeof writes>;
    expectTypeOf<Handles["todo"]["id"]>().toEqualTypeOf<string>();
    expectTypeOf<Handles["todo"]["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Handles["list"]["name"]>().toEqualTypeOf<string>();
    expectTypeOf<Handles>().not.toHaveProperty("label");
  });

  it("types a declared relationship key as an optional pointer", () => {
    const tagsTodo = defineEntity("todo", {
      title: e.string(),
      tags: Type.Array(Type.String()),
    });
    const label = defineEntity("label", { name: e.string() });
    const tags = defineRelationship({
      source: tagsTodo,
      target: label,
      as: "tags",
      sourceCardinality: "many",
    });

    type Values = ActionValues<[typeof tagsTodo, typeof label, typeof tags]>;
    expectTypeOf<Values["todo"]["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Values["todo"]["tags"]>().toEqualTypeOf<ActionPointer | undefined>();
  });

  it("rejects a value that does not match the entity shape", () => {
    // @ts-expect-error — `title` is a string field
    const bad: ActionValues<typeof writes> = { todo: { title: 1 }, list: { name: "Today" } };
    void bad;
  });

  it("rejects an undeclared entity name in values", () => {
    const extra: ActionValues<typeof writes> = {
      todo: { title: "x" },
      list: { name: "y" },
      // @ts-expect-error — `label` is not an entity in this Action
      label: { name: "z" },
    };
    void extra;
  });

  it("rejects a missing entity value in values", () => {
    // @ts-expect-error — every entity write needs a values entry
    const missing: ActionValues<typeof writes> = { todo: { title: "x" } };
    void missing;
  });
});
