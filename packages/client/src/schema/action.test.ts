/**
 * Unit tests for `defineAction` and the configuration checks
 * `createClient` runs around an `actions` map. Mounting behavior lives
 * in `../sync/__tests__/actions.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { defineEntity, e } from "./entity";
import { defineSchema } from "./schema";
import { ActionDefinitionError, defineAction, RUN, type ActionDef } from "./action";
import { createClient } from "../sync/client";

const todo = defineEntity("todo", { title: e.string() });
const list = defineEntity("list", { name: e.string() });
const schema = defineSchema({ entities: { todo, list }, version: 1 });
const otherSchema = defineSchema({ entities: { todo, list }, version: 2 });

/** Definition never reaches the network, so any fetch here is a bug. */
const neverFetch: typeof fetch = () => {
  throw new Error("fetch must not run while defining or mounting actions");
};

describe("defineAction", () => {
  it("returns a frozen, non-callable descriptor bound to the schema", () => {
    const def = defineAction(schema, () => ({}));
    expect(Object.isFrozen(def)).toBe(true);
    expect(def.schema).toBe(schema);
    expect(typeof def).toBe("object");
    expect(() => (def as unknown as () => void)()).toThrow();
  });

  it("keeps the callback private behind the RUN symbol", () => {
    const run = () => 42;
    const def = defineAction(schema, run);
    expect(def[RUN]).toBe(run);
    expect(Object.keys(def)).toEqual(["schema"]);
  });

  it("is pure: the callback is not invoked and the schema is untouched", () => {
    let called = false;
    const def = defineAction(schema, () => {
      called = true;
      return 1;
    });
    expect(called).toBe(false);
    expect(def.schema).toBe(schema);
  });

  it("infers Params from the callback's second argument and Result from its return", () => {
    const def = defineAction(schema, ({ todo: t }, params: { title: string }) => ({
      title: params.title,
      handle: t.create({ title: params.title }, { groups: ["g_1"] }),
    }));
    type Params = typeof def extends ActionDef<infer _S, infer P, infer _R> ? P : never;
    type Result = typeof def extends ActionDef<infer _S, infer _P, infer R> ? R : never;
    const params: Params = { title: "Ship" };
    const result: Result = {
      title: "Ship",
      handle: { id: "e_1", title: "Ship" },
    };
    expect(params.title).toBe("Ship");
    expect(result.handle.id).toBe("e_1");
    // @ts-expect-error — Params is the callback's `{ title: string }`.
    const wrong: Params = { name: "nope" };
    expect(wrong).toBeDefined();
  });

  it("defaults Params to void when the callback declares none", () => {
    const def = defineAction(schema, ({ todo: t }) =>
      t.create({ title: "Ship" }, { groups: ["g_1"] }),
    );
    type Params = typeof def extends ActionDef<infer _S, infer P, infer _R> ? P : never;
    const none: Params = undefined;
    expect(none).toBeUndefined();
    // @ts-expect-error — a void Params cannot carry a value.
    const wrong: Params = { title: "nope" };
    expect(wrong).toBeDefined();
  });
});

describe("ActionDefinitionError", () => {
  it("rejects actions passed without a schema", () => {
    const def = defineAction(schema, () => ({}));
    expect(() =>
      createClient({
        serverUrl: "http://localhost:4000",
        actorId: "actor_1",
        actions: { def },
        fetchImpl: neverFetch,
      }),
    ).toThrow(ActionDefinitionError);
  });

  it("rejects an action defined against a different schema, naming the key", () => {
    const def = defineAction(otherSchema, () => ({}));
    let caught: unknown;
    try {
      createClient({
        serverUrl: "http://localhost:4000",
        actorId: "actor_1",
        schema,
        actions: { rename: def },
        fetchImpl: neverFetch,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ActionDefinitionError);
    expect((caught as ActionDefinitionError).message).toContain("rename");
  });
});
