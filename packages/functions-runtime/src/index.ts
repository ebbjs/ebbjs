import type { EntityResponse } from "@ebbjs/client";

/** The host operations a runtime may call in v1. */
export type HostOp = "get" | "commit";

/**
 * One host call, answered by the server through the frame channel.
 *
 * The transport owns `call_id` allocation and reply matching; the context does
 * not know whether the answer arrived in order, over a socket, or in a test
 * double. A refused call rejects with the host's error object.
 */
export interface HostTransport {
  call(op: HostOp, payload: unknown): Promise<unknown>;
}

/** Who invoked the function. Never client-supplied. */
export interface Caller {
  readonly kind: "actor" | "service";
  readonly id: string;
}

/**
 * The handler's read-only view of one invocation.
 *
 * `get` is the only entity read in v1. A missing entity and an entity the
 * subject may not read are deliberately indistinguishable: both are `null`.
 * There is no `ctx.fetch`; handlers use the runtime's global `fetch`.
 */
export interface Context {
  get(id: string): Promise<EntityResponse | null>;
  readonly actor: { readonly id: string };
  readonly caller: Caller;
  readonly invocationId: string;
}

export interface CreateContextOptions {
  readonly transport: HostTransport;
  readonly invocationId: string;
  readonly actor: { readonly id: string };
  readonly caller: Caller;
}

/**
 * Builds the `ctx` a handler receives.
 *
 * Reads are independent host calls, so two concurrent `get`s are independent
 * snapshots rather than a consistent read. That is the documented v1
 * semantics: the invocation boundary is for resilience, not transactions.
 */
export function createContext(options: CreateContextOptions): Context {
  const { transport } = options;

  return Object.freeze({
    get: async (id: string): Promise<EntityResponse | null> => {
      if (typeof id !== "string" || id === "") {
        throw new TypeError("ctx.get(id) requires a non-empty entity id");
      }

      const value = await transport.call("get", { id });
      return (value ?? null) as EntityResponse | null;
    },
    actor: Object.freeze({ id: options.actor.id }),
    caller: Object.freeze({ kind: options.caller.kind, id: options.caller.id }),
    invocationId: options.invocationId,
  });
}
