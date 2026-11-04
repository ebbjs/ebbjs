/**
 * One host connection, many invocations.
 *
 * A pooled host keeps the runner process after `result` and sends the next
 * `invoke` over the same socket, so the connection owns the decode buffer and
 * the lifecycle while each invocation owns a fresh {@link SocketHostTransport}
 * (its own pending-call map and call-id sequence). `ready` is sent once, on
 * connect, and the process exits when the host closes the socket — never after
 * a `result`.
 *
 * The session is the protocol state machine without the socket: it takes a
 * `send` callback and a fatal callback, which is what makes reuse and protocol
 * errors testable without spawning a process. `main.ts` binds the socket and
 * `process.exit` to it.
 */

import {
  decodeFrames,
  ready,
  PROTOCOL_VERSION,
  type DecodeError,
  type Frame,
  type InvokeFrame,
  type ReplyFrame,
} from "@ebbjs/functions-protocol";

import type { RunInvocationOptions } from "./index.ts";
import { HostCallLimitError, resolveLimits } from "./limits.ts";
import { messageOf } from "./messages.ts";
import { boundedResultFrame, type ResultOutcome } from "./result.ts";
import { SocketHostTransport } from "./transport.ts";

export interface SessionOptions {
  readonly send: (frame: Frame) => void;
  /** The connection cannot continue: a protocol error. The caller exits non-zero. */
  readonly onFatal: (message: string) => void;
  readonly runnerVersion: string;
  readonly pid: number;
  /** Runs one invocation. Tests substitute a seam instead of a bundle. */
  readonly run: (options: RunInvocationOptions) => Promise<unknown>;
}

export interface Session {
  /** Sends `ready` once. A second call is a no-op. */
  opened(): void;
  /** Feeds bytes from the host; frames may split across calls in any place. */
  receive(chunk: Uint8Array): void;
  /** The host closed the connection: reject in-flight calls and stop sending. */
  closed(): void;
  /** Resolves once no invocation is in flight. */
  idle(): Promise<void>;
  /** True while an invocation is running, including its `result` write. */
  readonly inFlight: boolean;
  /** True after `closed()` or a fatal protocol error. */
  readonly stopped: boolean;
}

export function createSession(options: SessionOptions): Session {
  const run = options.run;
  let buffer: Uint8Array = new Uint8Array(0);
  let transport: SocketHostTransport | null = null;
  let current: Promise<void> | null = null;
  let readySent = false;
  let stopped = false;
  let fatal = false;
  // Whether the in-flight invocation already wrote its `result`; a protocol
  // error in the window before its promise settles must not write a second.
  let settled = false;

  const halted = (): boolean => stopped || fatal;

  const send = (frame: Frame): void => {
    if (halted()) return;

    try {
      options.send(frame);
    } catch {
      // The socket's own error handler ends the process; a frame that cannot
      // be written must not turn into an unhandled rejection.
    }
  };

  const fail = (message: string): void => {
    if (halted()) return;

    // The invocation the host is waiting on gets an error result before the
    // process ends, so it fails with a message instead of a dead socket.
    if (current !== null && !settled) {
      settled = true;
      send(boundedResultFrame({ ok: false, kind: "handler_error", message }));
    }

    fatal = true;
    transport?.close();
    options.onFatal(message);
  };

  const finish = (active: SocketHostTransport): void => {
    // A pooled host may already have queued the next invocation; rejecting
    // what is left in this one's pending map keeps its calls from resolving
    // into the next invocation's map.
    active.close();
    if (transport === active) transport = null;
    current = null;
  };

  const invoke = (frame: InvokeFrame): void => {
    if (current !== null) {
      fail("protocol error: invoke received while an invocation is in flight");
      return;
    }

    const active = new SocketHostTransport({ send });
    const bound = resolveLimits(frame.limits).maxOutputBytes;
    const outcomeOf = (result: ResultOutcome): void => {
      if (halted() || settled) return;
      settled = true;
      send(boundedResultFrame(result, bound));
    };

    transport = active;
    settled = false;

    const started = ((): Promise<unknown> => {
      try {
        return run({
          transport: active,
          invocationId: String(frame.invocation_id ?? ""),
          subjectActorId: String(frame.subject_actor_id ?? ""),
          callerKind: frame.caller_kind === "service" ? "service" : "actor",
          bundle: String(frame.bundle ?? ""),
          entry: String(frame.entry ?? frame.name ?? ""),
          input: frame.input,
          env: frame.env,
          limits: frame.limits,
        });
      } catch (error) {
        return Promise.reject(error);
      }
    })();

    current = started.then(
      (value) => outcomeOf({ ok: true, value }),
      (error) => outcomeOf(failureOutcome(error)),
    );
    current = current.finally(() => finish(active));
  };

  const dispatch = (frame: Frame): void => {
    // `Frame` includes the open `UnrecognizedFrame` shape, so a `type`
    // comparison narrows to that too; the two host frames are the shapes the
    // codec promises for those types.
    if (frame.type === "reply") {
      transport?.handleReply(frame as ReplyFrame);
      return;
    }

    // Anything else from the host is not this protocol version's business:
    // ignoring it keeps a newer host's frames from failing an invocation.
    if (frame.type === "invoke") invoke(frame as InvokeFrame);
  };

  return {
    get inFlight() {
      return current !== null;
    },
    get stopped() {
      return halted();
    },
    opened() {
      if (readySent || halted()) return;
      readySent = true;
      send(ready(options.pid, options.runnerVersion, PROTOCOL_VERSION));
    },
    receive(chunk) {
      if (halted()) return;

      const combined = new Uint8Array(buffer.length + chunk.length);
      combined.set(buffer);
      combined.set(chunk, buffer.length);

      const decoded = decodeFrames(combined);
      if (!decoded.ok) {
        fail(`invalid frame from host: ${decodeErrorText(decoded.error)}`);
        return;
      }

      buffer = decoded.rest;
      for (const frame of decoded.frames) dispatch(frame);
    },
    closed() {
      if (halted()) return;
      stopped = true;
      transport?.abandon(new Error("host closed the connection"));
    },
    idle() {
      return current ?? Promise.resolve();
    },
  };
}

/**
 * A thrown invocation as a failure result.
 *
 * The budget refusal has its own kind, because it is the host's configuration
 * reaching the caller rather than a bug in the handler; everything else is a
 * handler error, including a handler that caught nothing.
 */
function failureOutcome(error: unknown): ResultOutcome {
  return {
    ok: false,
    kind: error instanceof HostCallLimitError ? "host_call_limit" : "handler_error",
    message: messageOf(error),
  };
}

/** A stable one-line description of a decode failure, for the exit message. */
function decodeErrorText(error: DecodeError): string {
  return error.kind;
}
