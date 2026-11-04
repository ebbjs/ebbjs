# `@ebbjs/runner`

The Bun process that evaluates a deployed Function's bundle and runs one
Invocation against the host-call frame protocol.

Private. The server owns a Worker: a Unix socket, a process group, and a
deadline. The runner connects back, says `ready` once, and then serves
`invoke` frames from that host for as long as the socket stays open.

## One process, one invocation at a time

A pooled host reuses a runner for several invocations, so the process stays
alive after `result` and waits for the next `invoke`. Per invocation the runner
builds a fresh transport (its own pending-call map and `call_id` sequence) and
a fresh context; the connection keeps only the frame-decode buffer.

- `ready` is sent exactly once, on connect.
- A `result` ends the invocation, not the process. Pending calls from that
  invocation are rejected so they cannot resolve into the next one.
- An `invoke` that arrives while an invocation is in flight is a protocol
  error: the runner reports the in-flight invocation as failed, writes the
  reason to stderr, and exits non-zero.
- The runner exits when the host closes the socket: `0` if it was idle, `1` if
  an invocation was still running. It never exits on its own after a result —
  retiring an idle worker is the host's decision.

## Budgets

The invoke frame's `limits` are optional, and each field falls back to a
documented default (`src/limits.ts`). The runner enforces, per invocation:

| limit              | default    | enforced by                                                                                   |
| ------------------ | ---------- | --------------------------------------------------------------------------------------------- |
| `max_host_calls`   | 1000       | runner: past the cap `ctx.get`/`ctx.commit` reject with `HostCallLimitError`, nothing is sent |
| `max_output_bytes` | 1 MiB      | runner: the result frame, clamped to the protocol's frame bound                               |
| `max_log_lines`    | 200        | runner: `ctx.log` and captured `console` share one sink                                       |
| `max_log_bytes`    | 64 KiB     | runner: message bytes, same sink                                                              |
| `fetch_allowlist`  | empty      | runner: the fetch shim; empty means unrestricted                                              |
| `timeout_ms`       | 30000      | host: it kills the process group at the deadline                                              |
| `memory_bytes`     | host-owned | host: it sets the process group's limit                                                       |

An oversize result is not a transport failure: the runner sends a small
`{ "ok": false, "kind": "output_too_large" }` result and stays alive for the
next invocation. An oversize `commit` is refused at the call site by
`FrameTooLargeError`, as before.

`memory_bytes` and `timeout_ms` are carried in the frame but not enforced here:
a synchronous handler cannot be preempted, and the host already tears the
process group down. A log line past its budget is dropped; the first drop sends
one truncation notice and everything after it is dropped silently.

## Globals during an invocation

One invocation runs per process at a time, so patching globals for its duration
is safe. Both patches are restored in a `finally`, including when the handler
throws.

- `console.debug/info/log/warn/error` become `log` frames. Arguments are
  stringified and joined with a space; format specifiers are printed literally.
- `globalThis.fetch` becomes a shim that emits one `fetch_audit` frame per
  request (method, URL, status, duration, blocked — never headers or bodies).
  With a non-empty allowlist it refuses any other host before sending; every
  response is capped at 10 MiB, by `content-length` when present and by a
  streaming wrapper while the body is read.

This is a guardrail, not a sandbox: the process boundary is for resilience, and
another global fetch implementation or a native module can still reach the
network. The deployment's egress policy is the real boundary.

## Tests

- `src/index.test.ts` — the context the bundle sees: schema, writes, env, logs,
  the host-call budget, and the fetch shim end to end.
- `src/session.test.ts` — the connection state machine: `ready` once, two
  invocations over one connection, per-invocation transports, protocol errors,
  and the output bound.
- `src/logging.test.ts`, `src/fetch.test.ts`, `src/limits.test.ts`,
  `src/result.test.ts` — the guardrails in isolation.
