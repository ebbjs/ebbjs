import { createContext, type ModelRegistry, type LogEntry } from "@ebbjs/functions-runtime";
import type { FetchAuditFields, FunctionLimits } from "@ebbjs/functions-protocol";
import type { Context } from "@ebbjs/server";

import { captureConsole, createLogSink } from "./logging.ts";
import { installFetchGuard } from "./fetch.ts";
import { resolveLimits } from "./limits.ts";
import { messageOf } from "./messages.ts";
import { guardTransport, type RunnerTransport } from "./transport.ts";

export { FrameTooLargeError, SocketHostTransport, type HostTransport } from "./transport.ts";
export { guardTransport, type RunnerTransport } from "./transport.ts";
export {
  DEFAULT_MAX_HOST_CALLS,
  DEFAULT_MAX_LOG_BYTES,
  DEFAULT_MAX_LOG_LINES,
  DEFAULT_TIMEOUT_MS,
  HostCallLimitError,
  resolveLimits,
  type InvocationLimits,
} from "./limits.ts";
export {
  captureConsole,
  createLogSink,
  formatArgs,
  formatValue,
  LOG_TRUNCATION_NOTICE,
  type LogSink,
} from "./logging.ts";
export {
  compileAllowlist,
  createGuardedFetch,
  DEFAULT_MAX_FETCH_RESPONSE_BYTES,
  FetchBlockedError,
  FetchResponseTooLargeError,
  installFetchGuard,
} from "./fetch.ts";
export { boundedResultFrame, type ResultOutcome } from "./result.ts";
export { messageOf } from "./messages.ts";
export { createSession, type Session, type SessionOptions } from "./session.ts";

export const RUNNER_VERSION = "0.0.0";

type Handler = (ctx: unknown, params: unknown) => unknown;

export interface RunInvocationOptions {
  transport: RunnerTransport;
  invocationId: string;
  subjectActorId: string;
  /** How the host resolved the subject; absent means an actor. */
  callerKind?: "actor" | "service";
  bundle: string;
  entry: string;
  input: unknown;
  /** The invocation's per-function secrets, from `invoke.env`. */
  env?: Readonly<Record<string, string>>;
  /** The invocation's budget, from `invoke.limits`; defaults apply per field. */
  limits?: FunctionLimits;
}

/**
 * Evaluates one bundle, runs its exported handler, and flushes its buffered
 * writes as one Action before returning.
 *
 * The flush is what makes "commit at return" true: the handler's writes go out
 * as a single `commit` frame, and a handler that throws never reaches it, so
 * nothing is submitted. The bundle is an IIFE built by `@ebbjs/cli`; it leaves
 * its exports on the `__ebbFunction` global. A deployed bundle exports one
 * `defineFunction` definition per entry name — `{ <entryName>: { schema,
 * handler } }` — while a test fixture may export the handler and the schema
 * side by side.
 *
 * The process boundary is for resilience, not a security sandbox: functions
 * are trusted authors and Bun globals stay reachable. The guardrails this
 * function installs for the handler's lifetime are best-effort, not a sandbox:
 *
 * - host calls stop at `max_host_calls`, with a `HostCallLimitError` the
 *   handler can catch; nothing is sent past the budget;
 * - `ctx.log` and `console.debug/info/log/warn/error` share a line and byte
 *   budget; lines past it are dropped after one truncation notice;
 * - `globalThis.fetch` is replaced by an allowlist and response-cap shim that
 *   emits one `fetch_audit` per request — and restored afterwards, as are the
 *   `console` methods. One invocation runs per process at a time, so patching
 *   the globals for its duration is safe here.
 */
export async function runInvocation(options: RunInvocationOptions): Promise<unknown> {
  const limits = resolveLimits(options.limits);
  // Log lines do not pass through the call budget and calls do not pass
  // through the log budget, so both wrappers sit on the raw transport.
  const sink = createLogSink({
    send: (entry) => sendLog(options.transport, entry),
    maxLines: limits.maxLogLines,
    maxBytes: limits.maxLogBytes,
  });
  const transport = guardTransport({
    transport: options.transport,
    maxHostCalls: limits.maxHostCalls,
    log: (entry) => sink.log(entry),
  });
  const restoreConsole = captureConsole((entry) => sink.log(entry));
  const restoreFetch = installFetchGuard({
    allowlist: limits.fetchAllowlist,
    audit: (fields) => sendAudit(options.transport, fields),
  });

  try {
    const module = evaluateBundle(options.bundle);
    const exported = module[options.entry];
    const handler = typeof exported === "function" ? exported : handlerOf(exported);

    if (handler === undefined) {
      throw new HandlerError(`bundle does not export a function named ${options.entry}`);
    }

    // Annotated so the runtime context keeps satisfying the SDK's handler view.
    const ctx: Context = createContext({
      transport,
      invocationId: options.invocationId,
      actor: { id: options.subjectActorId },
      caller: { kind: options.callerKind ?? "actor", id: options.subjectActorId },
      registry: schemaRegistryOf(module, options.entry),
      env: options.env,
    });

    const value = await (handler as Handler)(ctx, options.input);
    // One invocation is one Action: pending writes flush before the result frame.
    await ctx.commit();
    return value;
  } finally {
    restoreFetch();
    restoreConsole();
    sink.close();
  }
}

/** Logging is fire-and-forget: a transport that throws must not fail the call. */
const sendLog = (transport: RunnerTransport, entry: LogEntry): void => {
  try {
    transport.log?.(entry);
  } catch {
    // Dropped: the invocation does not fail over a log line.
  }
};

/** Fetch telemetry is fire-and-forget too; it never fails the request it describes. */
const sendAudit = (transport: RunnerTransport, fields: FetchAuditFields): void => {
  try {
    transport.audit?.(fields);
  } catch {
    // Dropped: telemetry never fails an invocation.
  }
};

/** A `defineFunction` definition as it survives the bundle, or `undefined`. */
const handlerOf = (exported: unknown): Handler | undefined => {
  if (typeof exported !== "object" || exported === null) return undefined;
  const handler = (exported as { handler?: unknown }).handler;
  return typeof handler === "function" ? (handler as Handler) : undefined;
};

/** The `schema` a bundle export carries, when it is an object. */
const schemaOf = (value: unknown): unknown =>
  typeof value === "object" && value !== null ? (value as { schema?: unknown }).schema : undefined;

/**
 * The schema registry a bundle exports, when it exports one.
 *
 * A deployed bundle keeps the schema on its entry's definition
 * (`module[entry].schema`), while a fixture may export it as `module.schema`;
 * `module.schema` wins when both are present. The check is structural, not
 * `instanceof`: a bundle carries its own copy of `@ebbjs/schema`, so the
 * registry it built is an instance of the bundle's class, not this module's.
 */
export function schemaRegistryOf(
  module: Record<string, unknown>,
  entry?: string,
): ModelRegistry | undefined {
  const fromModule = registryOf(schemaOf(module));
  if (fromModule !== undefined || entry === undefined) return fromModule;
  return registryOf(schemaOf(module[entry]));
}

const registryOf = (schema: unknown): ModelRegistry | undefined => {
  if (typeof schema !== "object" || schema === null) return undefined;
  const registry = (schema as { _registry?: unknown })._registry;
  if (typeof registry !== "object" || registry === null) return undefined;
  const candidate = registry as Record<string, unknown>;
  if (
    typeof candidate["get"] !== "function" ||
    typeof candidate["getRelationship"] !== "function"
  ) {
    return undefined;
  }
  return registry as ModelRegistry;
};

export class HandlerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandlerError";
  }
}

export function evaluateBundle(bundle: string): Record<string, unknown> {
  // `new Function` creates a global-scope function, so `fetch` and other Bun
  // globals are reachable exactly as they are in an ordinary module.
  const factory = new Function(
    `"use strict";\n${bundle}\nreturn typeof __ebbFunction === "object" && __ebbFunction !== null ? __ebbFunction : {};`,
  ) as () => Record<string, unknown>;

  return factory();
}
