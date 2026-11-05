import { describe, expect, it } from "vitest";

import { MAX_FRAME_BYTES } from "@ebbjs/functions-protocol";
import type { LogEntry } from "@ebbjs/functions-runtime";

import { HostCallLimitError, resolveLimits } from "./limits.ts";
import { guardTransport, type HostTransport, type RunnerTransport } from "./transport.ts";

describe("resolveLimits", () => {
  it("uses the documented defaults when the host states nothing", () => {
    const limits = resolveLimits(undefined);

    expect(limits).toEqual({
      timeoutMs: 30_000,
      maxHostCalls: 1_000,
      maxOutputBytes: MAX_FRAME_BYTES,
      maxLogLines: 200,
      maxLogBytes: 65_536,
      fetchAllowlist: [],
    });
    expect(resolveLimits({})).toEqual(limits);
  });

  it("takes the host's values", () => {
    const limits = resolveLimits({
      timeout_ms: 1_500,
      max_host_calls: 5,
      max_output_bytes: 4_096,
      max_log_lines: 3,
      max_log_bytes: 512,
      fetch_allowlist: ["api.example.com", 7 as never, ""],
      memory_bytes: 1,
    });

    expect(limits).toEqual({
      timeoutMs: 1_500,
      maxHostCalls: 5,
      maxOutputBytes: 4_096,
      maxLogLines: 3,
      maxLogBytes: 512,
      fetchAllowlist: ["api.example.com"],
    });
  });

  it("ignores values that are not positive integers", () => {
    const limits = resolveLimits({
      timeout_ms: 0,
      max_host_calls: -1,
      max_log_lines: 1.5,
      max_log_bytes: "1024" as never,
    });

    expect(limits.timeoutMs).toBe(30_000);
    expect(limits.maxHostCalls).toBe(1_000);
    expect(limits.maxLogLines).toBe(200);
    expect(limits.maxLogBytes).toBe(65_536);
  });

  it("clamps the output bound to the frame bound", () => {
    expect(resolveLimits({ max_output_bytes: MAX_FRAME_BYTES * 2 }).maxOutputBytes).toBe(
      MAX_FRAME_BYTES,
    );
  });

  it("treats a non-array allowlist as unrestricted", () => {
    expect(resolveLimits({ fetch_allowlist: "api.example.com" as never }).fetchAllowlist).toEqual(
      [],
    );
  });
});

describe("HostCallLimitError", () => {
  it("names the budget it enforced", () => {
    const error = new HostCallLimitError(3);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("HostCallLimitError");
    expect(error.limit).toBe(3);
    expect(error.message).toContain("3");
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
    const logs: LogEntry[] = [];
    const guarded = guardTransport({
      transport,
      maxHostCalls: 2,
      log: (entry) => logs.push(entry),
    });

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

  it("is a HostTransport", () => {
    const guarded: HostTransport = guardTransport({
      transport: counting().transport,
      maxHostCalls: 1,
      log: () => undefined,
    });

    expect(typeof guarded.call).toBe("function");
  });
});
