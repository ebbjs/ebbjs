/**
 * Turning a handler's value into text on the wire.
 *
 * Both things a handler emits — a failure's message and a log line — cross as
 * JSON strings, and both may be handed anything: an object whose `toString`
 * throws, a circular structure, a symbol. Rendering therefore never throws; it
 * has to produce a line, because a log line or an error message is never worth
 * failing an invocation over.
 *
 * There is one renderer per job. {@link messageOf} is the short text for
 * something thrown, and {@link formatLogValue} is what a printed value looks
 * like, matching `console.log`'s JSON rendering rather than `String`'s
 * `[object Object]`, so a handler's `ctx.log` line reads the way the same value
 * printed with `console.log` does.
 */

/** Error text for a value a handler, a peer, or a transport threw. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;

  try {
    return String(error);
  } catch {
    return "[unprintable]";
  }
}

/**
 * A safe string for anything a handler may print: circular objects, symbols,
 * bigints, and throwing `toString`s all resolve to text instead of throwing.
 */
export function formatLogValue(value: unknown): string {
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

/** Joins the arguments of one printed call the way a log line reads. */
export function formatLogLine(args: readonly unknown[]): string {
  return args.map(formatLogValue).join(" ");
}
