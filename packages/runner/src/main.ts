/**
 * The runner process: connect, say `ready`, and stay alive for as many
 * invocations as the host sends.
 *
 * The process lifecycle is the host's to decide. After a `result` the session
 * waits for the next `invoke`; the runner exits when the host closes the
 * socket, and exits non-zero when the socket fails or the host breaks the
 * protocol. One invocation runs at a time: a second `invoke` before the first
 * `result` is a protocol error, because a pooled runner has no way to tell two
 * in-flight invocations apart on one connection.
 */

import { createConnection } from "node:net";

import { encodeFrame } from "@ebbjs/functions-protocol";

import { runInvocation, RUNNER_VERSION } from "./index.ts";
import { createSession } from "./session.ts";

/** How long a fatal path waits for its last frame to flush before exiting. */
const EXIT_GRACE_MS = 100;

function main(): void {
  const socketPath = process.argv[2];

  if (!socketPath) {
    process.stderr.write("usage: runner <socket-path>\n");
    process.exit(64);
  }

  const socket = createConnection({ path: socketPath });
  const session = createSession({
    send: (frame) => void socket.write(encodeFrame(frame)),
    onFatal: (message) => {
      process.stderr.write(`runner protocol error: ${message}\n`);
      // `end` flushes the error result the session just wrote; the timer is
      // the fallback for a socket that cannot finish its own shutdown.
      socket.end(() => process.exit(1));
      setTimeout(() => process.exit(1), EXIT_GRACE_MS).unref();
    },
    runnerVersion: RUNNER_VERSION,
    pid: process.pid,
    run: runInvocation,
  });

  let ended = false;
  let abandoned = false;

  socket.on("connect", () => session.opened());
  socket.on("data", (chunk: Buffer) => session.receive(chunk));

  socket.on("end", () => {
    // A host that closes mid-invocation abandoned it; a host that closes while
    // idle is retiring a healthy worker. The exit code says which.
    ended = true;
    abandoned = session.inFlight;
    session.closed();
    socket.end();
  });

  socket.on("close", () => {
    if (!ended) abandoned = session.inFlight;
    session.closed();
    process.exit(abandoned ? 1 : 0);
  });

  socket.on("error", (error) => {
    process.stderr.write(`runner socket error: ${error.message}\n`);
    session.closed();
    process.exit(1);
  });
}

main();
