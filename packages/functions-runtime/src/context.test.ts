import { describe, expect, it } from "vitest";

import { createContext, type HostTransport, type HostOp } from "./index.ts";

interface Call {
  op: HostOp;
  payload: unknown;
}

function fakeTransport(
  handler: (call: Call) => Promise<unknown>,
): HostTransport & { calls: Call[] } {
  const calls: Call[] = [];

  return {
    calls,
    call(op, payload) {
      calls.push({ op, payload });
      return handler({ op, payload });
    },
  };
}

const view = {
  id: "e_doc",
  type: "doc",
  data: { fields: { title: { type: "lww", value: "hello", hlc: "1" } } },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 1,
};

describe("createContext", () => {
  it("exposes the invocation identity and a frozen actor", () => {
    const ctx = createContext({
      transport: fakeTransport(async () => null),
      invocationId: "inv_1",
      actor: { id: "a_test" },
      caller: { kind: "actor", id: "a_test" },
    });

    expect(ctx.invocationId).toBe("inv_1");
    expect(ctx.actor.id).toBe("a_test");
    expect(ctx.caller).toEqual({ kind: "actor", id: "a_test" });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.actor)).toBe(true);
  });

  it("reads one entity through the host transport", async () => {
    const transport = fakeTransport(async () => view);
    const ctx = createContext({
      transport,
      invocationId: "inv_1",
      actor: { id: "a_test" },
      caller: { kind: "actor", id: "a_test" },
    });

    await expect(ctx.get("e_doc")).resolves.toEqual(view);
    expect(transport.calls).toEqual([{ op: "get", payload: { id: "e_doc" } }]);
  });

  it("returns null when the host reports absence or denial", async () => {
    const ctx = createContext({
      transport: fakeTransport(async () => null),
      invocationId: "inv_1",
      actor: { id: "a_test" },
      caller: { kind: "actor", id: "a_test" },
    });

    await expect(ctx.get("e_missing")).resolves.toBeNull();
  });

  it("keeps concurrent reads independent and does not assume reply order", async () => {
    const transport = fakeTransport(async ({ payload }) => {
      const id = (payload as { id: string }).id;
      if (id === "e_slow") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ...view, id: "e_slow" };
      }
      return { ...view, id: "e_fast" };
    });

    const ctx = createContext({
      transport,
      invocationId: "inv_1",
      actor: { id: "a_test" },
      caller: { kind: "service", id: "svc_1" },
    });

    const slow = ctx.get("e_slow");
    const fast = ctx.get("e_fast");

    await expect(fast).resolves.toMatchObject({ id: "e_fast" });
    await expect(slow).resolves.toMatchObject({ id: "e_slow" });
    expect(transport.calls).toEqual([
      { op: "get", payload: { id: "e_slow" } },
      { op: "get", payload: { id: "e_fast" } },
    ]);
  });

  it("propagates a refused read", async () => {
    const ctx = createContext({
      transport: fakeTransport(async () => {
        throw new Error("read_failed");
      }),
      invocationId: "inv_1",
      actor: { id: "a_test" },
      caller: { kind: "actor", id: "a_test" },
    });

    await expect(ctx.get("e_doc")).rejects.toThrow("read_failed");
  });

  it("refuses an empty entity id without calling the host", async () => {
    const transport = fakeTransport(async () => view);
    const ctx = createContext({
      transport,
      invocationId: "inv_1",
      actor: { id: "a_test" },
      caller: { kind: "actor", id: "a_test" },
    });

    await expect(ctx.get("")).rejects.toThrow(TypeError);
    expect(transport.calls).toEqual([]);
  });
});

describe("context env and logging", () => {
  const withLog = () => {
    const entries: { level: string; message: string }[] = [];
    const transport: HostTransport = {
      call: async () => null,
      log: (entry) => entries.push(entry),
    };
    return { transport, entries };
  };

  it("exposes env as a frozen copy of the option", () => {
    const env = { API_TOKEN: "shh" };
    const ctx = createContext({
      transport: fakeTransport(async () => null),
      invocationId: "inv_env",
      actor: { id: "a_test" },
      caller: { kind: "actor", id: "a_test" },
      env,
    });

    expect(ctx.env).toEqual({ API_TOKEN: "shh" });
    expect(Object.isFrozen(ctx.env)).toBe(true);
    expect(ctx.env).not.toBe(env);
  });

  it("defaults env to an empty frozen record", () => {
    const ctx = createContext({
      transport: fakeTransport(async () => null),
      invocationId: "inv_env",
      actor: { id: "a_test" },
      caller: { kind: "actor", id: "a_test" },
    });

    expect(ctx.env).toEqual({});
    expect(Object.isFrozen(ctx.env)).toBe(true);
  });

  it("sends ctx.log to the transport, defaulting to info", () => {
    const { transport, entries } = withLog();
    const ctx = createContext({
      transport,
      invocationId: "inv_log",
      actor: { id: "a_test" },
      caller: { kind: "actor", id: "a_test" },
    });

    ctx.log("note");
    ctx.log("careful", "warn");

    expect(entries).toEqual([
      { level: "info", message: "note" },
      { level: "warn", message: "careful" },
    ]);
  });

  it("drops a log line when the transport cannot carry one", () => {
    const ctx = createContext({
      transport: fakeTransport(async () => null),
      invocationId: "inv_log",
      actor: { id: "a_test" },
      caller: { kind: "actor", id: "a_test" },
    });

    expect(() => ctx.log("hello")).not.toThrow();
  });

  it("never fails on a throwing transport or an unserializable message", () => {
    const transport: HostTransport = {
      call: async () => null,
      log: () => {
        throw new Error("socket gone");
      },
    };
    const ctx = createContext({
      transport,
      invocationId: "inv_log",
      actor: { id: "a_test" },
      caller: { kind: "actor", id: "a_test" },
    });

    expect(() => ctx.log("hello")).not.toThrow();
    expect(() => ctx.log({ toString: undefined } as never)).not.toThrow();
  });

  it("falls back to info for a level the wire does not define", () => {
    const { transport, entries } = withLog();
    const ctx = createContext({
      transport,
      invocationId: "inv_log",
      actor: { id: "a_test" },
      caller: { kind: "actor", id: "a_test" },
    });

    ctx.log("hello", "verbose" as never);

    expect(entries).toEqual([{ level: "info", message: "hello" }]);
  });
});
