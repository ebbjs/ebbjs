/**
 * The frame shapes shared by the host and the function runner.
 *
 * A frame is a JSON object with a string `type`. The shapes below are the
 * frames this protocol version defines. Anything a peer sends under another
 * `type` still decodes, as `UnrecognizedFrame`, so a newer peer's frames
 * survive a round trip instead of being rejected.
 *
 * Every shape is open: fields the codec does not know about are kept, matching
 * the Elixir side, which hands the worker the whole decoded map.
 */

import type { CallerKind } from "@ebbjs/write";

/** Largest JSON payload one frame may carry. */
export const MAX_FRAME_BYTES = 1_048_576;

/** The protocol version a worker reports in `ready`. */
export const PROTOCOL_VERSION = 1;

/**
 * Whether `version` is the protocol version this codec speaks.
 *
 * A mismatch is a compatibility failure, not a per-request error: the host
 * disables functions at boot rather than answering requests it cannot frame.
 */
export function compatibleVersion(version: unknown): boolean {
  return version === PROTOCOL_VERSION;
}

/** The host operation a `call` asks for. */
export type FrameOp = "get" | "commit";

/** Invocation limits the host hands the worker, mirroring the envelope. */
export interface FunctionLimits {
  /**
   * The host's wall-clock deadline. Declared so the frame documents it; the
   * runner does not enforce it, because the host owns the process group.
   */
  readonly timeout_ms?: number;
  readonly max_host_calls?: number;
  readonly max_output_bytes?: number;
  readonly max_log_lines?: number;
  readonly max_log_bytes?: number;
  readonly fetch_allowlist?: readonly string[];
  readonly max_fetch_response_bytes?: number;
  readonly [field: string]: unknown;
}

/**
 * The budget per field when the host states none.
 *
 * Both sides read this table rather than restating the numbers: the server
 * hands the values it resolves in its `invoke` frame, and the runner falls back
 * to them for any field the host omitted. A default that changes here changes
 * for both peers, which is the point.
 */
export const DEFAULT_LIMITS = {
  timeout_ms: 30_000,
  max_host_calls: 1_000,
  max_log_lines: 200,
  max_log_bytes: 65_536,
  max_fetch_response_bytes: 10 * 1024 * 1024,
} as const satisfies FunctionLimits;

/**
 * An invoke's fields, without the frame's `type`: what a caller may pass.
 *
 * The frame's open `[field: string]` index signature makes `keyof InvokeFrame`
 * `string | number`, so `Omit<InvokeFrame, "type">` would collapse to the index
 * signature and lose these names. The fields are therefore the base shape and
 * the frame is what adds the type.
 */
export interface InvokeFields {
  readonly invocation_id?: string;
  readonly name?: string;
  /**
   * The stored version's name and code digest. The host verified the digest at
   * upload (`bundle.ex`'s `verify_digest`) and evaluates the stored bundle
   * without re-checking it, so these identify the code rather than guard it.
   */
  readonly version?: string;
  readonly digest?: string;
  readonly bundle?: string;
  readonly entry?: string;
  readonly input?: unknown;
  readonly subject_actor_id?: string;
  /** Who invoked the function: an actor's own call, or a service for it. */
  readonly caller_kind?: CallerKind;
  readonly env?: Readonly<Record<string, string>>;
  readonly limits?: FunctionLimits;
  readonly [field: string]: unknown;
}

/** Host → runner: run one function. Omitted fields stay omitted. */
export interface InvokeFrame extends InvokeFields {
  readonly type: "invoke";
}

/** Host → runner: the answer to one host call, successful. */
export interface ReplyOkFrame {
  readonly type: "reply";
  readonly call_id: string;
  readonly ok: true;
  readonly value: unknown;
  readonly [field: string]: unknown;
}

/** Host → runner: the answer to one host call, refused. */
export interface ReplyErrorFrame {
  readonly type: "reply";
  readonly call_id: string;
  readonly ok: false;
  readonly error: unknown;
  readonly [field: string]: unknown;
}

/** Host → runner: the answer to one host call. `ok` splits the two shapes. */
export type ReplyFrame = ReplyOkFrame | ReplyErrorFrame;

/** Runner → host: one host call, answered later by `call_id`. */
export interface CallFrame {
  readonly type: "call";
  readonly call_id: string;
  readonly op: FrameOp;
  readonly payload: unknown;
  readonly [field: string]: unknown;
}

/** Runner → host: the invocation's value. */
export interface ResultOkFrame {
  readonly type: "result";
  readonly ok: true;
  readonly value: unknown;
  readonly [field: string]: unknown;
}

/**
 * The result kinds the host's error taxonomy maps to a status.
 *
 * These are the kinds both peers know by name; the constants fixture pins the
 * set. A frame carrying an undeclared kind still decodes and the host maps it
 * to a runner error rather than a decode failure.
 */
export const RESULT_KIND_HANDLER_ERROR = "handler_error";
export const RESULT_KIND_HOST_CALL_LIMIT = "host_call_limit";
export const RESULT_KIND_OUTPUT_TOO_LARGE = "output_too_large";

/** Every result kind the host knows by name. */
export const RESULT_KINDS = [
  RESULT_KIND_HANDLER_ERROR,
  RESULT_KIND_HOST_CALL_LIMIT,
  RESULT_KIND_OUTPUT_TOO_LARGE,
] as const;

/** A result kind the host knows by name. */
export type ResultKind = (typeof RESULT_KINDS)[number];

/** Runner → host: the invocation failed with a kind and a message. */
export interface ResultErrorFrame {
  readonly type: "result";
  readonly ok: false;
  readonly kind: ResultKind;
  readonly message: string;
  readonly [field: string]: unknown;
}

/** Runner → host: how the invocation ended. `ok` splits the two shapes. */
export type ResultFrame = ResultOkFrame | ResultErrorFrame;

/**
 * The levels a `log` frame carries. `log` is `console.log`'s level.
 *
 * The host also accepts `warning`, Logger's spelling of `warn`, which no
 * TypeScript peer emits; `fixtures/functions/frames/constants.json` records the
 * union both sides agree on.
 */
export const LOG_LEVELS = ["debug", "info", "log", "warn", "error"] as const;

/** A level a `log` frame carries. */
export type LogLevel = (typeof LOG_LEVELS)[number];

const LOG_LEVEL_SET: ReadonlySet<string> = new Set(LOG_LEVELS);

/**
 * Whether `value` is one of the levels this peer emits.
 *
 * The host also accepts `warning`; a handler's level is checked against what
 * this side has a name for, so `warning` falls back to `info` here.
 */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && LOG_LEVEL_SET.has(value);
}

/** A log frame's fields, without the frame's `type`; see {@link InvokeFields}. */
export interface LogFields {
  readonly level: LogLevel;
  readonly message: string;
}

/** Runner → host: one log line from the invocation. Fire-and-forget. */
export interface LogFrame extends LogFields {
  readonly type: "log";
  readonly [field: string]: unknown;
}

/**
 * Runner → host: egress telemetry for one `fetch`.
 *
 * Headers and bodies never cross the boundary. The URL is the URL the handler
 * asked for; redacting it is the host's job. `blocked` means the shim refused
 * the request before it was sent, which is also why `status` is `null` there.
 */
export interface FetchAuditFrame {
  readonly type: "fetch_audit";
  readonly method: string;
  readonly url: string;
  readonly status: number | null;
  readonly duration_ms: number;
  readonly blocked: boolean;
  readonly [field: string]: unknown;
}

/** Runner → host: the worker is up and speaks `protocol_version`. */
export interface ReadyFrame {
  readonly type: "ready";
  readonly pid: number;
  readonly runner_version: string;
  readonly protocol_version: number;
  readonly [field: string]: unknown;
}

/** A frame whose `type` this version does not define. Its fields are intact. */
export interface UnrecognizedFrame {
  readonly type: string;
  readonly [field: string]: unknown;
}

/** Every frame the codec accepts: a JSON object with a string `type`. */
export type Frame =
  | InvokeFrame
  | ReplyFrame
  | CallFrame
  | ResultFrame
  | ReadyFrame
  | LogFrame
  | FetchAuditFrame
  | UnrecognizedFrame;

/** The frames the host sends to a runner. */
export type HostToRunnerFrame = InvokeFrame | ReplyFrame;

/** The frames a runner sends to the host. */
export type RunnerToHostFrame = ReadyFrame | CallFrame | ResultFrame | LogFrame | FetchAuditFrame;
