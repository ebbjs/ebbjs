/**
 * The invocation frame's write half: the bundle's exported schema reaches
 * `ctx`, a returning handler flushes its buffered writes as exactly one commit
 * call, and a throwing handler flushes nothing.
 */

import { describe, expect, it, vi } from "vitest";

import type { FetchAuditFields, FunctionLimits } from "@ebbjs/functions-protocol";
import type { LogEntry } from "@ebbjs/functions-runtime";
import { defineModel, defineSchema, e } from "@ebbjs/schema";

import { LOG_TRUNCATION_NOTICE } from "./logging.ts";
import { runInvocation, schemaRegistryOf } from "./index.ts";
import type { RunnerTransport } from "./transport.ts";

const issue = defineModel("issue", { title: e.string() });
const schema = defineSchema({ models: { issue }, version: 1 });

interface Journal {
  readonly transport: RunnerTransport;
  readonly calls: { op: string; payload: unknown }[];
  readonly commits: unknown[];
  readonly logs: LogEntry[];
  readonly audits: FetchAuditFields[];
}

const journal = (): Journal => {
  const calls: { op: string; payload: unknown }[] = [];
  const commits: unknown[] = [];
  const logs: LogEntry[] = [];
  const audits: FetchAuditFields[] = [];
  const transport: RunnerTransport = {
    async call(op, payload) {
      calls.push({ op, payload });
      if (op === "commit") {
        commits.push(payload);
        return { replayed: false };
      }
      return null;
    },
    log(entry) {
      logs.push(entry);
    },
    audit(fields) {
      audits.push(fields);
    },
  };
  return { transport, calls, commits, logs, audits };
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
    const frame = commits[0] as {
      readonly actor_id: string;
      readonly gsn: number;
      readonly updates: readonly { readonly component?: string; readonly method: string }[];
    };
    expect(frame).toMatchObject({ actor_id: "a_test", gsn: 0 });
    expect(new Set(frame.updates.map((update) => update.component))).toEqual(
      new Set(["issue/title", "entityGroup/entity_id", "entityGroup/group_id"]),
    );
    expect(frame.updates.every((update) => update.method === "replace")).toBe(true);
  });

  it("reports a service caller when the host resolved one", async () => {
    const { transport } = journal();

    const value = await runInvocation({
      transport,
      invocationId: "inv_runner1a",
      subjectActorId: "svc_actor",
      callerKind: "service",
      bundle: bundle(`return { kind: ctx.caller.kind, id: ctx.caller.id };`),
      entry: "handler",
      input: undefined,
    });

    expect(value).toEqual({ kind: "service", id: "svc_actor" });
  });

  it("runs a deployed definition and resolves the schema from it", async () => {
    exposeSchema();
    const { transport, commits } = journal();

    // The shape `@ebbjs/cli` produces: `export const proofreadDocument =
    // defineFunction(schema, ...)` becomes `{ proofreadDocument: definition }`.
    const value = await runInvocation({
      transport,
      invocationId: "inv_runner1b",
      subjectActorId: "a_test",
      bundle: `
        var __ebbFunction = {
          proofreadDocument: {
            schema: globalThis.__runnerTestSchema,
            handler: async (ctx) => {
              const created = ctx.create("issue", { title: "Proofread" }, { groups: ["g_1"] });
              return { id: created.id };
            },
          },
        };
      `,
      entry: "proofreadDocument",
      input: undefined,
    });

    expect(value).toMatchObject({ id: expect.stringMatching(/^e_/) });
    expect(commits).toHaveLength(1);
    const deployedFrame = commits[0] as {
      readonly updates: readonly { readonly component?: string }[];
    };
    expect(new Set(deployedFrame.updates.map((update) => update.component))).toEqual(
      new Set(["issue/title", "entityGroup/entity_id", "entityGroup/group_id"]),
    );
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

  it("resolves the registry from the entry's definition", () => {
    expect(schemaRegistryOf({ proofreadDocument: { schema } }, "proofreadDocument")).toBe(
      schema._registry,
    );
    expect(schemaRegistryOf({ proofreadDocument: { schema } })).toBeUndefined();
    expect(schemaRegistryOf({ proofreadDocument: {} }, "proofreadDocument")).toBeUndefined();
    expect(
      schemaRegistryOf({ proofreadDocument: { schema: {} } }, "proofreadDocument"),
    ).toBeUndefined();
  });

  it("prefers the module's schema over the entry's definition", () => {
    expect(
      schemaRegistryOf({ schema, proofreadDocument: { schema: {} } }, "proofreadDocument"),
    ).toBe(schema._registry);
  });
});

describe("runInvocation guardrails", () => {
  const invoke = (overrides: {
    bundle: string;
    input?: unknown;
    env?: Readonly<Record<string, string>>;
    limits?: FunctionLimits;
    transport?: RunnerTransport;
  }) =>
    runInvocation({
      transport: overrides.transport ?? journal().transport,
      invocationId: "inv_bounds",
      subjectActorId: "a_test",
      bundle: overrides.bundle,
      entry: "handler",
      input: overrides.input,
      env: overrides.env,
      limits: overrides.limits,
    });

  it("exposes the invoke's env as a frozen copy", async () => {
    const secrets = { API_TOKEN: "shh" };
    const { transport, logs } = journal();

    const value = await runInvocation({
      transport,
      invocationId: "inv_env",
      subjectActorId: "a_test",
      bundle: bundle(`
        return {
          env: { ...ctx.env },
          frozen: Object.isFrozen(ctx.env),
          assigned: (() => { try { ctx.env.API_TOKEN = "changed"; return true; } catch { return false; } })(),
        };
      `),
      entry: "handler",
      input: undefined,
      env: secrets,
    });

    expect(value).toEqual({
      env: { API_TOKEN: "shh" },
      frozen: true,
      assigned: false,
    });
    expect(secrets).toEqual({ API_TOKEN: "shh" });
    expect(logs).toEqual([]);
  });

  it("gives an invocation without secrets an empty frozen env", async () => {
    const value = await invoke({
      bundle: bundle("return { env: ctx.env, frozen: Object.isFrozen(ctx.env) };"),
    });

    expect(value).toEqual({ env: {}, frozen: true });
  });

  it("sends ctx.log lines with the requested level", async () => {
    const { transport, logs } = journal();

    await runInvocation({
      transport,
      invocationId: "inv_log",
      subjectActorId: "a_test",
      bundle: bundle(`
        ctx.log("note", "debug");
        ctx.log("plain");
        ctx.log({ toString() { throw new Error("no"); } });
        return null;
      `),
      entry: "handler",
      input: undefined,
    });

    expect(logs).toEqual([
      { level: "debug", message: "note" },
      { level: "info", message: "plain" },
      { level: "info", message: "[unprintable]" },
    ]);
  });

  it("captures console output as log frames and restores the console", async () => {
    const original = console.log;
    const { transport, logs } = journal();

    await runInvocation({
      transport,
      invocationId: "inv_console",
      subjectActorId: "a_test",
      bundle: bundle(`
        console.log("hello", 42);
        console.info("note");
        console.warn("careful");
        console.error(new Error("boom"));
        console.debug({ a: 1 });
        return null;
      `),
      entry: "handler",
      input: undefined,
    });

    expect(logs).toEqual([
      { level: "log", message: "hello 42" },
      { level: "info", message: "note" },
      { level: "warn", message: "careful" },
      { level: "error", message: "Error: boom" },
      { level: "debug", message: '{"a":1}' },
    ]);
    expect(console.log).toBe(original);
  });

  it("restores the console when the handler throws", async () => {
    const original = console.log;

    await expect(
      invoke({ bundle: bundle('console.log("x"); throw new Error("handler exploded");') }),
    ).rejects.toThrow("handler exploded");

    expect(console.log).toBe(original);
  });

  it("drops log lines past max_log_lines after one notice", async () => {
    const { transport, logs } = journal();

    await runInvocation({
      transport,
      invocationId: "inv_log_lines",
      subjectActorId: "a_test",
      bundle: bundle(`
        for (let i = 0; i < 5; i++) console.log("line " + i);
        return null;
      `),
      entry: "handler",
      input: undefined,
      limits: { max_log_lines: 2 },
    });

    expect(logs.map((entry) => entry.message)).toEqual(["line 0", "line 1", LOG_TRUNCATION_NOTICE]);
  });

  it("drops log lines past max_log_bytes after one notice", async () => {
    const { transport, logs } = journal();

    await runInvocation({
      transport,
      invocationId: "inv_log_bytes",
      subjectActorId: "a_test",
      bundle: bundle('console.log("12345"); console.log("67890"); return null;'),
      entry: "handler",
      input: undefined,
      limits: { max_log_bytes: 6 },
    });

    expect(logs.map((entry) => entry.message)).toEqual(["12345", LOG_TRUNCATION_NOTICE]);
  });

  it("never fails an invocation whose transport throws on a log line", async () => {
    const transport: RunnerTransport = {
      async call() {
        return null;
      },
      log() {
        throw new Error("socket gone");
      },
    };

    const value = await runInvocation({
      transport,
      invocationId: "inv_log_throws",
      subjectActorId: "a_test",
      bundle: bundle('ctx.log("hi"); console.log("hi"); return { ok: true };'),
      entry: "handler",
      input: undefined,
    });

    expect(value).toEqual({ ok: true });
  });

  it("refuses host calls past max_host_calls without sending a frame", async () => {
    const { transport, calls } = journal();

    const value = await runInvocation({
      transport,
      invocationId: "inv_budget",
      subjectActorId: "a_test",
      bundle: bundle(`
        let reached = 0;
        try {
          for (let i = 0; i < 5; i++) { await ctx.get("e_" + i); reached++; }
          return { reached };
        } catch (error) {
          return { reached, error: error.name, limit: error.limit };
        }
      `),
      entry: "handler",
      input: undefined,
      limits: { max_host_calls: 2 },
    });

    expect(value).toEqual({ reached: 2, error: "HostCallLimitError", limit: 2 });
    expect(calls.filter((call) => call.op === "get")).toHaveLength(2);
  });

  it("installs the fetch shim for the invocation and restores it after", async () => {
    const { transport, audits } = journal();
    const original = globalThis.fetch;
    const stub = vi.fn(async () => new Response("hi", { status: 200 }));
    globalThis.fetch = stub as unknown as typeof globalThis.fetch;

    try {
      const value = await runInvocation({
        transport,
        invocationId: "inv_fetch",
        subjectActorId: "a_test",
        bundle: bundle(`
          const allowed = await fetch("https://api.example.com/x");
          const body = await allowed.text();
          let blocked = null;
          try { await fetch("https://evil.example/x"); } catch (error) { blocked = error.name; }
          return { body, blocked };
        `),
        entry: "handler",
        input: undefined,
        limits: { fetch_allowlist: ["api.example.com"] },
      });

      expect(value).toEqual({ body: "hi", blocked: "FetchBlockedError" });
      expect(stub).toHaveBeenCalledOnce();
      expect(globalThis.fetch).toBe(stub);
      expect(audits).toHaveLength(2);
      expect(audits[0]).toMatchObject({
        method: "GET",
        url: "https://api.example.com/x",
        status: 200,
        blocked: false,
      });
      expect(audits[1]).toMatchObject({
        url: "https://evil.example/x",
        status: null,
        blocked: true,
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("restores fetch when the handler throws", async () => {
    const original = globalThis.fetch;
    const stub = vi.fn();
    globalThis.fetch = stub as unknown as typeof globalThis.fetch;

    try {
      await expect(
        invoke({ bundle: bundle('throw new Error("after fetch shim");') }),
      ).rejects.toThrow("after fetch shim");
      expect(globalThis.fetch).toBe(stub);
    } finally {
      globalThis.fetch = original;
    }
  });
});
