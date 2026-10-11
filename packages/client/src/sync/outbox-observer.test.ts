/**
 * Unit tests for the OutboxObserver seam. The observer is pure
 * composition: these tests drive its two fake sources by hand and pin
 * the snapshot it folds, the change stream it forwards, and the
 * snapshot identity a `get()` / `subscribe()` consumer depends on.
 */

import { describe, it, expect, vi } from "vitest";

import type { OutboxChangeListener, OutboxCounts } from "./outbox";
import { createOutboxObserver, type OutboxSnapshot } from "./outbox-observer";

const zero: OutboxCounts = { pending: 0, acknowledged: 0, error: 0 };

/** Depth + latency sources whose changes the test drives directly. */
const mkHarness = () => {
  let counts: OutboxCounts = zero;
  let latency: number | null = null;
  const countListeners = new Set<OutboxChangeListener>();
  const latencyListeners = new Set<(latency: number) => void>();

  const observer = createOutboxObserver({
    outbox: {
      counts: () => counts,
      onChange: (listener) => {
        countListeners.add(listener);
        return () => {
          countListeners.delete(listener);
        };
      },
    },
    flushLatency: () => latency,
    onFlushLatency: (listener) => {
      latencyListeners.add(listener);
      return () => {
        latencyListeners.delete(listener);
      };
    },
  });

  return {
    observer,
    setCounts: (next: OutboxCounts): void => {
      counts = next;
      for (const listener of countListeners) listener(counts);
    },
    setLatency: (next: number): void => {
      latency = next;
      for (const listener of latencyListeners) listener(next);
    },
  };
};

describe("createOutboxObserver", () => {
  it("reads the composed snapshot from both sources", () => {
    const { observer, setCounts, setLatency } = mkHarness();

    expect(observer.get()).toEqual({ ...zero, flushLatency: null });

    setCounts({ pending: 2, acknowledged: 1, error: 1 });
    setLatency(12);
    expect(observer.get()).toEqual({ pending: 2, acknowledged: 1, error: 1, flushLatency: 12 });
  });

  it("keeps the snapshot identity stable until a source changes", () => {
    const { observer, setCounts } = mkHarness();
    const first = observer.get();

    expect(observer.get()).toBe(first);

    setCounts({ pending: 1, acknowledged: 0, error: 0 });
    const second = observer.get();
    expect(second).not.toBe(first);
    expect(second).toEqual({ pending: 1, acknowledged: 0, error: 0, flushLatency: null });
  });

  it("drops a source event that leaves the composed snapshot unchanged", () => {
    const { observer, setCounts } = mkHarness();
    setCounts({ pending: 1, acknowledged: 0, error: 0 });
    const listener = vi.fn();
    observer.subscribe(listener);
    const before = observer.get();

    setCounts({ pending: 1, acknowledged: 0, error: 0 });

    expect(listener).not.toHaveBeenCalled();
    expect(observer.get()).toBe(before);
  });

  it("folds a depth change from either source into one notification", () => {
    const { observer, setCounts, setLatency } = mkHarness();
    const seen: OutboxSnapshot[] = [];
    observer.subscribe((snapshot) => seen.push(snapshot));
    expect(seen).toEqual([]);

    setCounts({ pending: 3, acknowledged: 0, error: 0 });
    setLatency(7);

    expect(seen).toEqual([
      { pending: 3, acknowledged: 0, error: 0, flushLatency: null },
      { pending: 3, acknowledged: 0, error: 0, flushLatency: 7 },
    ]);
  });

  it("stops notifying after unsubscribe", () => {
    const { observer, setCounts } = mkHarness();
    const listener = vi.fn();
    const unsubscribe = observer.subscribe(listener);
    unsubscribe();

    setCounts({ pending: 1, acknowledged: 0, error: 0 });

    expect(listener).not.toHaveBeenCalled();
  });

  it("isolates a throwing subscriber from the others", () => {
    const { observer, setCounts } = mkHarness();
    const good = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    observer.subscribe(() => {
      throw new Error("subscriber blew up");
    });
    observer.subscribe(good);

    setCounts({ pending: 1, acknowledged: 0, error: 0 });

    expect(good).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
