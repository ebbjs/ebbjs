/**
 * FlushScheduler — the policy that decides *when* the Outbox's
 * `flush()` runs on the primitive write path.
 *
 * The Outbox owns entry lifecycle and outcome classification; it has no
 * opinion about timing. This module sits on top of `Outbox.flush()` and
 * owns:
 *
 * - **Debounce / coalesce.** A burst of enqueues inside one window
 *   collapses to a single `flush()`, so the server sees one batched POST.
 * - **Single flight.** At most one `flush()` is in flight at a time;
 *   entries enqueued while one runs stay pending for the next.
 * - **Bounded retry.** An `unreachable` outcome (the submit threw) is
 *   retried with exponential backoff capped at `maxMs`, on an attempt
 *   counter separate from the SSE reconnect loop. Every other outcome —
 *   `accepted`, `partial`, `empty` — is terminal: `partial`'s rejections
 *   are already `error` entries awaiting application handling.
 * - **Latency.** `flushLatency` reports the wall time of the most recent
 *   `flush()` call, the source #125's metric reads.
 *
 * The outbox, the timer functions, and the clock are all injected, so
 * the policy is pure and tests drive it without real time. No I/O
 * happens here.
 *
 * The trigger set is intentionally just "a caller asked". Reconnect- and
 * catch-up-triggered flushes belong to the post-catch-up checkpoint
 * (#309), which will call into this scheduler rather than key off
 * `ConnectionState`.
 */

import type { FlushOutcome, Outbox } from "./outbox";

/** Handle returned by {@link FlushTimers.setTimeout}. Opaque to callers. */
export type FlushTimerHandle = ReturnType<typeof setTimeout>;

/** Timer seam. The default uses the host's `setTimeout` / `clearTimeout`. */
export interface FlushTimers {
  setTimeout(callback: () => void, delayMs: number): FlushTimerHandle;
  clearTimeout(handle: FlushTimerHandle): void;
}

/** Collaborators and policy knobs for {@link createFlushScheduler}. */
export interface FlushSchedulerDependencies {
  /** The flush this scheduler gates. Only `flush()` is needed. */
  outbox: Pick<Outbox, "flush">;
  /** Timer seam. Defaults to the host `setTimeout` / `clearTimeout`. */
  timers?: FlushTimers;
  /** Monotonic-ish millisecond clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Window that coalesces a burst of triggers. Defaults to 10ms. */
  debounceMs?: number;
  /** First retry delay after `unreachable`. Defaults to 1000ms. */
  initialMs?: number;
  /** Ceiling for the retry delay. Defaults to 60000ms. */
  maxMs?: number;
}

/**
 * The scheduler surface. `schedule()` is the debounced trigger the write
 * path uses; `flushNow()` forces an immediate attempt; `stop()` cancels
 * timers and is terminal.
 */
export interface FlushScheduler {
  /**
   * Ask for a flush, debounced and coalesced with any other pending
   * trigger. The returned promise resolves with the outcome of the flush
   * that carries this call's entries — a later flush if one is already in
   * flight — and rejects only if the Outbox's `flush()` rejected (a
   * durable-store fault, which is not retried blindly).
   *
   * While a retry is backed off, a trigger cannot start a competing
   * flush; it resolves with the known `unreachable` outcome and lets the
   * scheduled retry carry the entries.
   */
  schedule(): Promise<FlushOutcome>;
  /**
   * Force an immediate flush, bypassing the debounce. Shares an in-flight
   * flush's outcome when one is running.
   */
  flushNow(): Promise<FlushOutcome>;
  /**
   * Cancel pending debounce and retry timers. Terminal: later `schedule()`
   * calls resolve immediately with `empty` (no entry state changes), and
   * an in-flight `flush()` finishes without scheduling another attempt.
   */
  stop(): void;
  /** Wall time of the most recent resolved `flush()`, or `null` before one. */
  readonly flushLatency: number | null;
}

const DEFAULT_DEBOUNCE_MS = 10;
const DEFAULT_INITIAL_MS = 1_000;
const DEFAULT_MAX_MS = 60_000;

const defaultTimers: FlushTimers = {
  setTimeout: (callback, delayMs) => {
    const handle = globalThis.setTimeout(callback, delayMs);
    // A background retry must never be the reason a Node process stays
    // alive; browsers return a number and have nothing to unref.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle);
  },
};

/** One caller waiting on the outcome of a flush. */
interface FlushWaiter {
  resolve(outcome: FlushOutcome): void;
  reject(error: unknown): void;
}

/**
 * Build a scheduler over `deps.outbox.flush()`.
 *
 * The implementation is a small state machine over three fields: the
 * pending waiters, the one armed timer (debounce or retry), and the
 * in-flight flush. A flush captures the waiters present when it starts,
 * so a write that arrives mid-flight is settled by the *next* flush,
 * which is the one that actually carries its entry.
 */
export function createFlushScheduler(deps: FlushSchedulerDependencies): FlushScheduler {
  const outbox = deps.outbox;
  const timers = deps.timers ?? defaultTimers;
  const now = deps.now ?? Date.now;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const initialMs = deps.initialMs ?? DEFAULT_INITIAL_MS;
  const maxMs = deps.maxMs ?? DEFAULT_MAX_MS;

  let stopped = false;
  /** Armed debounce or retry timer, or null when idle. */
  let timer: FlushTimerHandle | null = null;
  /** The one in-flight outbox flush, or null. */
  let inFlight: Promise<FlushOutcome> | null = null;
  /** Callers waiting for the next flush to settle. */
  let waiters: FlushWaiter[] = [];
  /** Consecutive `unreachable` outcomes; drives the backoff exponent. */
  let attempt = 0;
  /** The last `unreachable`, surfaced to triggers that arrive mid-backoff. */
  let lastUnreachable: Extract<FlushOutcome, { kind: "unreachable" }> | null = null;
  let latency: number | null = null;

  const clearTimer = (): void => {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };

  const retryDelayMs = (): number => Math.min(maxMs, initialMs * 2 ** attempt);

  /**
   * Classify a settled flush: reset the backoff on any terminal outcome,
   * arm a retry after `unreachable`, and serve any waiters that arrived
   * while the flush was in flight with a follow-up debounce.
   */
  const afterSettled = (outcome: FlushOutcome): void => {
    if (stopped) return;
    if (outcome.kind === "unreachable") {
      lastUnreachable = outcome;
      const delay = retryDelayMs();
      attempt += 1;
      timer = timers.setTimeout(runFlush, delay);
      return;
    }
    attempt = 0;
    lastUnreachable = null;
    if (waiters.length > 0) {
      timer = timers.setTimeout(runFlush, debounceMs);
    }
  };

  const runFlush = (): void => {
    clearTimer();
    if (stopped || inFlight !== null) return;
    // Capture this flush's callers up front: a write that schedules while
    // the flush is in flight is not in the batch it snapshotted.
    const batch = waiters;
    waiters = [];
    const startedAt = now();
    const flush = outbox.flush();
    inFlight = flush;
    void flush.then(
      (outcome) => {
        inFlight = null;
        latency = now() - startedAt;
        for (const waiter of batch) waiter.resolve(outcome);
        afterSettled(outcome);
      },
      (error: unknown) => {
        inFlight = null;
        for (const waiter of batch) waiter.reject(error);
        // A durable-store fault is not retried blindly; a later trigger
        // retries it. Anything already waiting gets another debounce.
        if (!stopped && waiters.length > 0) {
          timer = timers.setTimeout(runFlush, debounceMs);
        }
      },
    );
  };

  const schedule = (): Promise<FlushOutcome> => {
    if (stopped) return Promise.resolve({ kind: "empty" });
    // Mid-backoff there is already an attempt on the calendar; starting a
    // competing flush would defeat the backoff. Report the known failure
    // and let the retry carry this caller's entries.
    if (inFlight === null && timer !== null && lastUnreachable !== null) {
      return Promise.resolve(lastUnreachable);
    }
    const promise = new Promise<FlushOutcome>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
    if (inFlight === null && timer === null) {
      timer = timers.setTimeout(runFlush, debounceMs);
    }
    return promise;
  };

  const flushNow = (): Promise<FlushOutcome> => {
    if (stopped) return Promise.resolve({ kind: "empty" });
    if (inFlight !== null) return inFlight;
    clearTimer();
    const promise = new Promise<FlushOutcome>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
    runFlush();
    return promise;
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearTimer();
    // Nobody is going to flush for these callers; settle them rather than
    // leaving a write() hanging on a closed client.
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) waiter.resolve({ kind: "empty" });
  };

  return {
    schedule,
    flushNow,
    stop,
    get flushLatency(): number | null {
      return latency;
    },
  };
}
