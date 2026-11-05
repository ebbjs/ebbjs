/**
 * The invocation's resource budget, as the host states it in the invoke frame.
 *
 * Every field is optional on the wire and every default is defined here, so a
 * host that states nothing gets the same budget as one that states the
 * defaults. The host owns the process group: `timeout_ms` and `memory_bytes`
 * are carried for completeness but the runner does not enforce them — it
 * cannot preempt a synchronous handler, and the host kills the group at the
 * deadline. What the runner does enforce locally is the host-call budget, the
 * log budget, and the output frame bound.
 */

import { MAX_FRAME_BYTES, type FunctionLimits } from "@ebbjs/functions-protocol";

/** Host calls one invocation may make when the host states no cap. */
export const DEFAULT_MAX_HOST_CALLS = 1_000;

/** Log lines one invocation may emit when the host states no cap. */
export const DEFAULT_MAX_LOG_LINES = 200;

/** Log message bytes one invocation may emit when the host states no cap. */
export const DEFAULT_MAX_LOG_BYTES = 65_536;

/** The host's wall-clock budget, when it states none. The host enforces it. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** The budget the runner itself enforces for one invocation. */
export interface InvocationLimits {
  readonly timeoutMs: number;
  readonly maxHostCalls: number;
  /** The result frame bound: `max_output_bytes`, clamped to the frame bound. */
  readonly maxOutputBytes: number;
  readonly maxLogLines: number;
  readonly maxLogBytes: number;
  /** Empty means unrestricted: the server decides the value. */
  readonly fetchAllowlist: readonly string[];
}

/** Resolves an optional wire `limits` object into the runner's budget. */
export function resolveLimits(limits: FunctionLimits | undefined): InvocationLimits {
  return {
    timeoutMs: positive(limits?.timeout_ms) ?? DEFAULT_TIMEOUT_MS,
    maxHostCalls: positive(limits?.max_host_calls) ?? DEFAULT_MAX_HOST_CALLS,
    // A host cannot raise the result bound past what the codec can decode, and
    // a larger frame would be refused by the host from its length prefix.
    maxOutputBytes: Math.min(
      positive(limits?.max_output_bytes) ?? MAX_FRAME_BYTES,
      MAX_FRAME_BYTES,
    ),
    maxLogLines: positive(limits?.max_log_lines) ?? DEFAULT_MAX_LOG_LINES,
    maxLogBytes: positive(limits?.max_log_bytes) ?? DEFAULT_MAX_LOG_BYTES,
    fetchAllowlist: allowlistOf(limits?.fetch_allowlist),
  };
}

/**
 * A host call refused because the invocation already spent its budget.
 *
 * The refusal is local: no frame is sent and the socket stays open, so the
 * handler can catch it and return a smaller result instead of the process
 * dying mid-invocation.
 */
export class HostCallLimitError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(
      `invocation exceeded its host-call budget of ${limit} calls; ` +
        "settle for fewer reads or fewer writes per invocation",
    );
    this.name = "HostCallLimitError";
    this.limit = limit;
  }
}

/** A positive integer from the wire, or `undefined` for anything else. */
const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/** The allowlist entries that are strings; anything else cannot name a host. */
const allowlistOf = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
};
