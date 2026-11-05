import { describe, expect, it } from "vitest";

import {
  encodeFrame,
  invoke,
  MAX_FRAME_BYTES,
  reply,
  type CallFrame,
  type Frame,
} from "@ebbjs/functions-protocol";

import { runInvocation } from "./index.ts";
import { createSession, type Session } from "./session.ts";
import type { RunInvocationOptions } from "./index.ts";

const bundle = (body: string): string => `
  var __ebbFunction = {
    handler: async (ctx, params) => { ${body} },
  };
`;

interface Harness {
  readonly session: Session;
  readonly frames: Frame[];
  readonly fatal: string[];
}

/**
 * A session wired to a fake socket. A `call` frame is answered on the next
 * microtask, the way a host process would answer it asynchronously.
 */
function harness(
  run: (options: RunInvocationOptions) => Promise<unknown>,
  options: { readonly replyToCalls?: boolean } = {},
): Harness {
  const frames: Frame[] = [];
  const fatal: string[] = [];
  let session: Session;

  const send = (frame: Frame): void => {
    frames.push(frame);
    if (frame.type === "call" && options.replyToCalls !== false) {
      const callId = (frame as CallFrame).call_id;
      queueMicrotask(() => session.receive(encodeFrame(reply(callId, { ok: true, value: null }))));
    }
  };

  session = createSession({
    send,
    onFatal: (message) => fatal.push(message),
    runnerVersion: "test",
    pid: 42,
    run,
  });

  return { session, frames, fatal };
}

const results = (frames: readonly Frame[]): Frame[] =>
  frames.filter((frame) => frame.type === "result");

const calls = (frames: readonly Frame[]): CallFrame[] =>
  frames.filter((frame): frame is CallFrame => frame.type === "call");

describe("createSession", () => {
  it("sends ready once, then reuses the connection for two invocations", async () => {
    const { session, frames, fatal } = harness(runInvocation);
    const spec = {
      subject_actor_id: "a_test",
      bundle: bundle('const view = await ctx.get("e_doc"); return { got: view };'),
      entry: "handler",
    };

    session.opened();
    session.opened();

    session.receive(encodeFrame(invoke({ ...spec, invocation_id: "inv_1" })));
    await session.idle();
    expect(session.inFlight).toBe(false);

    session.receive(encodeFrame(invoke({ ...spec, invocation_id: "inv_2" })));
    await session.idle();

    expect(fatal).toEqual([]);
    expect(frames.filter((frame) => frame.type === "ready")).toHaveLength(1);
    expect(calls(frames).map((frame) => frame.call_id)).toEqual(["1", "1"]);
    expect(results(frames)).toEqual([
      { type: "result", ok: true, value: { got: null } },
      { type: "result", ok: true, value: { got: null } },
    ]);
    expect(session.stopped).toBe(false);
  });

  it("gives each invocation its own transport, so a pending call cannot leak across", async () => {
    const pendings: Promise<unknown>[] = [];
    const first = (options: RunInvocationOptions): Promise<unknown> => {
      pendings.push(options.transport.call("get", { id: "e_1" }));
      return Promise.resolve("first");
    };

    const { session, frames } = harness(first, { replyToCalls: false });
    session.receive(encodeFrame(invoke({ invocation_id: "inv_1" })));
    await session.idle();

    await expect(pendings[0]).rejects.toThrow("runner finished");

    // The second invocation gets a fresh pending map and a fresh call-id run.
    session.receive(encodeFrame(invoke({ invocation_id: "inv_2" })));
    await session.idle();

    await expect(pendings[1]).rejects.toThrow("runner finished");
    expect(calls(frames).map((frame) => frame.call_id)).toEqual(["1", "1"]);
  });

  it("hands the invoke's env and limits to the invocation", async () => {
    const seen: RunInvocationOptions[] = [];
    const run = (options: RunInvocationOptions): Promise<unknown> => {
      seen.push(options);
      return Promise.resolve(null);
    };

    const { session } = harness(run);
    session.receive(
      encodeFrame(
        invoke({
          invocation_id: "inv_1",
          env: { API_TOKEN: "shh" },
          limits: { max_host_calls: 3, fetch_allowlist: ["api.example.com"] },
        }),
      ),
    );
    await session.idle();

    expect(seen[0]?.env).toEqual({ API_TOKEN: "shh" });
    expect(seen[0]?.limits).toEqual({
      max_host_calls: 3,
      fetch_allowlist: ["api.example.com"],
    });
  });

  it("ends the process on an invoke while one is in flight", async () => {
    let release: (value: unknown) => void = () => undefined;
    const run = (): Promise<unknown> =>
      new Promise((resolve) => {
        release = resolve;
      });

    const { session, frames, fatal } = harness(run);

    session.receive(encodeFrame(invoke({ invocation_id: "inv_1" })));
    expect(session.inFlight).toBe(true);

    session.receive(encodeFrame(invoke({ invocation_id: "inv_2" })));

    expect(fatal).toEqual(["protocol error: invoke received while an invocation is in flight"]);
    expect(results(frames)).toEqual([
      {
        type: "result",
        ok: false,
        kind: "handler_error",
        message: "protocol error: invoke received while an invocation is in flight",
      },
    ]);

    release("late");
    await session.idle();

    // The abandoned invocation must not send a second result.
    expect(results(frames)).toHaveLength(1);
  });

  it("ends the process on an undecodable frame, without a result when idle", async () => {
    let runs = 0;
    const { session, frames, fatal } = harness(() => {
      runs += 1;
      return Promise.resolve(null);
    });

    session.receive(new Uint8Array([0, 0, 0, 2, 0x7b, 0x7b]));

    expect(fatal).toEqual(["invalid frame from host: invalid_json"]);
    expect(frames).toEqual([]);

    // Nothing after the fatal error is accepted, not even a valid invoke.
    session.receive(encodeFrame(invoke({ invocation_id: "inv_1" })));
    await session.idle();

    expect(runs).toBe(0);
    expect(frames).toEqual([]);
  });

  it("buffers a frame split across reads", async () => {
    const { session, frames } = harness(runInvocation);
    const encoded = encodeFrame(
      invoke({
        invocation_id: "inv_1",
        bundle: bundle("return { ok: true };"),
        entry: "handler",
      }),
    );

    session.receive(encoded.subarray(0, 5));
    expect(frames).toEqual([]);

    session.receive(encoded.subarray(5));
    await session.idle();

    expect(results(frames)).toEqual([{ type: "result", ok: true, value: { ok: true } }]);
  });

  it("reports an oversize result as output_too_large and stays usable", async () => {
    const { session, frames } = harness(() => Promise.resolve("x".repeat(MAX_FRAME_BYTES)));

    session.receive(encodeFrame(invoke({ invocation_id: "inv_1" })));
    await session.idle();

    expect(results(frames)[0]).toMatchObject({ ok: false, kind: "output_too_large" });
    expect(session.stopped).toBe(false);

    session.receive(encodeFrame(invoke({ invocation_id: "inv_2" })));
    await session.idle();

    expect(results(frames)).toHaveLength(2);
  });

  it("honours the invoke's max_output_bytes", async () => {
    const { session, frames } = harness(() => Promise.resolve("x".repeat(200)));

    session.receive(
      encodeFrame(invoke({ invocation_id: "inv_1", limits: { max_output_bytes: 200 } })),
    );
    await session.idle();

    expect(results(frames)[0]).toMatchObject({ ok: false, kind: "output_too_large" });
  });

  it("rejects pending calls and ignores frames once the host closes", async () => {
    let pending: Promise<unknown> | undefined;
    const run = (options: RunInvocationOptions): Promise<unknown> => {
      pending = options.transport.call("get", { id: "e_1" });
      return new Promise(() => undefined);
    };

    const { session, frames } = harness(run);
    session.receive(encodeFrame(invoke({ invocation_id: "inv_1" })));

    session.closed();
    await expect(pending).rejects.toThrow("host closed the connection");

    const before = frames.length;
    session.receive(encodeFrame(invoke({ invocation_id: "inv_2" })));
    expect(frames).toHaveLength(before);
    expect(session.stopped).toBe(true);
  });
});

describe("failure kinds", () => {
  it("reports an uncaught host-call budget refusal as host_call_limit", async () => {
    const { session, frames } = harness(runInvocation);

    session.receive(
      encodeFrame(
        invoke({
          invocation_id: "inv_budget",
          subject_actor_id: "a_test",
          bundle: bundle(`
            for (let i = 0; i < 3; i++) await ctx.get("e_" + i);
            return { reached: 3 };
          `),
          entry: "handler",
          limits: { max_host_calls: 1 },
        }),
      ),
    );
    await session.idle();

    expect(results(frames)[0]).toMatchObject({
      type: "result",
      ok: false,
      kind: "host_call_limit",
    });
  });

  it("keeps handler_error for a handler that throws", async () => {
    const { session, frames } = harness(runInvocation);

    session.receive(
      encodeFrame(
        invoke({
          invocation_id: "inv_throw",
          bundle: bundle('throw new Error("boom");'),
          entry: "handler",
        }),
      ),
    );
    await session.idle();

    expect(results(frames)[0]).toEqual({
      type: "result",
      ok: false,
      kind: "handler_error",
      message: "boom",
    });
  });
});
