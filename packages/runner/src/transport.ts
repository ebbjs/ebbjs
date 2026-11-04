import {
  call,
  fetchAudit,
  fits,
  logFrame,
  MAX_FRAME_BYTES,
  type FetchAuditFields,
  type Frame,
  type FrameOp,
  type ReplyFrame,
} from "@ebbjs/functions-protocol";
import type { HostTransport, LogEntry } from "@ebbjs/functions-runtime";

import { HostCallLimitError } from "./limits.ts";

export type { HostTransport } from "@ebbjs/functions-runtime";

/**
 * The runner's transport: the channel a handler calls through, plus the two
 * fire-and-forget frames the runner itself sends.
 *
 * `log` is on the runtime's `HostTransport` because `ctx.log` uses it; `audit`
 * is here because the fetch shim, not the context, is what observes egress.
 * Both are optional so a test double that only answers calls still fits.
 */
export interface RunnerTransport extends HostTransport {
  audit?(fields: FetchAuditFields): void;
}

/**
 * The transport a handler sees for one invocation: host calls stopped once the
 * host-call budget is spent, and log lines routed through the invocation's log
 * sink.
 *
 * The refusal is local and synchronous-ish, so a handler can catch
 * `HostCallLimitError` and return a smaller result; nothing is sent to the
 * host and the socket stays open.
 */
export function guardTransport(options: {
  readonly transport: RunnerTransport;
  readonly maxHostCalls: number;
  readonly log: (entry: LogEntry) => void;
}): RunnerTransport {
  let calls = 0;

  return {
    call(op, payload) {
      if (calls >= options.maxHostCalls) {
        return Promise.reject(new HostCallLimitError(options.maxHostCalls));
      }

      calls += 1;
      return options.transport.call(op, payload);
    },
    log(entry) {
      options.log(entry);
    },
  };
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

export class SocketHostTransport implements RunnerTransport {
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

  /** Fire-and-forget: no reply, no pending entry, no `call_id`. */
  log(entry: LogEntry): void {
    if (this.#closed) return;
    this.#send(logFrame(entry.level, entry.message));
  }

  /** Fire-and-forget egress telemetry: headers and bodies never get here. */
  audit(fields: FetchAuditFields): void {
    if (this.#closed) return;
    this.#send(fetchAudit(fields));
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

  /** Ends the transport because the connection is gone, with the caller's reason. */
  abandon(reason: unknown): void {
    this.#closed = true;
    this.#failAll(reason);
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
