/**
 * Unit tests for the OutboxObserver seam. The observer is pure
 * composition: these tests drive its two fake sources by hand and pin
 * the snapshot it folds, the change stream it forwards, and the
 * snapshot identity a `get()` / `subscribe()` consumer depends on.
 */

import { describe, it, expect, vi } from "vitest";

import type { OutboxChangeListener, OutboxCounts, StoreFaultListener } from "./outbox";
import { createOutboxObserver, type OutboxSnapshot } from "./outbox-observer";

/** The count defaults; a test overrides only the depth it drives. */
const counts = (overrides: Partial<OutboxCounts> = {}): OutboxCounts => ({
  pending: 0,
  acknowledged: 0,
  error: 0,
  conflicted: 0,
  ...overrides,
});

/** Depth + latency sources whose changes the test drives directly. */
const mkHarness = () => {
  let current: OutboxCounts = counts();
  let latency: number | null = null;
  let faults = 0;
  const countListeners = new Set<OutboxChangeListener>();
  const latencyListeners = new Set<(latency: number) => void>();
  const faultListeners = new Set<StoreFaultListener>();

  const observer = createOutboxObserver({
    outbox: {
      counts: () => current,
      onChange: (listener) => {
        countListeners.add(listener);
        return () => {
          countListeners.delete(listener);
        };
      },
      storeFaults: () => faults,
      onStoreFault: (listener) => {
        faultListeners.add(listener);
        return () => {
          faultListeners.delete(listener);
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
      current = next;
      for (const listener of countListeners) listener(current);
    },
    setLatency: (next: number): void => {
      latency = next;
      for (const listener of latencyListeners) listener(next);
    },
    raiseFault: (actionId = "a_1"): void => {
      faults += 1;
      for (const listener of faultListeners) listener({ actionId, error: new Error("store down") });
    },
  };
};

describe("createOutboxObserver", () => {
  it("reads the composed snapshot from both sources", () => {
    const { observer, setCounts, setLatency } = mkHarness();

    expect(observer.get()).toEqual({ ...counts(), flushLatency: null, storeFaults: 0 });

    setCounts(counts({ pending: 2, acknowledged: 1, error: 1, conflicted: 1 }));
    setLatency(12);
    expect(observer.get()).toEqual({
      ...counts({ pending: 2, acknowledged: 1, error: 1, conflicted: 1 }),
      flushLatency: 12,
      storeFaults: 0,
    });
  });

  it("keeps the snapshot identity stable until a source changes", () => {
    const { observer, setCounts } = mkHarness();
    const first = observer.get();

    expect(observer.get()).toBe(first);

    setCounts(counts({ pending: 1 }));
    const second = observer.get();
    expect(second).not.toBe(first);
    expect(second).toEqual({ ...counts({ pending: 1 }), flushLatency: null, storeFaults: 0 });
  });

  it("drops a source event that leaves the composed snapshot unchanged", () => {
    const { observer, setCounts } = mkHarness();
    setCounts(counts({ pending: 1 }));
    const listener = vi.fn();
    observer.subscribe(listener);
    const before = observer.get();

    setCounts(counts({ pending: 1 }));

    expect(listener).not.toHaveBeenCalled();
    expect(observer.get()).toBe(before);
  });

  it("folds a depth change from either source into one notification", () => {
    const { observer, setCounts, setLatency } = mkHarness();
    const seen: OutboxSnapshot[] = [];
    observer.subscribe((snapshot) => seen.push(snapshot));
    expect(seen).toEqual([]);

    setCounts(counts({ pending: 3 }));
    setLatency(7);

    expect(seen).toEqual([
      { ...counts({ pending: 3 }), flushLatency: null, storeFaults: 0 },
      { ...counts({ pending: 3 }), flushLatency: 7, storeFaults: 0 },
    ]);
  });

  it("surfaces a store fault without a depth change", () => {
    const { observer, raiseFault } = mkHarness();
    const listener = vi.fn();
    observer.subscribe(listener);

    raiseFault("a_1");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(observer.get().storeFaults).toBe(1);
  });

  it("notifies on a conflict-count change with no pending change", () => {
    const { observer, setCounts } = mkHarness();
    setCounts(counts({ pending: 1 }));
    const listener = vi.fn();
    observer.subscribe(listener);

    setCounts(counts({ pending: 1, conflicted: 1 }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(observer.get().conflicted).toBe(1);
  });

  it("stops notifying after unsubscribe", () => {
    const { observer, setCounts } = mkHarness();
    const listener = vi.fn();
    const unsubscribe = observer.subscribe(listener);
    unsubscribe();

    setCounts(counts({ pending: 1 }));

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

    setCounts(counts({ pending: 1 }));

    expect(good).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
