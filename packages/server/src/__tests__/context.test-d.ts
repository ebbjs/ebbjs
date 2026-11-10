import { describe, expectTypeOf, it } from "vitest";

import { defineModel, defineSchema, e } from "@ebbjs/schema";

import type { CommitOutcome } from "../context";
import { defineFunction } from "../function";
import { p } from "../schema";

const ticket = defineModel("ticket", { title: e.string() });
const comment = defineModel("comment", { body: e.string() });
const schema = defineSchema({ models: { ticket, comment }, version: 1 });

describe("Context types", () => {
  it("accepts the schema's model names on every write verb", () => {
    defineFunction(schema, p.object({ title: p.string() }), async (ctx, params) => {
      const created = ctx.create("ticket", { title: params.title }, { groups: ["g_1"] });

      expectTypeOf(created.id).toEqualTypeOf<string>();

      ctx.update("ticket", created.id, { title: "Patched" }, { validate: true });
      ctx.delete("comment", "e_1");
      ctx.relate("ticket", created.id, "comments", "e_2");
      ctx.relate("ticket", created.id, "comments", ["e_2", "e_3"]);
      expectTypeOf(
        ctx.unrelate("ticket", created.id, "comments", "e_2", { relationshipId: "r_1" }),
      ).toEqualTypeOf<Promise<void>>();
      await ctx.unrelate("ticket", created.id, "comments");

      expectTypeOf(await ctx.commit()).toEqualTypeOf<CommitOutcome>();

      return created.id;
    });
  });

  it("still types reads and the subject", () => {
    defineFunction(schema, async (ctx) => {
      expectTypeOf(ctx.actor.id).toEqualTypeOf<string>();
      expectTypeOf(ctx.caller.kind).toEqualTypeOf<"actor" | "service">();
      expectTypeOf(ctx.invocationId).toEqualTypeOf<string>();
      return ctx.get("e_1");
    });
  });

  it("rejects a model name the schema does not declare", () => {
    defineFunction(schema, (ctx) => {
      // @ts-expect-error "tickets" is not a model in this schema
      ctx.create("tickets", {}, { groups: ["g_1"] });
    });
  });

  it("falls back to any entity name when the schema has no models map", () => {
    defineFunction({ tables: {} }, (ctx) => {
      ctx.create("anything", {}, { groups: ["g_1"] });
    });
  });
});
