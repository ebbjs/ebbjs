import { describe, expect, it } from "vitest";

import { MAX_FRAME_BYTES, reply, type Frame } from "@ebbjs/functions-protocol";
import type { LogEntry } from "@ebbjs/functions-runtime";

import { evaluateBundle } from "./index.ts";
import { HostCallLimitError } from "./limits.ts";
import {
  FrameTooLargeError,
  guardTransport,
  SocketHostTransport,
  type RunnerTransport,
} from "./transport.ts";

const view = { id: "e_doc" };

function transport() {
  const sent: Frame[] = [];
  const host = new SocketHostTransport({ send: (frame) => sent.push(frame) });
  return { host, sent };
}

describe("SocketHostTransport", () => {
  it("allocates call ids and resolves replies in any order", async () => {
    const { host, sent } = transport();

    const slow = host.call("get", { id: "e_slow" });
    const fast = host.call("get", { id: "e_fast" });

    expect(sent).toEqual([
      { type: "call", call_id: "1", op: "get", payload: { id: "e_slow" } },
      { type: "call", call_id: "2", op: "get", payload: { id: "e_fast" } },
    ]);

    host.handleReply(reply("2", { ok: true, value: { ...view, id: "e_fast" } }));
    host.handleReply(reply("1", { ok: true, value: { ...view, id: "e_slow" } }));

    await expect(fast).resolves.toMatchObject({ id: "e_fast" });
    await expect(slow).resolves.toMatchObject({ id: "e_slow" });
  });

  it("rejects a refused call with the host error", async () => {
    const { host } = transport();
    const call = host.call("get", { id: "e_doc" });

    host.handleReply(reply("1", { ok: false, error: { error: "read_failed", status: 500 } }));

    await expect(call).rejects.toEqual({ error: "read_failed", status: 500 });
  });

  it("refuses a call whose encoded frame would exceed the protocol bound", async () => {
    const { host, sent } = transport();

    await expect(host.call("commit", { blob: "x".repeat(MAX_FRAME_BYTES) })).rejects.toBeInstanceOf(
      FrameTooLargeError,
    );
    expect(sent).toEqual([]);
  });

  it("ignores a reply for an unknown call id and rejects on close", async () => {
    const { host } = transport();
    const call = host.call("get", { id: "e_doc" });

    host.handleReply(reply("99", { ok: true, value: view }));
    host.close();

    await expect(call).rejects.toThrow("runner finished");
    await expect(host.call("get", { id: "e_doc" })).rejects.toThrow("host socket is closed");
  });
});

describe("evaluateBundle", () => {
  it("returns the IIFE's exported bindings", () => {
    const module = evaluateBundle(`
      var __ebbFunction = (() => {
        return { echo: (ctx, params) => ({ params, actor: ctx.actor.id }) };
      })();
    `);

    const echo = module.echo as (ctx: unknown, params: unknown) => unknown;

    expect(echo({ actor: { id: "a_test" } }, { n: 1 })).toEqual({
      params: { n: 1 },
      actor: "a_test",
    });
  });

  it("returns an empty module when the bundle exports nothing", () => {
    expect(evaluateBundle("var unrelated = 1;")).toEqual({});
  });
});

describe("guardTransport", () => {
  const counting = () => {
    const calls: string[] = [];
    const transport: RunnerTransport = {
      call: (op) => {
        calls.push(op);
        return Promise.resolve(null);
      },
    };
    return { transport, calls };
  };

  it("passes calls through under the budget", async () => {
    const { transport, calls } = counting();
    const guarded = guardTransport({ transport, maxHostCalls: 2, log: () => undefined });

    await guarded.call("get", { id: "e_1" });
    await guarded.call("commit", {});

    expect(calls).toEqual(["get", "commit"]);
  });

  it("refuses past the budget without sending a frame", async () => {
    const { transport, calls } = counting();
    const guarded = guardTransport({ transport, maxHostCalls: 1, log: () => undefined });

    await guarded.call("get", { id: "e_1" });
    await expect(guarded.call("get", { id: "e_2" })).rejects.toBeInstanceOf(HostCallLimitError);
    expect(calls).toEqual(["get"]);
  });

  it("routes log entries to the invocation's sink", () => {
    const logs: LogEntry[] = [];
    const guarded = guardTransport({
      transport: counting().transport,
      maxHostCalls: 1,
      log: (entry) => logs.push(entry),
    });

    guarded.log?.({ level: "warn", message: "hi" });

    expect(logs).toEqual([{ level: "warn", message: "hi" }]);
  });
});
