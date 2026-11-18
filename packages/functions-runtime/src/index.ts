/**
 * `@ebbjs/functions-runtime` — the context a function handler runs against.
 *
 * Reads go out as `get` host calls and see the invocation's own buffered
 * writes through an overlay. Writes buffer in call order, run the shared
 * `@ebbjs/write` planner at the call site, and go out as one `commit` frame —
 * one Action, one GSN, atomic across its Updates — on `ctx.commit()` or when
 * the runner flushes a handler that returned. A handler that throws submits
 * nothing.
 */

import { createClock, type HLCState } from "@ebbjs/core";
import { formatLogValue, isLogLevel, type LogLevel } from "@ebbjs/functions-protocol";
import type { ModelRegistry } from "@ebbjs/schema";
import type { Caller, ContextBase, OperationIds } from "@ebbjs/write";

import type { HostTransport, LogEntry } from "./transport.ts";
import { createWriteSurface, defaultOperationIds, type WriteSurface } from "./writes.ts";

export { ActionRejectedError } from "@ebbjs/write";
export { EntityValidationError } from "@ebbjs/schema";
export { HostCallError, actionIdForInvocation } from "./commit.ts";
export { MissingSchemaError, WritesCommittedError } from "./errors.ts";
export type { Caller, CallerKind, HostOp, HostTransport, LogEntry } from "./transport.ts";
export type {
  CommitOutcome,
  CreateHandle,
  CreateOptions,
  OperationIds,
  RelationshipTarget,
  WriteOptions,
} from "@ebbjs/write";
export type { ModelRegistry } from "@ebbjs/schema";

/**
 * The handler's view of one invocation: the shared `ctx` port plus what only a
 * live invocation has.
 *
 * The verbs, their options, and `commit` are {@link ContextBase}, declared in
 * `@ebbjs/write` and shared with the SDK's `Context<S>` — one definition, so
 * the two can no longer disagree about what a handler may call. The write verbs
 * buffer; nothing reaches the server until `commit` or the runner's flush at
 * handler return, and the package README states the one-Action rule. There is
 * no `ctx.fetch`; handlers use the runtime's global `fetch`.
 */
export interface Context extends ContextBase {
  /**
   * Send one log line to the host, fire-and-forget. `level` defaults to
   * `"info"`; `"log"` is the level `console.log` maps to.
   *
   * The host owns the budget: once the invocation's line or byte cap is
   * reached the line is dropped, and at most one truncation notice follows.
   * Logging therefore never fails an invocation — not a transport error, not
   * an unserializable value. Messages are the handler's own; the runtime never
   * logs `env` for it.
   */
  log(message: string, level?: LogLevel): void;

  /**
   * The invocation's per-function secrets, from the invoke frame. Frozen and
   * copied at context creation, so a handler cannot widen or reassign them.
   * Empty when the function has no secrets.
   */
  readonly env: Readonly<Record<string, string>>;
}

export interface CreateContextOptions {
  readonly transport: HostTransport;
  readonly invocationId: string;
  readonly actor: { readonly id: string };
  readonly caller: Caller;
  /** The schema the write verbs resolve entity and relationship names against. */
  readonly registry?: ModelRegistry;
  /** Deterministic id seam; defaults to core's nanoid `generateId`. */
  readonly ids?: OperationIds;
  /** The invocation's clock; defaults to a fresh `createClock()`. */
  readonly clock?: HLCState;
  /** The invocation's per-function secrets; copied and frozen onto `ctx.env`. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Build the `ctx` a handler receives.
 *
 * Reads are independent host calls, so two concurrent `get`s are independent
 * snapshots rather than a consistent read; the only consistency the context
 * adds is the overlay of its own buffered writes.
 */
export function createContext(options: CreateContextOptions): Context {
  const clock = options.clock ?? createClock();
  const ids = options.ids ?? defaultOperationIds(clock);
  const surface: WriteSurface = createWriteSurface({
    transport: options.transport,
    invocationId: options.invocationId,
    actorId: options.actor.id,
    ids,
    registry: options.registry,
  });

  const log = (message: string, level?: LogLevel): void => {
    try {
      options.transport.log?.(logEntry(message, level));
    } catch {
      // A log line is best-effort: it must never fail the invocation.
    }
  };

  return Object.freeze({
    get: surface.read,
    create: surface.create,
    update: surface.update,
    delete: surface.delete,
    relate: surface.relate,
    unrelate: surface.unrelate,
    commit: surface.commit,
    log,
    actor: Object.freeze({ id: options.actor.id }),
    caller: Object.freeze({ kind: options.caller.kind, id: options.caller.id }),
    invocationId: options.invocationId,
    env: freezeEnv(options.env),
  });
}

const logEntry = (message: unknown, level: unknown): LogEntry => ({
  level: isLogLevel(level) ? level : "info",
  message: formatLogValue(message),
});

/** A frozen copy: `env` is per-invocation data, never a shared host object. */
const freezeEnv = (
  env: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> =>
  Object.freeze(
    Object.fromEntries(Object.entries(env ?? {}).map(([key, value]) => [key, String(value)])),
  );
