/**
 * Unit tests for the flush scheduler. The module is pure policy: these
 * tests inject a manual clock and timer map so debounce, retry backoff,
 * single-flight, and `stop()` are all asserted without real time.
 */

import { describe, it, expect, vi } from "vitest";
import type { FlushOutcome } from "./outbox";
import {
  createFlushScheduler,
  type FlushScheduler,
  type FlushTimerHandle,
  type FlushTimers,
} from "./flush-scheduler";

const DEBOUNCE = 10;
const INITIAL = 100;
const MAX = 400;

const accepted = (ids: string[] = []): FlushOutcome => ({ kind: "accepted", actionIds: ids });
const unreachable = (message = "offline"): FlushOutcome => ({
  kind: "unreachable",
  error: new Error(message),
});

/** A `flush()` whose outcomes the test queues up by hand. */
const mkOutbox = () => {
  const steps: Array<() => Promise<FlushOutcome>> = [];
  let pending = 1;
  const flush = vi.fn((): Promise<FlushOutcome> => {
    const step = steps.shift();
    return step ? step() : Promise.resolve(accepted());
  });
  const size = vi.fn((): number => pending);
  const pushOutcome = (outcome: FlushOutcome): void => {
    steps.push(() => Promise.resolve(outcome));
  };
  const pushDeferred = (): { resolve: (o: FlushOutcome) => void; reject: (e: unknown) => void } => {
    let resolve!: (o: FlushOutcome) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<FlushOutcome>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    steps.push(() => promise);
    return { resolve, reject };
  };
  return {
    flush,
    size,
    pushOutcome,
    pushDeferred,
    setPending: (count: number): void => {
      pending = count;
    },
  };
};

/**
 * Manual clock + timer queue. `advance(ms)` fires every timer due within
 * the window in due order, draining microtasks between each so a settled
 * flush can arm the next one.
 */
const mkHarness = () => {
  const outbox = mkOutbox();
  let clock = 0;
  let nextId = 1;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  const timers: FlushTimers = {
    setTimeout: (fn, delayMs) => {
      const id = nextId++;
      tasks.set(id, { at: clock + delayMs, fn });
      return id as unknown as FlushTimerHandle;
    },
    clearTimeout: (handle) => {
      tasks.delete(handle as unknown as number);
    },
  };
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };
  const advance = async (ms: number): Promise<void> => {
    const target = clock + ms;
    for (;;) {
      const due = [...tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (due === undefined) break;
      tasks.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
      await drain();
    }
    clock = target;
    await drain();
  };
  const scheduler: FlushScheduler = createFlushScheduler({
    outbox,
    timers,
    now: () => clock,
    debounceMs: DEBOUNCE,
    initialMs: INITIAL,
    maxMs: MAX,
  });
  return {
    scheduler,
    outbox,
    advance,
    pendingTimers: () => tasks.size,
  };
};

describe("createFlushScheduler", () => {
  it("coalesces a burst of triggers into one flush", async () => {
    const { scheduler, outbox, advance } = mkHarness();
    outbox.pushOutcome(accepted(["a"]));

    const first = scheduler.schedule();
    const second = scheduler.schedule();
    await advance(DEBOUNCE);

    expect(outbox.flush).toHaveBeenCalledTimes(1);
    expect(await first).toEqual(accepted(["a"]));
    expect(await second).toEqual(accepted(["a"]));
  });

  it("does not flush before the debounce window elapses", async () => {
    const { scheduler, outbox, advance } = mkHarness();
    void scheduler.schedule();

    await advance(DEBOUNCE - 1);
    expect(outbox.flush).not.toHaveBeenCalled();

    await advance(1);
    expect(outbox.flush).toHaveBeenCalledTimes(1);
  });

  it("flushNow bypasses the debounce", async () => {
    const { scheduler, outbox, advance } = mkHarness();
    outbox.pushOutcome(accepted(["now"]));

    const outcome = scheduler.flushNow();
    await advance(0);

    expect(outbox.flush).toHaveBeenCalledTimes(1);
    expect(await outcome).toEqual(accepted(["now"]));
  });

  it("runs one flush at a time and settles mid-flight triggers on the next", async () => {
    const { scheduler, outbox, advance } = mkHarness();
    const first = outbox.pushDeferred();

    const p1 = scheduler.schedule();
    await advance(DEBOUNCE);
    expect(outbox.flush).toHaveBeenCalledTimes(1);

    // Arrives while the first flush is in flight; its entry was not in the
    // batch that flush snapshotted, so it must wait for the next one.
    const p2 = scheduler.schedule();
    first.resolve(accepted(["a"]));
    await advance(0);
    expect(await p1).toEqual(accepted(["a"]));
    expect(outbox.flush).toHaveBeenCalledTimes(1);

    await advance(DEBOUNCE);
    expect(outbox.flush).toHaveBeenCalledTimes(2);
    expect(await p2).toEqual(accepted());
  });

  it("retries unreachable with exponential backoff and resets on success", async () => {
    const { scheduler, outbox, advance } = mkHarness();
    outbox.pushOutcome(unreachable());
    outbox.pushOutcome(unreachable());
    outbox.pushOutcome(accepted());

    const first = scheduler.schedule();
    await advance(DEBOUNCE);
    expect(await first).toMatchObject({ kind: "unreachable" });
    expect(outbox.flush).toHaveBeenCalledTimes(1);

    await advance(INITIAL);
    expect(outbox.flush).toHaveBeenCalledTimes(2);

    await advance(INITIAL * 2);
    expect(outbox.flush).toHaveBeenCalledTimes(3);
  });

  it("caps the retry delay at maxMs", async () => {
    const { scheduler, outbox, advance } = mkHarness();
    for (let i = 0; i < 6; i += 1) outbox.pushOutcome(unreachable());

    void scheduler.schedule();
    await advance(DEBOUNCE);
    expect(outbox.flush).toHaveBeenCalledTimes(1);

    await advance(INITIAL);
    expect(outbox.flush).toHaveBeenCalledTimes(2);
    await advance(INITIAL * 2);
    expect(outbox.flush).toHaveBeenCalledTimes(3);
    // Capped from here on: each MAX interval yields exactly one more retry.
    await advance(MAX);
    expect(outbox.flush).toHaveBeenCalledTimes(4);
    await advance(MAX);
    expect(outbox.flush).toHaveBeenCalledTimes(5);
  });

  it("reports a deferred failure while a retry is backed off", async () => {
    const { scheduler, outbox, advance } = mkHarness();
    outbox.pushOutcome(unreachable("down"));

    const first = scheduler.schedule();
    await advance(DEBOUNCE);
    const outcome = await first;
    expect(outcome).toMatchObject({ kind: "unreachable" });

    const duringBackoff = scheduler.schedule();
    const deferred = await duringBackoff;
    expect(deferred).toMatchObject({ kind: "unreachable" });
    // It is a fresh deferral naming the wait, not the old batch's error.
    if (deferred.kind !== "unreachable" || outcome.kind !== "unreachable") {
      throw new Error("expected unreachable outcomes");
    }
    expect(deferred.error).not.toBe(outcome.error);
    // No competing flush: the retry timer still owns the next attempt.
    expect(outbox.flush).toHaveBeenCalledTimes(1);

    await advance(INITIAL);
    expect(outbox.flush).toHaveBeenCalledTimes(2);
  });

  it("never retries a partial outcome", async () => {
    const { scheduler, outbox, advance } = mkHarness();
    const partial: FlushOutcome = {
      kind: "partial",
      accepted: [],
      rejected: [{ id: "a", reason: "permission_denied" }],
    };
    outbox.pushOutcome(partial);

    const outcome = scheduler.schedule();
    await advance(DEBOUNCE);
    expect(await outcome).toEqual(partial);

    await advance(MAX * 10);
    expect(outbox.flush).toHaveBeenCalledTimes(1);
  });

  it("never retries an empty outcome", async () => {
    const { scheduler, outbox, advance } = mkHarness();
    outbox.pushOutcome({ kind: "empty" });

    const outcome = scheduler.schedule();
    await advance(DEBOUNCE);
    expect(await outcome).toEqual({ kind: "empty" });

    await advance(MAX * 10);
    expect(outbox.flush).toHaveBeenCalledTimes(1);
  });

  it("records flush latency from flush start to outcome", async () => {
    const { scheduler, outbox, advance } = mkHarness();
    const deferred = outbox.pushDeferred();

    const outcome = scheduler.schedule();
    await advance(DEBOUNCE); // flush starts at clock = DEBOUNCE
    expect(scheduler.flushLatency).toBeNull();

    await advance(25);
    deferred.resolve(accepted());
    await advance(0);

    expect(await outcome).toEqual(accepted());
    expect(scheduler.flushLatency).toBe(25);
  });

  it("stop cancels retries and settles pending triggers", async () => {
    const { scheduler, outbox, advance, pendingTimers } = mkHarness();
    outbox.pushOutcome(unreachable());

    const first = scheduler.schedule();
    await advance(DEBOUNCE);
    expect(await first).toMatchObject({ kind: "unreachable" });
    expect(pendingTimers()).toBe(1); // the armed retry

    scheduler.stop();
    expect(pendingTimers()).toBe(0);

    await advance(MAX * 10);
    expect(outbox.flush).toHaveBeenCalledTimes(1);

    // Terminal: a later trigger neither flushes nor reports success.
    expect(await scheduler.schedule()).toMatchObject({ kind: "unreachable" });
    expect(outbox.flush).toHaveBeenCalledTimes(1);
  });

  it("does not arm a retry once the sweep emptied the outbox", async () => {
    const { scheduler, outbox, advance, pendingTimers } = mkHarness();
    outbox.pushOutcome(unreachable());
    outbox.setPending(0);

    const outcome = scheduler.schedule();
    await advance(DEBOUNCE);
    expect(await outcome).toMatchObject({ kind: "unreachable" });

    expect(pendingTimers()).toBe(0);
    await advance(MAX * 10);
    expect(outbox.flush).toHaveBeenCalledTimes(1);
  });

  it("stop during an in-flight flush does not arm a retry", async () => {
    const { scheduler, outbox, advance, pendingTimers } = mkHarness();
    const deferred = outbox.pushDeferred();

    const outcome = scheduler.schedule();
    await advance(DEBOUNCE);
    expect(outbox.flush).toHaveBeenCalledTimes(1);

    scheduler.stop();
    deferred.resolve(unreachable());
    await advance(0);

    expect(await outcome).toMatchObject({ kind: "unreachable" });
    expect(pendingTimers()).toBe(0);
    await advance(MAX * 10);
    expect(outbox.flush).toHaveBeenCalledTimes(1);
  });

  it("flushNow during backoff flushes immediately", async () => {
    const { scheduler, outbox, advance } = mkHarness();
    outbox.pushOutcome(unreachable());
    outbox.pushOutcome(accepted(["now"]));

    void scheduler.schedule();
    await advance(DEBOUNCE);
    expect(outbox.flush).toHaveBeenCalledTimes(1);

    const forced = scheduler.flushNow();
    await advance(0);
    expect(outbox.flush).toHaveBeenCalledTimes(2);
    expect(await forced).toEqual(accepted(["now"]));
  });

  it("propagates a rejected flush without retrying it", async () => {
    const { scheduler, outbox, advance } = mkHarness();
    const deferred = outbox.pushDeferred();

    const outcome = scheduler.schedule();
    await advance(DEBOUNCE);
    deferred.reject(new Error("store down"));

    await expect(outcome).rejects.toThrow("store down");
    await advance(MAX * 10);
    expect(outbox.flush).toHaveBeenCalledTimes(1);
  });

  it("reports a deferred outcome while held, then flushes on release", async () => {
    const { scheduler, outbox, advance } = mkHarness();
    outbox.pushOutcome(accepted(["a"]));

    scheduler.hold();
    const first = await scheduler.schedule();
    const second = await scheduler.schedule();
    await advance(MAX * 10);

    expect(scheduler.ready).toBe(false);
    expect(first).toMatchObject({ kind: "unreachable" });
    expect(second).toMatchObject({ kind: "unreachable" });
    expect(outbox.flush).not.toHaveBeenCalled();

    scheduler.release();
    await advance(0);

    expect(scheduler.ready).toBe(true);
    expect(outbox.flush).toHaveBeenCalledTimes(1);
  });

  it("release flushes pending entries even with no caller waiting", async () => {
    const { scheduler, outbox, advance } = mkHarness();
    outbox.pushOutcome(accepted(["direct"]));

    scheduler.hold();
    scheduler.release();
    await advance(0);

    expect(outbox.flush).toHaveBeenCalledTimes(1);
  });

  it("hold cancels an armed debounce; release reschedules it", async () => {
    const { scheduler, outbox, advance, pendingTimers } = mkHarness();
    outbox.pushOutcome(accepted(["a"]));

    const outcome = scheduler.schedule();
    scheduler.hold();
    expect(pendingTimers()).toBe(0);

    await advance(DEBOUNCE * 4);
    expect(outbox.flush).not.toHaveBeenCalled();

    scheduler.release();
    await advance(0);
    expect(outbox.flush).toHaveBeenCalledTimes(1);
    expect(await outcome).toEqual(accepted(["a"]));
  });

  it("defers the follow-up flush until release when held mid-flight", async () => {
    const { scheduler, outbox, advance } = mkHarness();
    const deferred = outbox.pushDeferred();

    const outcome = scheduler.schedule();
    await advance(DEBOUNCE);
    expect(outbox.flush).toHaveBeenCalledTimes(1);

    scheduler.hold();
    deferred.resolve(accepted(["a"]));
    await advance(0);
    expect(await outcome).toEqual(accepted(["a"]));

    // No retry or follow-up may fire while the gate is closed.
    await advance(MAX * 10);
    expect(outbox.flush).toHaveBeenCalledTimes(1);

    scheduler.release();
    await advance(0);
    expect(outbox.flush).toHaveBeenCalledTimes(2);
  });

  it("flushNow reports a deferred outcome while held", async () => {
    const { scheduler, outbox, advance } = mkHarness();
    outbox.pushOutcome(accepted(["now"]));

    scheduler.hold();
    const outcome = await scheduler.flushNow();
    await advance(DEBOUNCE * 4);
    expect(outcome).toMatchObject({ kind: "unreachable" });
    expect(outbox.flush).not.toHaveBeenCalled();

    scheduler.release();
    await advance(0);
    expect(outbox.flush).toHaveBeenCalledTimes(1);
  });

  it("stop reports the stopped outcome while held", async () => {
    const { scheduler, outbox } = mkHarness();

    scheduler.hold();
    scheduler.stop();

    expect(await scheduler.schedule()).toMatchObject({ kind: "unreachable" });
    expect(outbox.flush).not.toHaveBeenCalled();
  });
});
