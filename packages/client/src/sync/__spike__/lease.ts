/**
 * SPIKE S2 (#779): a refcounted lease manager with one inactive TTL.
 *
 * Throwaway model of the target residency primitive. No cap and no LRU: a
 * `(row, component)` is resident while at least one lease holds it, and for
 * `ttlMs` after the last release. A remount inside the window cancels the
 * timer and reuses the value.
 *
 * Not exported, not imported by production code.
 */

export interface LeaseManagerOptions {
  /** Inactive lifetime in ms; `Infinity` releases on last release immediately. */
  readonly ttlMs: number;
  /** Called when a key first becomes resident (the store read). */
  readonly onAcquire?: (key: string) => void;
  /** Called when the value actually leaves memory (TTL expiry or immediate). */
  readonly onExpire?: (key: string) => void;
}

export interface LeaseStats {
  /** Keys with at least one lease. */
  readonly active: number;
  /** Keys with no lease, waiting out the TTL. */
  readonly inactive: number;
  /** Active + inactive: everything whose value is in memory. */
  readonly resident: number;
  /** Keys whose value is in memory with a TTL timer armed. */
  readonly timers: number;
  readonly acquires: number;
  readonly expires: number;
}

export interface LeaseManager {
  /** Take one lease on `key`, acquiring it first if it is not resident. */
  acquire(key: string): () => void;
  isResident(key: string): boolean;
  refsOf(key: string): number;
  stats(): LeaseStats;
  dispose(): void;
}

interface Entry {
  refs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export const createLeaseManager = (options: LeaseManagerOptions): LeaseManager => {
  const entries = new Map<string, Entry>();
  let acquires = 0;
  let expires = 0;

  const expire = (key: string): void => {
    const entry = entries.get(key);
    if (entry === undefined || entry.refs > 0) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entries.delete(key);
    expires += 1;
    options.onExpire?.(key);
  };

  const cancelTimer = (entry: Entry): void => {
    if (entry.timer === null) return;
    clearTimeout(entry.timer);
    entry.timer = null;
  };

  return {
    acquire(key) {
      let entry = entries.get(key);
      if (entry === undefined) {
        entry = { refs: 0, timer: null };
        entries.set(key, entry);
        acquires += 1;
        options.onAcquire?.(key);
      } else {
        // A remount inside the TTL: the value never left, so no store read.
        cancelTimer(entry);
      }
      entry.refs += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = entries.get(key);
        if (current === undefined) return;
        current.refs -= 1;
        if (current.refs > 0) return;
        if (!Number.isFinite(options.ttlMs)) {
          expire(key);
          return;
        }
        current.timer = setTimeout(() => expire(key), options.ttlMs);
      };
    },
    isResident: (key) => entries.has(key),
    refsOf: (key) => entries.get(key)?.refs ?? 0,
    stats: () => {
      let active = 0;
      let inactive = 0;
      let timers = 0;
      for (const entry of entries.values()) {
        if (entry.refs > 0) active += 1;
        else inactive += 1;
        if (entry.timer !== null) timers += 1;
      }
      return { active, inactive, resident: active + inactive, timers, acquires, expires };
    },
    dispose() {
      for (const entry of entries.values()) cancelTimer(entry);
      entries.clear();
    },
  };
};
