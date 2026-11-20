/**
 * Unit tests for the component lease table. The module is pure bookkeeping:
 * these tests inject a manual clock and timer queue so TTL, remount, and
 * stale-timer behaviour are asserted without real time.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createLeaseTable,
  DEFAULT_RESIDENCY_TTL_MS,
  type LeaseKey,
  type LeaseTable,
  type LeaseTableOptions,
  type LeaseTimerHandle,
  type LeaseTimers,
} from "./leases";

const content = (entityId = "n_1"): LeaseKey => ({ entityId, component: "note/content" });
const title = (entityId = "n_1"): LeaseKey => ({ entityId, component: "note/title" });

interface Harness {
  readonly leases: LeaseTable;
  advance(ms: number): void;
  /** Invoke a scheduled callback the table has already cancelled. */
  fireStale(index: number): void;
  readonly scheduled: readonly (() => void)[];
}

/**
 * Manual clock + timer queue. `advance(ms)` fires every timer due within the
 * window in due order. A cancelled timer is dropped from the queue but stays
 * in `scheduled`, so a test can dispatch one the table thinks is gone.
 */
const mkHarnessWith = (
  dependencies: Pick<LeaseTableOptions, "onExpire"> & { residencyTtlMs?: number } = {},
): Harness => {
  let clock = 0;
  let nextId = 1;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  const scheduled: (() => void)[] = [];
  const timers: LeaseTimers = {
    setTimeout: (fn, delayMs) => {
      const id = nextId++;
      tasks.set(id, { at: clock + delayMs, fn });
      scheduled.push(fn);
      return id as unknown as LeaseTimerHandle;
    },
    clearTimeout: (handle) => {
      tasks.delete(handle as unknown as number);
    },
  };
  const advance = (ms: number): void => {
    const target = clock + ms;
    for (;;) {
      const due = [...tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (due === undefined) break;
      tasks.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
    }
    clock = target;
  };
  const leases = createLeaseTable({ ...dependencies, timers, now: () => clock });
  return {
    leases,
    advance,
    fireStale: (index) => scheduled[index]?.(),
    scheduled,
  };
};

const mkHarness = (residencyTtlMs?: number): Harness => mkHarnessWith({ residencyTtlMs });

describe("createLeaseTable", () => {
  it("shares one value and one read between two callers", () => {
    const { leases } = mkHarness();
    const key = content();
    const read = vi.fn();
    const use = (): (() => void) => {
      if (!leases.isResident(key)) read(key);
      return leases.acquire(key);
    };

    const releaseA = use();
    const releaseB = use();

    expect(read).toHaveBeenCalledTimes(1);
    expect(leases.refsOf(key)).toBe(2);
    expect(leases.isResident(key)).toBe(true);
    expect(leases.stats()).toEqual({
      leased: 1,
      inactive: 0,
      resident: 1,
      timers: 0,
      oldestInactiveMs: 0,
    });

    releaseA();
    releaseB();
    expect(leases.isResident(key)).toBe(true);
    expect(leases.stats()).toMatchObject({ leased: 0, inactive: 1, resident: 1, timers: 1 });
  });

  it("keeps the value resident for the default 60s TTL after the last release", () => {
    const { leases, advance } = mkHarness();
    const key = content();

    leases.acquire(key)();

    expect(DEFAULT_RESIDENCY_TTL_MS).toBe(60_000);
    advance(DEFAULT_RESIDENCY_TTL_MS - 1);
    expect(leases.isResident(key)).toBe(true);
    expect(leases.stats().oldestInactiveMs).toBe(DEFAULT_RESIDENCY_TTL_MS - 1);

    advance(1);
    expect(leases.isResident(key)).toBe(false);
    expect(leases.refsOf(key)).toBe(0);
    expect(leases.stats().resident).toBe(0);
  });

  it("arms the TTL on the last release, not an earlier one", () => {
    const { leases, advance } = mkHarness();
    const key = content();
    const releaseA = leases.acquire(key);
    const releaseB = leases.acquire(key);

    releaseA();
    expect(leases.refsOf(key)).toBe(1);
    expect(leases.stats().timers).toBe(0);

    advance(DEFAULT_RESIDENCY_TTL_MS * 10);
    expect(leases.isResident(key)).toBe(true);

    releaseB();
    expect(leases.refsOf(key)).toBe(0);
    expect(leases.stats()).toEqual({
      leased: 0,
      inactive: 1,
      resident: 1,
      timers: 1,
      oldestInactiveMs: 0,
    });

    advance(DEFAULT_RESIDENCY_TTL_MS);
    expect(leases.isResident(key)).toBe(false);
  });

  it("cancels expiry on a remount inside the TTL and performs no read", () => {
    const { leases, advance } = mkHarness();
    const key = content();
    const read = vi.fn();
    const use = (): (() => void) => {
      if (!leases.isResident(key)) read(key);
      return leases.acquire(key);
    };

    use()();
    advance(DEFAULT_RESIDENCY_TTL_MS / 2);
    expect(leases.refsOf(key)).toBe(0);
    expect(leases.stats().timers).toBe(1);

    const release = use();
    expect(read).toHaveBeenCalledTimes(1);
    expect(leases.refsOf(key)).toBe(1);
    expect(leases.stats()).toEqual({
      leased: 1,
      inactive: 0,
      resident: 1,
      timers: 0,
      oldestInactiveMs: 0,
    });

    advance(DEFAULT_RESIDENCY_TTL_MS * 2);
    expect(leases.isResident(key)).toBe(true);

    release();
    advance(DEFAULT_RESIDENCY_TTL_MS);
    expect(leases.isResident(key)).toBe(false);
  });

  it("honours a configured residency TTL", () => {
    const { leases, advance } = mkHarness(5_000);
    const key = content();

    leases.acquire(key)();
    advance(4_999);
    expect(leases.isResident(key)).toBe(true);

    advance(1);
    expect(leases.isResident(key)).toBe(false);
  });

  it("keeps an inactive value resident when expiry is disabled", () => {
    const { leases, advance } = mkHarness(Number.POSITIVE_INFINITY);
    const key = content();

    leases.acquire(key)();
    advance(DEFAULT_RESIDENCY_TTL_MS * 100);

    expect(leases.isResident(key)).toBe(true);
    expect(leases.stats()).toEqual({
      leased: 0,
      inactive: 1,
      resident: 1,
      timers: 0,
      oldestInactiveMs: DEFAULT_RESIDENCY_TTL_MS * 100,
    });
  });

  it("cannot free a peer's lease with a double release", () => {
    const expires = vi.fn();
    const { leases, advance } = mkHarnessWith({ onExpire: expires });
    const key = content();
    const releaseA = leases.acquire(key);
    const releaseB = leases.acquire(key);

    releaseA();
    releaseA();

    expect(leases.refsOf(key)).toBe(1);
    expect(leases.stats().timers).toBe(0);
    advance(DEFAULT_RESIDENCY_TTL_MS * 10);
    expect(leases.isResident(key)).toBe(true);
    expect(expires).not.toHaveBeenCalled();

    releaseB();
    advance(DEFAULT_RESIDENCY_TTL_MS);
    expect(leases.isResident(key)).toBe(false);
    expect(expires).toHaveBeenCalledTimes(1);
  });

  it("never expires a value with a live lease", () => {
    const expires = vi.fn();
    const { leases, advance, fireStale } = mkHarnessWith({ onExpire: expires });
    const key = content();

    leases.acquire(key)();
    expect(leases.stats().timers).toBe(1);
    const release = leases.acquire(key);

    fireStale(0);

    expect(leases.isResident(key)).toBe(true);
    expect(leases.refsOf(key)).toBe(1);
    expect(expires).not.toHaveBeenCalled();

    release();
    advance(DEFAULT_RESIDENCY_TTL_MS);
    expect(leases.isResident(key)).toBe(false);
  });

  it("cannot free a re-acquired value from a stale timer", () => {
    const expires = vi.fn();
    const { leases, advance, fireStale, scheduled } = mkHarnessWith({ onExpire: expires });
    const key = content();

    leases.acquire(key)();
    leases.acquire(key)();
    expect(scheduled).toHaveLength(2);
    expect(leases.stats().timers).toBe(1);

    fireStale(0);

    expect(leases.isResident(key)).toBe(true);
    expect(expires).not.toHaveBeenCalled();

    advance(DEFAULT_RESIDENCY_TTL_MS - 1);
    expect(leases.isResident(key)).toBe(true);

    advance(1);
    expect(leases.isResident(key)).toBe(false);
    expect(expires).toHaveBeenCalledTimes(1);
  });

  it("passes the expired key to the owner that drops the value", () => {
    const expires = vi.fn();
    const { leases, advance } = mkHarnessWith({ onExpire: expires });
    const key = title("n_7");

    leases.acquire(key)();
    advance(DEFAULT_RESIDENCY_TTL_MS);

    expect(expires).toHaveBeenCalledWith({ entityId: "n_7", component: "note/title" });
  });

  it("keeps 1,000 leases resident with no trim", () => {
    const { leases, advance } = mkHarness();
    const keys = Array.from({ length: 1_000 }, (_, index) => content(`n_${index}`));
    const releases = keys.map((key) => leases.acquire(key));

    expect(leases.stats()).toEqual({
      leased: 1_000,
      inactive: 0,
      resident: 1_000,
      timers: 0,
      oldestInactiveMs: 0,
    });
    expect(keys.every((key) => leases.isResident(key) && leases.refsOf(key) === 1)).toBe(true);

    advance(DEFAULT_RESIDENCY_TTL_MS * 10);
    expect(leases.stats().resident).toBe(1_000);

    for (const release of releases) release();
    expect(leases.stats()).toEqual({
      leased: 0,
      inactive: 1_000,
      resident: 1_000,
      timers: 1_000,
      oldestInactiveMs: 0,
    });

    advance(DEFAULT_RESIDENCY_TTL_MS);
    expect(leases.stats()).toEqual({
      leased: 0,
      inactive: 0,
      resident: 0,
      timers: 0,
      oldestInactiveMs: 0,
    });
  });

  it("reports the age of the longest-inactive key", () => {
    const { leases, advance } = mkHarness();
    const older = content();
    const newer = title();

    expect(leases.stats().oldestInactiveMs).toBe(0);

    leases.acquire(older)();
    advance(1_000);
    leases.acquire(newer)();
    expect(leases.stats()).toMatchObject({ leased: 0, inactive: 2, oldestInactiveMs: 1_000 });

    advance(500);
    expect(leases.stats().oldestInactiveMs).toBe(1_500);

    leases.acquire(older);
    expect(leases.stats()).toMatchObject({ leased: 1, inactive: 1, oldestInactiveMs: 500 });
  });
});
