import { createConnection, type Socket } from "node:net";

import {
  decodeFrames,
  encodeFrame,
  ready,
  result,
  type Frame,
  type InvokeFrame,
  type ReplyFrame,
} from "@ebbjs/functions-protocol";

import { RUNNER_VERSION, messageOf, runInvocation } from "./index.ts";
import { SocketHostTransport } from "./transport.ts";

const PROTOCOL_VERSION = 1;
const EXIT_GRACE_MS = 50;

interface State {
  buffer: Uint8Array;
  transport: SocketHostTransport | null;
  finished: boolean;
}

async function main(): Promise<void> {
  const socketPath = process.argv[2];

  if (!socketPath) {
    process.stderr.write("usage: runner <socket-path>\n");
    process.exit(64);
  }

  const socket = createConnection({ path: socketPath });
  const state: State = { buffer: new Uint8Array(0), transport: null, finished: false };

  socket.on("connect", () => {
    socket.write(encodeFrame(ready(process.pid, RUNNER_VERSION, PROTOCOL_VERSION)));
  });

  socket.on("data", (chunk: Buffer) => receive(socket, chunk, state));
  socket.on("close", () => {
    state.transport?.failAll(new Error("host socket closed"));
    if (!state.finished) process.exit(1);
  });
  socket.on("error", (error) => {
    state.transport?.failAll(error);
    if (!state.finished) {
      process.stderr.write(`runner socket error: ${error.message}\n`);
      process.exit(1);
    }
  });
}

function receive(socket: Socket, chunk: Buffer, state: State): void {
  const buffer = new Uint8Array(state.buffer.length + chunk.length);
  buffer.set(state.buffer);
  buffer.set(chunk, state.buffer.length);

  const decoded = decodeFrames(buffer);

  if (!decoded.ok) {
    finish(
      socket,
      {
        ok: false,
        kind: "handler_error",
        message: `invalid frame from host: ${String(decoded.error)}`,
      },
      state,
    );
    return;
  }

  state.buffer = decoded.rest;

  for (const frame of decoded.frames) {
    handleFrame(socket, frame, state);
  }
}

function handleFrame(socket: Socket, frame: Frame, state: State): void {
  if (state.finished) return;

  if (frame.type === "reply") {
    state.transport?.handleReply(frame as ReplyFrame);
    return;
  }

  if (frame.type !== "invoke") return;

  const transport = new SocketHostTransport({
    send: (outgoing: Frame) => void socket.write(encodeFrame(outgoing)),
  });
  state.transport = transport;
  void handleInvoke(socket, frame as InvokeFrame, transport, state);
}

async function handleInvoke(
  socket: Socket,
  frame: InvokeFrame,
  transport: SocketHostTransport,
  state: State,
): Promise<void> {
  try {
    const value = await runInvocation({
      transport,
      invocationId: String(frame.invocation_id ?? ""),
      subjectActorId: String(frame.subject_actor_id ?? ""),
      bundle: String(frame.bundle ?? ""),
      entry: String(frame.entry ?? frame.name ?? ""),
      input: frame.input,
    });

    finish(socket, { ok: true, value }, state);
  } catch (error) {
    finish(socket, { ok: false, kind: "handler_error", message: messageOf(error) }, state);
  } finally {
    transport.close();
  }
}

function finish(
  socket: Socket,
  outcome: { ok: true; value: unknown } | { ok: false; kind: string; message: string },
  state: State,
): void {
  if (state.finished) return;

  state.finished = true;
  socket.write(encodeFrame(result(outcome)), () => {
    socket.end();
  });

  setTimeout(() => process.exit(0), EXIT_GRACE_MS).unref();
}

void main();
