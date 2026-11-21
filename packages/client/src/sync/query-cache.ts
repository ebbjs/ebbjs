/**
 * Reactive query-result cache (#512).
 *
 * One cache entry per lowered {@link Query} and surface, ref-counted by its
 * subscribers and kept alive after the last one leaves so a remount reads the
 * cached result instead of re-running.
 *
 * An entry's live half is a subscription in the registry (#937): the registry
 * dispatches the changes that touch the entry's reads, and the entry claims the
 * components its result projected for as long as it is subscribed. Unsubscribing
 * releases those claims, which starts the residency grace period, while the
 * cached result itself stays for `ttlMs` — so a remount before it expires reads
 * nothing from the store and re-runs only when a relevant change landed.
 *
 * What a result reads depends on what it keeps. A `rows` result holds whole
 * projected rows, so it reads every component of its source and joined models;
 * a `collection` result holds only the matching id list, so it reads the
 * components its plan names. A query that cannot name the components it depends
 * on reads its model whole (`<model>/*`), the coarse fallback a change that
 * names no component answers.
 *
 * Status is derived, never stored ad hoc:
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

import { componentModel, structuralEqual } from "@ebbjs/core";
import type { Replica, Revision } from "@ebbjs/storage/replica";

import type { Query } from "./query";
import {
  compileReadComponents,
  planQuery,
  rowReadComponentsFor,
  type CompiledReadComponents,
} from "./query-plan";
import {
  createSubscriptionRegistry,
  touchesReadSet,
  type Dependency,
  type Subscription,
  type SubscriptionRegistry,
} from "./subscriptions";
import { keyOf } from "./keys";

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
  /** The cache key this result is held under, and its registry sharing key. */
  readonly key: string;
  readonly surface: QuerySurface;
  /** Component names this result reads, as declared by the query. */
  readonly readNames: readonly string[];
  /** The same read set compiled for change matching. */
  readonly reads: CompiledReadComponents;
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
  /** The registry entry held while at least one listener is attached. */
  live: LiveSubscription | null;
}

/** A registry entry plus the detach for this cache entry's change listener. */
interface LiveSubscription {
  readonly subscription: Subscription<QueryResult<unknown>>;
  readonly detach: () => void;
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
  keyOf(surface, encode(query));

const sameRows = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((row, i) => structuralEqual(row, b[i]));

const toError = (thrown: unknown): Error =>
  thrown instanceof Error ? thrown : new Error(String(thrown));

const initialSnapshot = <T>(): QueryResult<T> => ({
  data: undefined,
  status: "unloaded",
  loading: true,
  error: null,
});

/** Build the cache over a live replica and the registry its reads live in. */
export const createQueryCache = (
  replica: Replica,
  subscriptions: SubscriptionRegistry = createSubscriptionRegistry(replica),
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

  /**
   * The revision the cached result reflects. While the entry is subscribed the
   * registry's cursor owns it, so a batch the entry is not touched by still
   * advances it; once unsubscribed the last cursor is kept for the remount.
   */
  const revisionOf = (entry: CacheEntry<unknown>): Revision | null =>
    entry.live?.subscription.cursor ?? entry.revision;

  const statusOf = <T>(entry: CacheEntry<T>): QueryStatus => {
    if (entry.error !== null) return "failed";
    if (entry.data === undefined) return "unloaded";
    if (revisionOf(entry) === replica.revision) return "current";
    return "stale";
  };

  /**
   * Replace the snapshot only when a visible field changed, so
   * `useSyncExternalStore` reads a stable reference between result changes.
   * The live subscription publishes the same snapshot, so the registry holds
   * the result its entry currently stands for.
   */
  const refresh = <T>(entry: CacheEntry<T>): void => {
    const status = statusOf(entry);
    const error = status === "failed" ? entry.error : null;
    const current = entry.snapshot;
    if (current.data === entry.data && current.status === status && current.error === error) return;
    entry.snapshot = { data: entry.data, status, loading: status === "unloaded", error };
    entry.live?.subscription.publish(entry.snapshot);
  };

  /**
   * Whether a journal window can touch the entry. An empty window on an
   * advanced revision is a journal gap (a replica `load`), so treat it as
   * relevant; otherwise test the changed components against the entry's
   * compiled reads.
   */
  const isRelevant = <T>(entry: CacheEntry<T>, from: Revision): boolean => {
    if (replica.revision === from) return false;
    const changes = replica.changesSince(from);
    return changes.length === 0 || changes.some((change) => touchesReadSet(entry.reads, change));
  };

  /**
   * The values a result keeps resident: for each row it touches, the resident
   * components its read set names. A whole-model read (`todo/*`) names every
   * component of that model, so the row's own components are claimed; an exact
   * read (`todo/status`) claims only the ones the row carries. Claims are not a
   * projection: the row's other components stay wherever the policy put them.
   */
  const dependenciesOf = <T>(entry: CacheEntry<T>): readonly Dependency[] => {
    const data = entry.data;
    if (data === undefined) return [];
    const ids =
      entry.surface === "collection"
        ? (data as readonly string[])
        : (data as readonly { readonly id: string }[]).map((row) => row.id);
    const dependencies: Dependency[] = [];
    for (const id of new Set(ids)) {
      if (replica.get(id) === undefined) continue;
      const components = replica
        .residentComponents(id)
        .filter(
          (component) =>
            entry.reads.components.has(component) ||
            entry.reads.models.has(componentModel(component)),
        );
      if (components.length > 0) dependencies.push({ id, components });
    }
    return dependencies;
  };

  /** Hand the registry the result the entry now holds and the claims it needs. */
  const syncLive = <T>(entry: CacheEntry<T>): void => {
    const live = entry.live;
    if (live === null || entry.revision === null) return;
    live.subscription.seek(entry.revision);
    live.subscription.depend(dependenciesOf(entry));
  };

  /** Start the live half of an entry: its registry subscription and claims. */
  const openLive = (entry: CacheEntry<unknown>): void => {
    if (entry.live !== null) return;
    const subscription = subscriptions.open<QueryResult<unknown>>({
      kind: "query",
      key: entry.key,
      reads: entry.readNames,
    });
    subscription.publish(entry.snapshot);
    const detach = subscription.onChange((_changes, revision) => reconcile(entry, revision));
    entry.live = { subscription, detach };
    syncLive(entry);
  };

  /** End the live half: the registry releases every claim the entry held. */
  const closeLive = (entry: CacheEntry<unknown>): void => {
    const live = entry.live;
    if (live === null) return;
    // The cursor is the revision the cached result reflects; keep it for the
    // remount, which sees `stale` if anything relevant landed meanwhile.
    entry.revision = live.subscription.cursor;
    entry.live = null;
    live.detach();
    live.subscription.release();
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
      syncLive(entry);
      refresh(entry);
      // A view that saw `stale` must see the settle even when the rows are
      // equal, or it would stay stale.
      if (!hadData) notifyInitial(entry);
      else if (changed || hadError || startedStale || publishedStale) notifyAll(entry);
      // A change that landed while this run was in flight was not reconciled
      // (a running entry is left alone), so settle from the current revision
      // before standing down.
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
    try {
      const settled = entry.source.ready();
      if (settled instanceof Promise) {
        settled.then(() => {
          entry.running = false;
          execute(entry, replica.revision);
        }, failed);
        return;
      }
    } catch (thrown) {
      // A source that cannot prime is a failed result, not a subscribe that
      // throws: the caller keeps its unsubscribe path and its claims go away.
      failed(thrown);
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
    // the re-run happens when someone is actually listening. The inactive
    // TTL evicts it.
    if (entry.refs === 0) {
      refresh(entry);
      return;
    }
    if (entry.revision !== null && !isRelevant(entry, entry.revision)) {
      entry.revision = revision;
      entry.live?.subscription.seek(revision);
      refresh(entry);
      return;
    }
    execute(entry, revision);
  };

  return {
    watch<T>(surface: QuerySurface, query: Query, source: QuerySource<T>): QueryStore<T> {
      const key = queryKey(surface, query);
      let entry = entries.get(key);
      if (entry === undefined) {
        // A collection result keeps ids, a projected row keeps the whole shape;
        // only the latter needs the source and joined models read whole.
        const readNames =
          surface === "rows" ? rowReadComponentsFor(query) : planQuery(query).readComponents;
        const created: CacheEntry<unknown> = {
          key,
          surface,
          readNames,
          reads: compileReadComponents(readNames),
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
          live: null,
        };
        entries.set(key, created);
        entry = created;
      }
      const settled: CacheEntry<unknown> = entry;
      return {
        // SAFETY: one key maps to one surface's result shape; the entry
        // erased it only so the cache can hold heterogeneous results.
        //
        // Status is derived from the replica's revision, and an entry with no
        // subscribers has no dispatch left to refresh it, so reading recomputes
        // it: a cached result that missed changes reads back `stale`.
        getSnapshot: () => {
          refresh(settled);
          return settled.snapshot as QueryResult<T>;
        },
        subscribe(listener, subscribeOptions) {
          if (settled.refs === 0) cancelEviction(settled);
          settled.refs += 1;
          settled.listeners.set(listener, {
            initial: subscribeOptions?.initial ?? true,
            revision: replica.revision,
          });
          openLive(settled);
          try {
            if (settled.running) {
              // An in-flight run will settle against the current revision.
            } else if (settled.data === undefined) {
              hydrate(settled);
            } else if (settled.error !== null || settled.revision !== replica.revision) {
              // A remount sees the cached (possibly stale) result first; the
              // re-run settles in the same tick for a hydrated replica.
              execute(settled, replica.revision);
            }
          } catch (thrown) {
            // A listener that throws on the first result, or a source that
            // throws outside its own run, must not leave a claim with no
            // handle left to release it.
            settled.listeners.delete(listener);
            settled.refs -= 1;
            if (settled.refs === 0) {
              closeLive(settled);
              scheduleEviction(key, settled);
            }
            throw thrown;
          }
          return () => {
            if (!settled.listeners.delete(listener)) return;
            settled.refs -= 1;
            if (settled.refs === 0) {
              closeLive(settled);
              scheduleEviction(key, settled);
            }
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
