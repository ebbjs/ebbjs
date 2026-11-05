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
  readonly timeout_ms?: number;
  readonly max_host_calls?: number;
  readonly max_output_bytes?: number;
  readonly max_log_lines?: number;
  readonly max_log_bytes?: number;
  readonly fetch_allowlist?: readonly string[];
  readonly memory_bytes?: number;
  readonly [field: string]: unknown;
}

/** Host → runner: run one function. Omitted fields stay omitted. */
export interface InvokeFrame {
  readonly type: "invoke";
  readonly invocation_id?: string;
  readonly name?: string;
  readonly version?: string;
  readonly digest?: string;
  readonly bundle?: string;
  readonly entry?: string;
  readonly input?: unknown;
  readonly subject_actor_id?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly limits?: FunctionLimits;
  readonly [field: string]: unknown;
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

/** Runner → host: the invocation failed with a kind and a message. */
export interface ResultErrorFrame {
  readonly type: "result";
  readonly ok: false;
  readonly kind: string;
  readonly message: string;
  readonly [field: string]: unknown;
}

/** Runner → host: how the invocation ended. `ok` splits the two shapes. */
export type ResultFrame = ResultOkFrame | ResultErrorFrame;

/** The levels a `log` frame carries. `log` is `console.log`'s level. */
export type LogLevel = "debug" | "info" | "log" | "warn" | "error";

/** Runner → host: one log line from the invocation. Fire-and-forget. */
export interface LogFrame {
  readonly type: "log";
  readonly level: LogLevel;
  readonly message: string;
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
