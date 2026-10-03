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
    expect(Object.isFrozen(def.values)).toBe(true);
    expect(Object.isFrozen(def.values.todo)).toBe(true);
    expect(Object.isFrozen(def.values.list)).toBe(true);
  });

  it("allocates no ids and mutates nothing at definition time", () => {
    const todoValues = { title: "Ship it" };
    const listValues = { name: "Today" };

    const def = defineAction({
      writes: [todo, list, rel],
      values: { todo: todoValues, list: listValues },
    });

    // `defineAction` copies the value containers it owns and freezes the
    // copies; the caller's objects stay unfrozen and unmutated. Eager id
    // allocation happens on submit, never in `defineAction`.
    expect(def.values.todo).not.toBe(todoValues);
    expect(def.values.list).not.toBe(listValues);
    expect(def.values.todo).toEqual(todoValues);
    expect(def.values.list).toEqual(listValues);
    expect(Object.isFrozen(def.values)).toBe(true);
    expect(Object.isFrozen(def.values.todo)).toBe(true);
    expect(Object.isFrozen(def.values.list)).toBe(true);
    expect(Object.isFrozen(todoValues)).toBe(false);
    expect(Object.isFrozen(listValues)).toBe(false);
    expect(todoValues).not.toHaveProperty("id");
    expect(listValues).not.toHaveProperty("id");
  });

  it("freezes array-valued pointer entries without mutating the caller's array", () => {
    const taggedTodo = defineEntity("todo", {
      title: e.string(),
      tags: Type.Array(Type.String()),
    });
    const label = defineEntity("label", { name: e.string() });
    const tags = defineRelationship({
      source: taggedTodo,
      target: label,
      as: "tags",
      sourceCardinality: "many",
    });
    const tagIds = ["label_1", "label_2"];

    const def = defineAction({
      writes: [taggedTodo, label, tags],
      values: { todo: { title: "Ship it", tags: tagIds }, label: { name: "Today" } },
    });

    expect(def.values.todo).toEqual({ title: "Ship it", tags: ["label_1", "label_2"] });
    expect(Object.isFrozen(def.values.todo)).toBe(true);
    expect(Object.isFrozen(def.values.todo.tags)).toBe(true);
    expect(def.values.todo.tags).not.toBe(tagIds);
    expect(Object.isFrozen(tagIds)).toBe(false);
  });

  it("does not allocate an id even when the same definition is reused", () => {
    const todoValues = { title: "Ship it" };
    const listValues = { name: "Today" };
    const def = defineAction({
      writes: [todo, list, rel],
      values: { todo: todoValues, list: listValues },
    });
    const first = def.values.todo;
    expect(def.values.todo).toBe(first);
    expect(Object.isFrozen(def)).toBe(true);
    expect(Object.isFrozen(def.values.todo)).toBe(true);
    expect(Object.isFrozen(todoValues)).toBe(false);
    expect(todoValues).not.toHaveProperty("id");
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
