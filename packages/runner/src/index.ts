import { createContext } from "@ebbjs/functions-runtime";

import { SocketHostTransport, type HostTransport } from "./transport.ts";

export { SocketHostTransport, type HostTransport } from "./transport.ts";

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
 * Evaluates one bundle and runs its exported handler.
 *
 * The bundle is an IIFE built by `@ebbjs/cli`; it leaves its exports on the
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
  });

  return (handler as Handler)(ctx, options.input);
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
