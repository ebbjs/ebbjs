/**
 * The invocation's resource budget, as the host states it in the invoke frame.
 *
 * Every field is optional on the wire and every default is the protocol's
 * `DEFAULT_LIMITS`, so a host that states nothing gets the same budget as one
 * that states the defaults. The host owns the process group: `timeout_ms` and
 * `memory_bytes` are carried for completeness but the runner does not enforce
 * them — it cannot preempt a synchronous handler, and the host kills the group
 * at the deadline. What the runner does enforce locally is the host-call
 * budget, the log budget, the output frame bound, and the fetch response cap.
 */

import { DEFAULT_LIMITS, MAX_FRAME_BYTES, type FunctionLimits } from "@ebbjs/functions-protocol";

/** The budget the runner itself enforces for one invocation. */
export interface InvocationLimits {
  readonly timeoutMs: number;
  readonly maxHostCalls: number;
  /** The result frame bound: `max_output_bytes`, clamped to the frame bound. */
  readonly maxOutputBytes: number;
  readonly maxLogLines: number;
  readonly maxLogBytes: number;
  /**
   * The allowlist exactly as the host stated it, or `undefined` when it stated
   * none: the fetch shim validates it and fails the invocation on anything it
   * cannot read. Nothing is filtered here, because a shorter list is wider
   * egress.
   */
  readonly fetchAllowlist: unknown;
  /** The cap on one fetch response body. */
  readonly maxFetchResponseBytes: number;
}

/** Resolves an optional wire `limits` object into the runner's budget. */
export function resolveLimits(limits: FunctionLimits | undefined): InvocationLimits {
  return {
    timeoutMs: positive(limits?.timeout_ms) ?? DEFAULT_LIMITS.timeout_ms,
    maxHostCalls: positive(limits?.max_host_calls) ?? DEFAULT_LIMITS.max_host_calls,
    // A host cannot raise the result bound past what the codec can decode, and
    // a larger frame would be refused by the host from its length prefix.
    maxOutputBytes: Math.min(
      positive(limits?.max_output_bytes) ?? MAX_FRAME_BYTES,
      MAX_FRAME_BYTES,
    ),
    maxLogLines: positive(limits?.max_log_lines) ?? DEFAULT_LIMITS.max_log_lines,
    maxLogBytes: positive(limits?.max_log_bytes) ?? DEFAULT_LIMITS.max_log_bytes,
    fetchAllowlist: limits?.fetch_allowlist,
    maxFetchResponseBytes:
      positive(limits?.max_fetch_response_bytes) ?? DEFAULT_LIMITS.max_fetch_response_bytes,
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
