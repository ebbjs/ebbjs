/**
 * Exponential backoff shared by the client's two retry loops: the SSE
 * reconnect and the outbox flush. Each loop keeps its own attempt
 * counter — they fail and recover independently — but the curve itself
 * (and its ceiling) is one rule.
 */

/** Delay before retry `attempt` (0-based), capped at `maxMs`. */
export function backoffDelayMs(attempt: number, initialMs: number, maxMs: number): number {
  return Math.min(maxMs, initialMs * 2 ** attempt);
}
