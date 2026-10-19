/**
 * Reactive query-result cache (#512).
 *
 * One cache entry per lowered {@link Query} and surface, ref-counted by its
 * subscribers and kept alive after the last one leaves so a remount reads the
 * cached result instead of re-running. The cache is the engine signal's first
 * consumer: it listens to the replica's revision journal and invalidates an
 * entry only when a change's type intersects the entry's `readTypes`
 * (coarse-first, epic decision 3).
 *
 * Status is derived, never stored ad hoc (epic decision 2):
 *
 * - `unloaded` — never run, so `data` is `undefined` (never `[]`)
 * - `stale` — a usable result exists at an older revision and a re-run is in flight
 * - `current` — the result was produced at the replica's current revision
 * - `failed` — the last run threw; sticky until a successful run
 *
 * `loading` and `error` are conveniences: `loading` is true only while no
 * usable result exists, and `error` mirrors the `failed` status. A `stale`
 * result is usable, so it keeps `loading: false` while the refresh runs.
 *
 * Subscribers are notified on a data change, a failure, or a transition to
 * `stale` while an async re-run is pending — that last one is what lets a
 * mounted view show usable-but-refreshing data. A synchronous re-run settles
 * before anyone is notified, so it never flashes `stale`. An invalidation
 * that re-runs to an equal result is otherwise silent. The cache holds
 * projected rows, so a join target change that rewrites a projection is a
 * result change even when the source rows are untouched.
 */

import type { Replica, Revision } from "@ebbjs/storage/replica";

import type { Query } from "./query";
import { planQuery } from "./query-plan";
import { createReplicaSignal, type ReplicaSignal } from "./replica-signal";

/**
 * How long a result stays cached after its last subscriber leaves. Long
 * enough that route flaps and remounts reuse held data, short enough that
 * abandoned query results do not accumulate.
 */
export const DEFAULT_QUERY_TTL_MS = 5 * 60_000;

/** Derived lifecycle of a cached query result. */
export type QueryStatus = "unloaded" | "stale" | "current" | "failed";

/**
 * The read surface a cached result belongs to. Same query on two surfaces
 * (projected rows vs. a collection's id list) keeps two entries.
 */
export type QuerySurface = "rows" | "collection";

/** What a subscriber reads: the latest result plus its derived status. */
export interface QueryResult<T> {
  /** `undefined` until the first successful run; never a stand-in empty list. */
  readonly data: readonly T[] | undefined;
  readonly status: QueryStatus;
  /** True only while no usable result exists (`unloaded`). */
  readonly loading: boolean;
  /** The failure behind `failed`; `null` in every other status. */
  readonly error: Error | null;
}

/** Options for one store subscription. */
export interface QuerySubscribeOptions {
  /**
   * Whether the first run's completion notifies this listener. Defaults to
   * true so a React store sees the result land; a public query signal passes
   * false, because it never fires on subscribe itself.
   */
  readonly initial?: boolean;
}

/** The read-and-subscribe half of one cached query. */
export interface QueryStore<T> {
  getSnapshot(): QueryResult<T>;
  subscribe(listener: () => void, options?: QuerySubscribeOptions): () => void;
}

/**
 * How to produce a result: `ready` brings the read model up to date once,
 * `isReady` reports whether it already is, and `execute` reads it. A hydrated
 * replica executes synchronously, so an invalidation re-runs in the same tick;
 * an on-demand source may return a promise, leaving the old result visible as
 * `stale` until it settles.
 */
export interface QuerySource<T> {
  ready(): Promise<void> | void;
  isReady(): boolean;
  execute(): readonly T[] | Promise<readonly T[]>;
}

export interface QueryCacheOptions {
  /** Inactive-result lifetime in milliseconds; `0` or a non-finite value disables eviction. */
  readonly ttlMs?: number;
}

export interface QueryCache {
  /**
   * Read or start the cached result for `query` on `surface`. Two chains that
   * lower to the same query and surface share one entry and one result.
   */
  watch<T>(surface: QuerySurface, query: Query, source: QuerySource<T>): QueryStore<T>;
}

interface CacheEntry<T> {
  readonly readTypes: ReadonlySet<string>;
  readonly source: QuerySource<T>;
  data: readonly T[] | undefined;
  error: Error | null;
  /** Revision the data was produced at; `null` until the first success. */
  revision: Revision | null;
  snapshot: QueryResult<T>;
  /** Each listener, whether it wants the first run, and the revision it joined at. */
  readonly listeners: Map<() => void, { initial: boolean; revision: Revision }>;
  /** Subscriber refcount; the entry stays cached at zero until its TTL. */
  refs: number;
  /** Inactive-entry eviction timer; `null` while subscribed or after expiry. */
  evictTimer: ReturnType<typeof setTimeout> | null;
  running: boolean;
}

/**
 * Type-tagged, key-sorted encoding of a query value. `JSON.stringify` alone
 * drops `undefined` and flattens a `Date` / `NaN`, which would let two
 * different predicates share one cache entry.
 */
const encode = (value: unknown): string => {
  if (value === undefined) return "u";
  if (value === null) return "n";
  if (typeof value === "number") return `d:${Object.is(value, -0) ? "-0" : String(value)}`;
  if (typeof value === "string") return `s:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return value ? "t" : "f";
  if (value instanceof Date) return `D:${value.getTime()}`;
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key])}`).join(",")}}`;
  }
  // Functions and symbols cannot appear in a lowered query; a stable tag
  // keeps the key total rather than throwing.
  return `x:${String(value)}`;
};

/** The cache key: surface plus the canonical form of the lowered query. */
export const queryKey = (surface: QuerySurface, query: Query): string =>
  `${surface}\n${encode(query)}`;

/** Structural equality over the result rows, which are plain JSON values. */
const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) && a.length === b.length && a.every((entry, i) => sameValue(entry, b[i]))
    );
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(b, key) &&
          sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    );
  }
  return false;
};

const sameRows = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((row, i) => sameValue(row, b[i]));

const toError = (thrown: unknown): Error =>
  thrown instanceof Error ? thrown : new Error(String(thrown));

const initialSnapshot = <T>(): QueryResult<T> => ({
  data: undefined,
  status: "unloaded",
  loading: true,
  error: null,
});

/** Build the cache over a live replica. */
export const createQueryCache = (
  replica: Replica,
  signal: ReplicaSignal = createReplicaSignal(replica),
  options: QueryCacheOptions = {},
): QueryCache => {
  const entries = new Map<string, CacheEntry<unknown>>();
  const ttlMs = options.ttlMs ?? DEFAULT_QUERY_TTL_MS;

  const cancelEviction = (entry: CacheEntry<unknown>): void => {
    if (entry.evictTimer === null) return;
    clearTimeout(entry.evictTimer);
    entry.evictTimer = null;
  };

  const scheduleEviction = (key: string, entry: CacheEntry<unknown>): void => {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || entry.evictTimer !== null) return;
    entry.evictTimer = setTimeout(() => {
      entry.evictTimer = null;
      if (entry.refs === 0 && entry.listeners.size === 0) entries.delete(key);
    }, ttlMs);
    // A pending result must not keep a Node process alive.
    (entry.evictTimer as { unref?: () => void }).unref?.();
  };

  const statusOf = <T>(entry: CacheEntry<T>): QueryStatus => {
    if (entry.error !== null) return "failed";
    if (entry.data === undefined) return "unloaded";
    if (entry.revision === replica.revision) return "current";
    return "stale";
  };

  /**
   * Replace the snapshot only when a visible field changed, so
   * `useSyncExternalStore` reads a stable reference between result changes.
   */
  const refresh = <T>(entry: CacheEntry<T>): void => {
    const status = statusOf(entry);
    const error = status === "failed" ? entry.error : null;
    const current = entry.snapshot;
    if (current.data === entry.data && current.status === status && current.error === error) return;
    entry.snapshot = { data: entry.data, status, loading: status === "unloaded", error };
  };

  /**
   * Whether a journal window can touch the entry. An empty window on an
   * advanced revision is a journal gap (a replica `load`), so treat it as
   * relevant; otherwise intersect the changed types with `readTypes`.
   */
  const isRelevant = <T>(entry: CacheEntry<T>, from: Revision): boolean => {
    if (replica.revision === from) return false;
    const changes = replica.changesSince(from);
    return changes.length === 0 || changes.some((change) => entry.readTypes.has(change.type));
  };

  const notifyAll = <T>(entry: CacheEntry<T>): void => {
    // Snapshot so a listener that unsubscribes mid-fan-out cannot skip a peer.
    for (const listener of Array.from(entry.listeners.keys())) listener();
  };

  /**
   * The first run is a priming, not a re-emit: only listeners that opted into
   * it fire — plus a listener that joined before a relevant change landed, so
   * a subscribe that races the first run still wakes for the change it saw.
   */
  const notifyInitial = <T>(entry: CacheEntry<T>): void => {
    for (const [listener, state] of Array.from(entry.listeners)) {
      if (state.initial) {
        listener();
        continue;
      }
      // A listener that joined before a relevant change landed sees the
      // first settle even though it opted out of the priming: that change is
      // what its subscription is about.
      if (isRelevant(entry, state.revision)) listener();
    }
  };

  /** Retry a failed entry rather than leaving it stuck until the next change. */
  const retry = <T>(entry: CacheEntry<T>): void => {
    if (entry.error !== null && entry.data === undefined && !entry.running) hydrate(entry);
  };

  /**
   * Run the source and settle the entry. `revision` is read before execution
   * starts, so a change that lands while the promise is pending is detected by
   * comparing it with the replica's revision after the result applies.
   */
  const execute = <T>(entry: CacheEntry<T>, revision: Revision): void => {
    const hadData = entry.data !== undefined;
    const hadError = entry.error !== null;
    const startedStale = entry.snapshot.status === "stale";
    let publishedStale = false;
    entry.running = true;
    refresh(entry);

    const settle = (data: readonly T[]): void => {
      entry.running = false;
      const changed = !hadData || !sameRows(entry.data ?? [], data);
      // Keep the previous array on an equal re-run so the snapshot's data
      // reference — and therefore `useSyncExternalStore`'s read — is stable.
      if (changed) entry.data = data;
      entry.error = null;
      entry.revision = revision;
      refresh(entry);
      // A view that saw `stale` must see the settle even when the rows are
      // equal, or it would stay stale.
      if (!hadData) notifyInitial(entry);
      else if (changed || hadError || startedStale || publishedStale) notifyAll(entry);
      // Changes that landed during the run were skipped by the invalidation
      // sweep, so settle from the current revision before standing down.
      if (replica.revision !== revision) reconcile(entry, replica.revision);
    };

    const fail = (thrown: unknown): void => {
      entry.running = false;
      const error = toError(thrown);
      const changed = entry.error?.message !== error.message;
      entry.error = error;
      refresh(entry);
      if (changed || startedStale || publishedStale) {
        if (hadData) notifyAll(entry);
        else notifyInitial(entry);
      }
      if (replica.revision !== revision) reconcile(entry, replica.revision);
    };

    let result: readonly T[] | Promise<readonly T[]>;
    try {
      result = entry.source.execute();
    } catch (thrown) {
      fail(thrown);
      return;
    }
    if (result instanceof Promise) {
      result.then(settle, fail);
      // Only publish `stale` once the run is genuinely pending. A source that
      // settles in the next microtask (an already-materialized read behind an
      // async signature) flips to `current` first, so an equal re-run stays
      // silent; a slow refresh lets a mounted view show the usable result.
      queueMicrotask(() => {
        const stillStale = entry.snapshot.status === "stale";
        if (!entry.running || !hadData || startedStale || !stillStale) return;
        publishedStale = true;
        notifyAll(entry);
      });
      return;
    }
    settle(result);
  };

  /** Bring a never-run entry up to date, then run it. */
  const hydrate = <T>(entry: CacheEntry<T>): void => {
    if (entry.running) return;
    if (entry.source.isReady()) {
      execute(entry, replica.revision);
      return;
    }
    entry.running = true;
    const failed = (thrown: unknown): void => {
      entry.running = false;
      const error = toError(thrown);
      entry.error = error;
      refresh(entry);
      notifyInitial(entry);
    };
    const ready = entry.source.ready();
    if (ready instanceof Promise) {
      ready.then(() => {
        entry.running = false;
        execute(entry, replica.revision);
      }, failed);
      return;
    }
    entry.running = false;
    execute(entry, replica.revision);
  };

  /**
   * Reconcile one entry against a revision. A journal gap (an empty change
   * list on an advanced revision) means the replica was replaced wholesale, so
   * every entry re-runs.
   */
  const reconcile = <T>(entry: CacheEntry<T>, revision: Revision): void => {
    if (entry.running) return;
    if (entry.data === undefined) {
      if (entry.refs === 0) return;
      if (entry.error !== null && isRelevant(entry, entry.revision ?? 0)) retry(entry);
      return;
    }
    if (entry.revision === revision) return;
    // An entry with no subscribers is not refreshed in the background: it
    // stays `stale` (or `failed`) so a remount reads the cached result and
    // the re-run happens when someone is actually listening. #499 owns
    // evicting it.
    if (entry.refs === 0) {
      refresh(entry);
      return;
    }
    if (entry.revision !== null && !isRelevant(entry, entry.revision)) {
      entry.revision = revision;
      refresh(entry);
      return;
    }
    execute(entry, revision);
  };

  signal.subscribe((_changes, revision) => {
    for (const entry of entries.values()) reconcile(entry, revision);
  });

  return {
    watch<T>(surface: QuerySurface, query: Query, source: QuerySource<T>): QueryStore<T> {
      const key = queryKey(surface, query);
      let entry = entries.get(key);
      if (entry === undefined) {
        const created: CacheEntry<unknown> = {
          readTypes: new Set(planQuery(query).readTypes),
          // SAFETY: the entry erases the result type; `watch` restores it at
          // the store boundary, and every key maps to one surface's shape.
          source: source as QuerySource<unknown>,
          data: undefined,
          error: null,
          revision: null,
          snapshot: initialSnapshot(),
          listeners: new Map(),
          refs: 0,
          evictTimer: null,
          running: false,
        };
        entries.set(key, created);
        entry = created;
      }
      const settled: CacheEntry<unknown> = entry;
      return {
        // SAFETY: one key maps to one surface's result shape; the entry
        // erased it only so the cache can hold heterogeneous results.
        getSnapshot: () => settled.snapshot as QueryResult<T>,
        subscribe(listener, subscribeOptions) {
          if (settled.refs === 0) cancelEviction(settled);
          settled.listeners.set(listener, {
            initial: subscribeOptions?.initial ?? true,
            revision: replica.revision,
          });
          settled.refs += 1;
          if (settled.running) {
            // An in-flight run will settle against the current revision.
          } else if (settled.data === undefined) {
            hydrate(settled);
          } else if (settled.error !== null || settled.revision !== replica.revision) {
            // A remount sees the cached (possibly stale) result first; the
            // re-run settles in the same tick for a hydrated replica.
            execute(settled, replica.revision);
          }
          return () => {
            if (!settled.listeners.delete(listener)) return;
            settled.refs -= 1;
            if (settled.refs === 0) scheduleEviction(key, settled);
          };
        },
      };
    },
  };
};

/**
 * A one-off store for a chain that does not live in the engine cache (a
 * candidate builder over an already-materialized list). It runs on the first
 * subscriber, then replays its settled snapshot to later ones.
 */
export const createLocalQueryStore = <T>(run: () => Promise<readonly T[]>): QueryStore<T> => {
  let snapshot: QueryResult<T> = initialSnapshot();
  const listeners = new Set<() => void>();
  let started = false;
  const publish = (next: QueryResult<T>): void => {
    snapshot = next;
    // Snapshot so a listener that unsubscribes mid-fan-out cannot skip a peer.
    for (const listener of Array.from(listeners)) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      if (!started) {
        started = true;
        run().then(
          (data) => publish({ data, status: "current", loading: false, error: null }),
          (thrown: unknown) =>
            publish({ data: undefined, status: "failed", loading: false, error: toError(thrown) }),
        );
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
