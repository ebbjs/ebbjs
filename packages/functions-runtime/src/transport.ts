/** The host-call channel a runtime is given, and who invoked the function. */

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
