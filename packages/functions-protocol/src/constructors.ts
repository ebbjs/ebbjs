/**
 * Constructors for the frames each side sends.
 *
 * The wire shape has one definition, here, so no call site assembles a frame by
 * hand. Fields a caller omits are omitted rather than encoded as `undefined`,
 * matching how the Elixir side drops the keys it is not given.
 */

import {
  type CallFrame,
  type FetchAuditFrame,
  type FrameOp,
  type InvokeFrame,
  type LogFrame,
  type LogLevel,
  PROTOCOL_VERSION,
  type ReadyFrame,
  type ReplyFrame,
  type ResultFrame,
} from "./frames.ts";

/** The invoke fields this version names. Extra fields pass through untouched. */
export interface InvokeFields {
  readonly invocation_id?: string;
  readonly name?: string;
  readonly version?: string;
  readonly digest?: string;
  readonly bundle?: string;
  readonly entry?: string;
  readonly input?: unknown;
  readonly subject_actor_id?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly limits?: Readonly<Record<string, unknown>>;
  readonly [field: string]: unknown;
}

/** The fields a `fetch_audit` frame reports, all measured by the shim. */
export interface FetchAuditFields {
  readonly method: string;
  readonly url: string;
  readonly status: number | null;
  readonly duration_ms: number;
  readonly blocked: boolean;
}

/** The two outcomes a `reply` can carry. */
export type ReplyOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

/** The two outcomes a `result` can carry. */
export type ResultOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly kind: string; readonly message: string };

/** The frame's own fields, with the omitted ones left out. */
function definedFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const defined: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(fields)) {
    if (field !== "type" && value !== undefined) defined[field] = value;
  }

  return defined;
}

/** Builds an `invoke` frame. Fields the caller omits stay omitted. */
export function invoke(fields: InvokeFields = {}): InvokeFrame {
  return { ...definedFields(fields), type: "invoke" };
}

/** Builds a `reply` frame for one host call. */
export function reply(callId: string, outcome: ReplyOutcome): ReplyFrame {
  if (outcome.ok) return { type: "reply", call_id: callId, ok: true, value: outcome.value };

  return { type: "reply", call_id: callId, ok: false, error: outcome.error };
}

/** Builds a `call` frame from a runner to the host. */
export function call(callId: string, op: FrameOp, payload: unknown): CallFrame {
  return { type: "call", call_id: callId, op, payload };
}

/** Builds a `result` frame: either a value or a failure kind and message. */
export function result(outcome: ResultOutcome): ResultFrame {
  if (outcome.ok) return { type: "result", ok: true, value: outcome.value };

  return { type: "result", ok: false, kind: outcome.kind, message: outcome.message };
}

/** Builds a `log` frame: one line at one level, already stringified. */
export function logFrame(level: LogLevel, message: string): LogFrame {
  return { type: "log", level, message };
}

/** Builds a `fetch_audit` frame from what the shim measured. */
export function fetchAudit(fields: FetchAuditFields): FetchAuditFrame {
  return {
    type: "fetch_audit",
    method: fields.method,
    url: fields.url,
    status: fields.status,
    duration_ms: fields.duration_ms,
    blocked: fields.blocked,
  };
}

/** Builds the runner's `ready` frame. */
export function ready(
  pid: number,
  runnerVersion: string,
  protocolVersion: number = PROTOCOL_VERSION,
): ReadyFrame {
  return {
    type: "ready",
    pid,
    runner_version: runnerVersion,
    protocol_version: protocolVersion,
  };
}
