/**
 * SPIKE S2 (#779): lease-share / release / TTL / remount, and no cap.
 *
 * Not for merge.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLeaseManager } from "./lease";

afterEach(() => vi.useRealTimers());

describe("S2: refcounted leases with one inactive TTL", () => {
  it("two subscriptions share one lease; the last release starts the TTL", () => {
    vi.useFakeTimers();
    const reads: string[] = [];
    const expired: string[] = [];
    const leases = createLeaseManager({
      ttlMs: 1_000,
      onAcquire: (key) => reads.push(key),
      onExpire: (key) => expired.push(key),
    });

    const a = leases.acquire("n_1\u0000note/content");
    const b = leases.acquire("n_1\u0000note/content");
    expect(reads).toEqual(["n_1\u0000note/content"]);
    expect(leases.refsOf("n_1\u0000note/content")).toBe(2);

    a();
    vi.advanceTimersByTime(2_000);
    // One subscriber remains, so the TTL never starts.
    expect(leases.isResident("n_1\u0000note/content")).toBe(true);
    expect(expired).toEqual([]);

    b();
    expect(expired).toEqual([]);
    expect(leases.stats()).toMatchObject({ active: 0, inactive: 1, timers: 1 });

    vi.advanceTimersByTime(999);
    expect(leases.isResident("n_1\u0000note/content")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(leases.isResident("n_1\u0000note/content")).toBe(false);
    expect(expired).toEqual(["n_1\u0000note/content"]);
    expect(leases.stats()).toMatchObject({ active: 0, inactive: 0, resident: 0, timers: 0 });
  });

  it("a remount inside the TTL cancels expiry and does not re-read", () => {
    vi.useFakeTimers();
    const reads: string[] = [];
    const leases = createLeaseManager({ ttlMs: 1_000, onAcquire: (key) => reads.push(key) });

    leases.acquire("n_1\u0000note/content")();
    vi.advanceTimersByTime(800);
    leases.acquire("n_1\u0000note/content");
    vi.advanceTimersByTime(5_000);

    expect(leases.isResident("n_1\u0000note/content")).toBe(true);
    expect(reads).toEqual(["n_1\u0000note/content"]);
    expect(leases.stats()).toMatchObject({ active: 1, inactive: 0, timers: 0, acquires: 1 });
  });

  it("has no cap: a thousand components stay resident until released", () => {
    vi.useFakeTimers();
    const leases = createLeaseManager({ ttlMs: 1_000 });
    const releases = Array.from({ length: 1_000 }, (_, index) =>
      leases.acquire(`n_${index}\u0000note/content`),
    );
    expect(leases.stats()).toMatchObject({ active: 1_000, resident: 1_000 });
    // The 1000th acquire evicted nothing, unlike the pinned-window trim.
    expect(leases.isResident("n_0\u0000note/content")).toBe(true);
    for (const release of releases) release();
    vi.advanceTimersByTime(1_000);
    expect(leases.stats()).toMatchObject({ active: 0, resident: 0 });
  });

  it("release is idempotent: a double release cannot free a peer's lease", () => {
    vi.useFakeTimers();
    const leases = createLeaseManager({ ttlMs: 1_000 });
    const release = leases.acquire("k");
    leases.acquire("k");
    release();
    release();
    expect(leases.refsOf("k")).toBe(1);
    expect(leases.isResident("k")).toBe(true);
  });
});
