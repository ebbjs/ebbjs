import { describe, expect, it } from "vitest";

import { MAX_FRAME_BYTES } from "@ebbjs/functions-protocol";

import { HostCallLimitError, resolveLimits } from "./limits.ts";

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
