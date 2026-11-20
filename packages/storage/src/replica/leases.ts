/**
 * The component lease table: one counted claim per `(entity, component)` value.
 *
 * A subscription acquires the components it reads and releases them on
 * unmount. The value stays resident while any lease holds it; the last release
 * makes it inactive for one grace period, then the table reports the value as
 * gone. There is no cap and no eviction by size: memory is reclaimed because
 * subscriptions end (#933).
 *
 * The table never reads or stores values — it decides residency, and `onExpire`
 * is where the owner drops the value. Acquiring an already-resident key is
 * bookkeeping only, so two callers share one copy and one read.
 */

export const DEFAULT_RESIDENCY_TTL_MS = 60_000;

/** The value a lease claims: one component of one entity. */
export interface LeaseKey {
  readonly entityId: string;
  readonly component: string;
}

/** Handle returned by {@link LeaseTimers.setTimeout}. Opaque to callers. */
export type LeaseTimerHandle = ReturnType<typeof setTimeout>;

/** Timer seam. The default uses the host's `setTimeout` / `clearTimeout`. */
export interface LeaseTimers {
  setTimeout(callback: () => void, delayMs: number): LeaseTimerHandle;
  clearTimeout(handle: LeaseTimerHandle): void;
}

/** Drops one lease. Idempotent: a second call does nothing. */
export type Release = () => void;

export interface LeaseTableOptions {
  /**
   * How long a value stays resident after its last release. Defaults to
   * {@link DEFAULT_RESIDENCY_TTL_MS}. A non-positive or non-finite value
   * disables expiry, so an inactive value stays resident until a later acquire.
   */
  readonly residencyTtlMs?: number;
  /** Timer seam. Defaults to the host `setTimeout` / `clearTimeout`. */
  readonly timers?: LeaseTimers;
  /** Millisecond clock for inactive age. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Called with the key when the inactive TTL elapses with no lease holding it:
   * the owner drops the value there. Never called while a lease is live.
   */
  readonly onExpire?: (key: LeaseKey) => void;
}

/** Residency counts for leak visibility. */
export interface LeaseStats {
  /** Keys held by at least one live lease. */
  readonly leased: number;
  /** Keys released but still inside their grace period. */
  readonly inactive: number;
  /** Keys the table still holds a value for: leased plus inactive. */
  readonly resident: number;
  /** Armed expiry timers, one per inactive key while expiry is enabled. */
  readonly timers: number;
  /** Age of the longest-inactive key, or 0 when nothing is inactive. */
  readonly oldestInactiveMs: number;
}

export interface LeaseTable {
  /**
   * Claim `key` for the caller. A resident key is shared, not re-read; a key
   * inside its grace period cancels the pending expiry. The returned release
   * is single-shot, so releasing twice cannot free a peer's lease.
   */
  acquire(key: LeaseKey): Release;
  /** Whether the table still holds a value for `key`. */
  isResident(key: LeaseKey): boolean;
  /** Live leases on `key`; 0 when it is not resident. */
  refsOf(key: LeaseKey): number;
  stats(): LeaseStats;
}

/** `(entity, component)`; the separator cannot occur in either. */
const KEY_SEPARATOR = "\u0000";
const keyOf = (key: LeaseKey): string => `${key.entityId}${KEY_SEPARATOR}${key.component}`;

/** `Infinity` disables expiry, so no timer is armed at all. */
const residencyTtlOf = (ttlMs: number | undefined): number => {
  if (ttlMs === undefined) return DEFAULT_RESIDENCY_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return Number.POSITIVE_INFINITY;
  return ttlMs;
};

/** A pending expiry must not keep a Node process alive. */
const unrefTimer = (timer: LeaseTimerHandle): void => {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    const unref = (timer as { unref?: unknown }).unref;
    if (typeof unref === "function") unref.call(timer);
  }
};

const defaultTimers: LeaseTimers = {
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    unrefTimer(handle);
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle),
};

interface LeaseEntry {
  readonly key: LeaseKey;
  refs: number;
  /** Clock time of the release to zero; `null` while leased. */
  inactiveSince: number | null;
  /** `null` while nothing is pending, including when expiry is disabled. */
  timer: LeaseTimerHandle | null;
  /**
   * Bumped when a pending timer is cancelled. An expiry carries the generation
   * it was armed for, so a callback that was already dispatched cannot free a
   * value that has been re-acquired since.
   */
  generation: number;
}

export const createLeaseTable = (options?: LeaseTableOptions): LeaseTable => {
  const residencyTtlMs = residencyTtlOf(options?.residencyTtlMs);
  const timers = options?.timers ?? defaultTimers;
  const now = options?.now ?? Date.now;
  const entries = new Map<string, LeaseEntry>();

  const clearTimer = (entry: LeaseEntry): void => {
    if (entry.timer === null) return;
    timers.clearTimeout(entry.timer);
    entry.timer = null;
    entry.generation += 1;
  };

  const expire = (id: string, generation: number): void => {
    const entry = entries.get(id);
    if (entry === undefined) return;
    if (entry.refs > 0 || entry.generation !== generation) return;
    entries.delete(id);
    options?.onExpire?.(entry.key);
  };

  /** The last release makes the value inactive; only then does a timer run. */
  const goInactive = (id: string, entry: LeaseEntry): void => {
    entry.inactiveSince = now();
    if (!Number.isFinite(residencyTtlMs)) return;
    const generation = entry.generation;
    entry.timer = timers.setTimeout(() => expire(id, generation), residencyTtlMs);
  };

  const acquire = (key: LeaseKey): Release => {
    const id = keyOf(key);
    let entry = entries.get(id);
    if (entry === undefined) {
      entry = { key, refs: 0, inactiveSince: null, timer: null, generation: 0 };
      entries.set(id, entry);
    }
    clearTimer(entry);
    entry.inactiveSince = null;
    entry.refs += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.refs -= 1;
      if (entry.refs === 0) goInactive(id, entry);
    };
  };

  const stats = (): LeaseStats => {
    const at = now();
    let leased = 0;
    let inactive = 0;
    let armed = 0;
    let oldestInactiveMs = 0;
    for (const entry of entries.values()) {
      if (entry.refs > 0) leased += 1;
      else {
        inactive += 1;
        if (entry.inactiveSince !== null) {
          oldestInactiveMs = Math.max(oldestInactiveMs, at - entry.inactiveSince);
        }
      }
      if (entry.timer !== null) armed += 1;
    }
    return { leased, inactive, resident: entries.size, timers: armed, oldestInactiveMs };
  };

  return {
    acquire,
    isResident: (key) => entries.has(keyOf(key)),
    refsOf: (key) => entries.get(keyOf(key))?.refs ?? 0,
    stats,
  };
};
