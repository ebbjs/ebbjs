import { describe, expect, it } from "vitest";

import { DEFAULT_LIMITS, MAX_FRAME_BYTES } from "@ebbjs/functions-protocol";

import { HostCallLimitError, resolveLimits } from "./limits.ts";

describe("resolveLimits", () => {
  it("uses the protocol's documented defaults when the host states nothing", () => {
    const limits = resolveLimits(undefined);

    expect(limits).toEqual({
      timeoutMs: DEFAULT_LIMITS.timeout_ms,
      maxHostCalls: DEFAULT_LIMITS.max_host_calls,
      maxOutputBytes: MAX_FRAME_BYTES,
      maxLogLines: DEFAULT_LIMITS.max_log_lines,
      maxLogBytes: DEFAULT_LIMITS.max_log_bytes,
      fetchAllowlist: undefined,
      maxFetchResponseBytes: DEFAULT_LIMITS.max_fetch_response_bytes,
    });
    expect(resolveLimits({})).toEqual(limits);
  });

  it("keeps the documented default values", () => {
    // The table is shared with the server; these are the numbers it ships.
    expect(DEFAULT_LIMITS).toEqual({
      timeout_ms: 30_000,
      max_host_calls: 1_000,
      max_log_lines: 200,
      max_log_bytes: 65_536,
      max_fetch_response_bytes: 10 * 1024 * 1024,
    });
  });

  it("takes the host's values", () => {
    const limits = resolveLimits({
      timeout_ms: 1_500,
      max_host_calls: 5,
      max_output_bytes: 4_096,
      max_log_lines: 3,
      max_log_bytes: 512,
      fetch_allowlist: ["api.example.com"],
      max_fetch_response_bytes: 2_048,
      memory_bytes: 1,
    });

    expect(limits).toEqual({
      timeoutMs: 1_500,
      maxHostCalls: 5,
      maxOutputBytes: 4_096,
      maxLogLines: 3,
      maxLogBytes: 512,
      fetchAllowlist: ["api.example.com"],
      maxFetchResponseBytes: 2_048,
    });
  });

  it("ignores values that are not positive integers", () => {
    const limits = resolveLimits({
      timeout_ms: 0,
      max_host_calls: -1,
      max_log_lines: 1.5,
      max_log_bytes: "1024" as never,
      max_fetch_response_bytes: 0,
    });

    expect(limits.timeoutMs).toBe(30_000);
    expect(limits.maxHostCalls).toBe(1_000);
    expect(limits.maxLogLines).toBe(200);
    expect(limits.maxLogBytes).toBe(65_536);
    expect(limits.maxFetchResponseBytes).toBe(10 * 1024 * 1024);
  });

  it("clamps the output bound to the frame bound", () => {
    expect(resolveLimits({ max_output_bytes: MAX_FRAME_BYTES * 2 }).maxOutputBytes).toBe(
      MAX_FRAME_BYTES,
    );
  });

  it("hands the allowlist on untouched so the shim can refuse what it cannot read", () => {
    // Filtering here would narrow the list, and a narrowed list is wider egress.
    expect(
      resolveLimits({ fetch_allowlist: ["api.example.com", ""] as never }).fetchAllowlist,
    ).toEqual(["api.example.com", ""]);
    expect(resolveLimits({ fetch_allowlist: "api.example.com" as never }).fetchAllowlist).toBe(
      "api.example.com",
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
