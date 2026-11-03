import {
  call,
  fits,
  MAX_FRAME_BYTES,
  type Frame,
  type FrameOp,
  type ReplyFrame,
} from "@ebbjs/functions-protocol";

/**
 * The runner side of the host-call channel.
 *
 * Every call gets a `call_id`; replies may arrive in any order, so the pending
 * map is keyed by id and never by arrival position. The host caps how many
 * calls are outstanding, not the runner.
 */
export interface HostTransport {
  call(op: FrameOp, payload: unknown): Promise<unknown>;
}

/** A host call whose encoded frame would exceed the protocol's frame bound. */
export class FrameTooLargeError extends Error {
  readonly op: FrameOp;

  constructor(op: FrameOp) {
    super(
      `${op} payload exceeds the ${MAX_FRAME_BYTES}-byte frame limit; ` +
        (op === "commit"
          ? "the invocation produced too many or too large Updates for one Action"
          : "the request is too large"),
    );
    this.name = "FrameTooLargeError";
    this.op = op;
  }
}

export interface HostTransportOptions {
  send(frame: Frame): void;
}

export class SocketHostTransport implements HostTransport {
  readonly #pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  readonly #send: (frame: Frame) => void;
  #nextCallId = 1;
  #closed = false;

  constructor(options: HostTransportOptions) {
    this.#send = options.send;
  }

  get closed(): boolean {
    return this.#closed;
  }

  call(op: FrameOp, payload: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("host socket is closed"));

    const callId = String(this.#nextCallId++);
    const frame = call(callId, op, payload);

    // The host refuses an oversize frame from its length prefix and ends the
    // invocation. Refusing here keeps the failure at the call that caused it,
    // with an error the handler can read, instead of a closed socket.
    if (!fits(frame)) return Promise.reject(new FrameTooLargeError(op));

    return new Promise((resolve, reject) => {
      this.#pending.set(callId, { resolve, reject });
      this.#send(frame);
    });
  }

  /** Resolves or rejects a pending call from a host `reply`. */
  handleReply(reply: ReplyFrame): void {
    const pending = this.#pending.get(reply.call_id);
    if (!pending) return;

    this.#pending.delete(reply.call_id);
    if (reply.ok) pending.resolve(reply.value);
    else pending.reject(reply.error);
  }

  close(): void {
    this.#closed = true;
    this.#failAll(new Error("runner finished"));
  }

  failAll(error: unknown): void {
    this.#failAll(error);
  }

  #failAll(error: unknown): void {
    for (const [callId, pending] of this.#pending) {
      this.#pending.delete(callId);
      pending.reject(error);
    }
  }
}
