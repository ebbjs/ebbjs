/**
 * The invocation's log budget, and `console` capture under it.
 *
 * Both `ctx.log` and the captured `console` methods write through one sink.
 * The sink counts lines and message bytes over the whole invocation; the first
 * line that does not fit is dropped, followed by one truncation notice, and
 * everything after it is dropped silently. Dropping is the only failure mode:
 * a log line never fails an invocation.
 */

import type { LogEntry } from "@ebbjs/functions-runtime";
import type { LogLevel } from "@ebbjs/functions-protocol";

/** The single line that follows the first dropped log line. */
export const LOG_TRUNCATION_NOTICE =
  "logs truncated: this invocation reached its log budget; later lines were dropped";

const encoder = new TextEncoder();

/** Where the sink's lines go. The runner points this at the transport frame. */
export type LogSinkSend = (entry: LogEntry) => void;

export interface LogSinkOptions {
  readonly send: LogSinkSend;
  readonly maxLines: number;
  readonly maxBytes: number;
}

export interface LogSink {
  log(entry: LogEntry): void;
  /** True once a line was dropped and the truncation notice was sent. */
  readonly truncated: boolean;
  /** Stops the sink: a log line arriving after the invocation is dropped. */
  close(): void;
}

export function createLogSink(options: LogSinkOptions): LogSink {
  let lines = 0;
  let bytes = 0;
  let truncated = false;
  let closed = false;

  const send = (entry: LogEntry): void => {
    try {
      options.send(entry);
    } catch {
      // A transport that throws on a log line must not fail the invocation.
    }
  };

  return {
    get truncated() {
      return truncated;
    },
    log(entry) {
      if (closed || truncated) return;

      const size = encoder.encode(entry.message).length;
      if (lines + 1 > options.maxLines || bytes + size > options.maxBytes) {
        truncated = true;
        send({ level: "warn", message: LOG_TRUNCATION_NOTICE });
        return;
      }

      lines += 1;
      bytes += size;
      send(entry);
    },
    close() {
      closed = true;
    },
  };
}

/** The `console` methods the runner captures, and the level each one logs at. */
const CONSOLE_METHODS = [
  ["debug", "debug"],
  ["info", "info"],
  ["log", "log"],
  ["warn", "warn"],
  ["error", "error"],
] as const satisfies readonly (readonly [keyof Console, LogLevel])[];

/**
 * Routes `console.debug/info/log/warn/error` to `onEntry` and returns a
 * restore function.
 *
 * One invocation runs at a time per process, so patching `globalThis.console`
 * for the duration is safe here; it would not be in a process running handlers
 * concurrently. The caller restores in a `finally`, and only the five captured
 * methods are touched — `console.table`, timers, and `console.error`'s
 * formatting of the original object are not reimplemented. Formatting is
 * deliberately plain: arguments are stringified and joined with a space, so a
 * format specifier like `%s` is printed literally rather than interpolated.
 */
export function captureConsole(onEntry: LogSinkSend): () => void {
  const target = globalThis.console;
  const originals = CONSOLE_METHODS.map(([method]) => [method, target[method]] as const);

  for (const [method, level] of CONSOLE_METHODS) {
    target[method] = (...args: readonly unknown[]): void => {
      try {
        onEntry({ level, message: formatArgs(args) });
      } catch {
        // Console capture must never fail the invocation.
      }
    };
  }

  return () => {
    for (const [method, original] of originals) target[method] = original;
  };
}

/** Joins console arguments the way a log line reads: space-separated. */
export function formatArgs(args: readonly unknown[]): string {
  return args.map(formatValue).join(" ");
}

/**
 * A safe string for anything a handler may print: circular objects, symbols,
 * bigints, and throwing `toString`s all resolve to text instead of throwing.
 */
export function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return String(value);
  if (typeof value === "bigint") return `${String(value)}n`;

  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    try {
      return String(value);
    } catch {
      return "[unprintable]";
    }
  }
}
