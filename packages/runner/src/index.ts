import { createContext, type EntityRegistry } from "@ebbjs/functions-runtime";

import { SocketHostTransport, type HostTransport } from "./transport.ts";

export { FrameTooLargeError, SocketHostTransport, type HostTransport } from "./transport.ts";

export const RUNNER_VERSION = "0.0.0";

type Handler = (ctx: unknown, params: unknown) => unknown;

export interface RunInvocationOptions {
  transport: HostTransport;
  invocationId: string;
  subjectActorId: string;
  bundle: string;
  entry: string;
  input: unknown;
}

/**
 * Evaluates one bundle, runs its exported handler, and flushes its buffered
 * writes as one Action before returning.
 *
 * The flush is what makes "commit at return" true: the handler's writes go out
 * as a single `commit` frame, and a handler that throws never reaches it, so
 * nothing is submitted. The bundle is an IIFE built by `@ebbjs/cli`; it leaves
 * its exports — the handler and, optionally, the application `schema` — on the
 * `__ebbFunction` global. The process boundary is for resilience, not a
 * security sandbox: functions are trusted authors and Bun globals stay
 * reachable, including native `fetch`.
 */
export async function runInvocation(options: RunInvocationOptions): Promise<unknown> {
  const module = evaluateBundle(options.bundle);
  const handler = module[options.entry];

  if (typeof handler !== "function") {
    throw new HandlerError(`bundle does not export a function named ${options.entry}`);
  }

  const ctx = createContext({
    transport: options.transport,
    invocationId: options.invocationId,
    actor: { id: options.subjectActorId },
    caller: { kind: "actor", id: options.subjectActorId },
    registry: schemaRegistryOf(module),
  });

  const value = await (handler as Handler)(ctx, options.input);
  // One invocation is one Action: pending writes flush before the result frame.
  await ctx.commit();
  return value;
}

/**
 * The schema registry a bundle exports, when it exports one.
 *
 * The check is structural, not `instanceof`: a bundle carries its own copy of
 * `@ebbjs/schema`, so the registry it built is an instance of the bundle's
 * class, not this module's.
 */
export function schemaRegistryOf(module: Record<string, unknown>): EntityRegistry | undefined {
  const schema = module["schema"];
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
  return registry as EntityRegistry;
}

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

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
