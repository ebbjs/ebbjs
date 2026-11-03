/**
 * The invocation frame's write half: the bundle's exported schema reaches
 * `ctx`, a returning handler flushes its buffered writes as exactly one commit
 * call, and a throwing handler flushes nothing.
 */

import { describe, expect, it } from "vitest";

import { defineEntity, defineSchema, e } from "@ebbjs/schema";

import { runInvocation, schemaRegistryOf } from "./index.ts";
import type { HostTransport } from "./transport.ts";

const issue = defineEntity("issue", { title: e.string() });
const schema = defineSchema({ entities: { issue }, version: 1 });

interface Journal {
  readonly transport: HostTransport;
  readonly commits: unknown[];
}

const journal = (): Journal => {
  const commits: unknown[] = [];
  const transport: HostTransport = {
    async call(op, payload) {
      if (op === "commit") {
        commits.push(payload);
        return { replayed: false };
      }
      return null;
    },
  };
  return { transport, commits };
};

const bundle = (body: string): string => `
  var __ebbFunction = {
    handler: async (ctx, params) => { ${body} },
    schema: globalThis.__runnerTestSchema,
  };
`;

/** The bundle evaluates in the global scope, so a test can hand it a schema. */
const exposeSchema = (): void => {
  (globalThis as Record<string, unknown>)["__runnerTestSchema"] = schema;
};

describe("runInvocation", () => {
  it("flushes a returning handler's writes as one commit frame", async () => {
    exposeSchema();
    const { transport, commits } = journal();

    const value = await runInvocation({
      transport,
      invocationId: "inv_runner1",
      subjectActorId: "a_test",
      bundle: bundle(`
        const created = ctx.create("issue", { title: "Ship" }, { groups: ["g_1"] });
        return { id: created.id };
      `),
      entry: "handler",
      input: undefined,
    });

    expect(value).toMatchObject({ id: expect.stringMatching(/^e_/) });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      actor_id: "a_test",
      gsn: 0,
      updates: [{ subject_type: "issue", method: "put" }, { subject_type: "entityGroup" }],
    });
  });

  it("commits nothing when the handler throws", async () => {
    exposeSchema();
    const { transport, commits } = journal();

    await expect(
      runInvocation({
        transport,
        invocationId: "inv_runner2",
        subjectActorId: "a_test",
        bundle: bundle(`
          ctx.create("issue", { title: "Doomed" }, { groups: ["g_1"] });
          throw new Error("handler exploded");
        `),
        entry: "handler",
        input: undefined,
      }),
    ).rejects.toThrow("handler exploded");

    expect(commits).toEqual([]);
  });

  it("keeps an explicit commit durable when the handler throws after it", async () => {
    exposeSchema();
    const { transport, commits } = journal();

    await expect(
      runInvocation({
        transport,
        invocationId: "inv_runner2b",
        subjectActorId: "a_test",
        bundle: bundle(`
          ctx.create("issue", { title: "Committed" }, { groups: ["g_1"] });
          await ctx.commit();
          throw new Error("after commit");
        `),
        entry: "handler",
        input: undefined,
      }),
    ).rejects.toThrow("after commit");

    // `ctx.commit()` is the point of no return: the handler cannot un-send it.
    expect(commits).toHaveLength(1);
  });

  it("sends nothing when a returning handler buffered no writes", async () => {
    exposeSchema();
    const { transport, commits } = journal();

    await runInvocation({
      transport,
      invocationId: "inv_runner3",
      subjectActorId: "a_test",
      bundle: bundle("return { ok: true };"),
      entry: "handler",
      input: undefined,
    });

    expect(commits).toEqual([]);
  });

  it("hands the bundle's schema registry to the context", () => {
    expect(schemaRegistryOf({ schema })).toBe(schema._registry);
    expect(schemaRegistryOf({})).toBeUndefined();
    expect(schemaRegistryOf({ schema: {} })).toBeUndefined();
    expect(schemaRegistryOf({ schema: { _registry: { get: () => undefined } } })).toBeUndefined();
  });
});
