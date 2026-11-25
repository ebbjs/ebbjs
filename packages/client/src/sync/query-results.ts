/**
 * Reactive query results (#512): the results view over the subscription
 * registry (#941).
 *
 * A result lives on its registry entry, not here. The registry holds one entry
 * per lowered {@link Query} and surface, and that entry is the result: its
 * snapshot, its revision, and the leases its dependencies need. This module
 * only drives one — it runs the source, derives the result status, and tells
 * the registry what to hold — so the lifetime question has one answer.
 *
 * While a subscriber is attached the entry is live: the registry dispatches the
 * changes that touch its reads, and the entry claims the components its result
 * projected. When the last subscriber leaves the entry goes inactive, still
 * owning those claims, and the result and claims end together when the one
 * residency TTL elapses (default 60s). A remount inside it reads the result
 * back with no store read and no re-run, unless a change that touched the read
 * set landed meanwhile; then the result is `stale` and the remount re-runs once.
 *
 * What a result reads is the query's selection (#940): a `rows` result reads
 * the selected components, its predicates and ordering, its joined targets, and
 * membership for `groupIds`; a query with no selection reads its source model
 * whole. A `collection` result holds only the matching id list, so it reads the
 * components its plan names.
 *
 * A change is one of two kinds (#939). A content change names the components it
 * touched, so a result re-runs only when one of them is in its read set. A
 * membership change is a row entering or leaving a model's set and names no
 * component: the model is the dependency, so every read that observes that
 * model's row set re-runs.
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
 * that re-runs to an equal result is otherwise silent. The result holds
 * projected rows, so a join target change that rewrites a projection is a
 * result change even when the source rows are untouched.
 */

import { componentModel, structuralEqual } from "@ebbjs/core";
import type { Replica, ReplicaChange, Revision } from "@ebbjs/storage/replica";

import type { Query } from "./query";
import { patchResultRows, patchShapeOf, type PatchShape } from "./query-execute";
import { compileReadComponents, planQuery, type CompiledReadComponents } from "./query-plan";
import { queryResultKey, selectionReadComponents, structuralReads } from "./selection";
import {
  createSubscriptionRegistry,
  patchableRows,
  touchesReadSet,
  type Dependency,
  type Subscription,
  type SubscriptionRegistry,
  type SubscriptionSpec,
  type SubscriptionWriter,
} from "./subscriptions";

/** Derived lifecycle of a query result. */
export type QueryStatus = "unloaded" | "stale" | "current" | "failed";

/**
 * The read surface a result belongs to. Same query on two surfaces (projected
 * rows vs. a collection's id list) keeps two entries.
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
   * true so a React store sees the result land; a public change listener
   * passes false, because it reports change events and never fires on
   * subscribe itself.
   */
  readonly initial?: boolean;
}

/** The read-and-subscribe half of one query result. */
export interface QueryStore<T> {
  getSnapshot(): QueryResult<T>;
  subscribe(listener: () => void, options?: QuerySubscribeOptions): () => void;
}

/**
 * How to produce a result: `ready` brings the read model up to date once,
 * `isReady` reports whether it already is, and `execute` reads it. A hydrated
 * replica executes synchronously, so an invalidation re-runs in the same tick;
 * a store-backed source may return a promise, leaving the old result visible as
 * `stale` until it settles.
 */
export interface QuerySource<T> {
  ready(): Promise<void> | void;
  isReady(): boolean;
  execute(): readonly T[] | Promise<readonly T[]>;
  /**
   * Re-project `ids` against the current replica for a change that only
   * rewrites a projected value of a resident row (#942), or `null` when this
   * source cannot reproduce the run for those rows. Absent means every change
   * re-runs.
   *
   * The results view calls it only for a shape a patch may rewrite (no order, no
   * limit, no join) and an unsafe batch never reaches it, so an implementation
   * may assume the rows' place in the result is unchanged. It must answer one
   * row per id it was handed — the same ids, no duplicates and no others — or
   * return `null`; a short or mismatched answer would leave a row serving a
   * stale value. It is the synchronous run it replaces: a read that would have
   * to install a value first leaves that to the async re-run and declines.
   */
  patch?(ids: readonly string[]): readonly T[] | null;
}

export interface QueryResults {
  /**
   * Read or start the result for `query` on `surface`. Two chains that lower to
   * the same query and surface share one registry entry and one result.
   */
  watch<T>(surface: QuerySurface, query: Query, source: QuerySource<T>): QueryStore<T>;
}

/**
 * What the results view keeps on its registry entry: how to run the source,
 * what a change may rewrite, and who is listening. The result, the revision it
 * reflects, and the claims it owns live on the entry, not here — this is a
 * consumer's controls, not a second copy of the data.
 */
interface QueryRun<T> {
  readonly surface: QuerySurface;
  /** The lowered query, kept so a joined target's rows can be leased. */
  readonly query: Query;
  /** Component names this result reads, as declared by the query. */
  readonly reads: CompiledReadComponents;
  /** What a change may rewrite in this result, or re-run (#942). */
  readonly patchShape: PatchShape;
  readonly source: QuerySource<T>;
  /** Each listener, whether it wants the first run, and the revision it joined at. */
  readonly listeners: Map<() => void, { initial: boolean; revision: Revision }>;
  running: boolean;
  /** Whether the entry's change listener is attached; it is attached once. */
  attached: boolean;
}

const UNLOADED: QueryResult<never> = {
  data: undefined,
  status: "unloaded",
  loading: true,
  error: null,
};

const sameRows = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((row, i) => structuralEqual(row, b[i]));

const toError = (thrown: unknown): Error =>
  thrown instanceof Error ? thrown : new Error(String(thrown));

const resultOf = <T>(writer: SubscriptionWriter<QueryResult<T>> | undefined): QueryResult<T> =>
  writer?.result ?? (UNLOADED as QueryResult<T>);

/**
 * Whether a patch answered exactly the ids it was handed: one row per id, no
 * duplicates, no extras. A short or mismatched answer would leave a row serving
 * the value the patch never re-projected, so the patch is declined instead.
 */
const oneRowPerId = (
  ids: readonly string[],
  patched: readonly { readonly id: string }[],
): boolean => {
  if (patched.length !== ids.length) return false;
  const returned = new Set(patched.map((row) => row.id));
  return returned.size === ids.length && ids.every((id) => returned.has(id));
};

/**
 * A patched entry's claim list with the rows the batch named replaced by their
 * current claims. Rows the batch did not name keep the claims they had, and a
 * claim that is new to the result is appended: the claim list is a set of
 * rows to hold, not an ordering a result reads.
 */
const healClaims = (
  held: readonly Dependency[],
  patched: readonly string[],
  claimed: readonly Dependency[],
): readonly Dependency[] => {
  const fresh = new Map(claimed.map((dependency) => [dependency.id, dependency]));
  const named = new Set(patched);
  const next: Dependency[] = [];
  for (const dependency of held) {
    if (!named.has(dependency.id)) {
      next.push(dependency);
      continue;
    }
    const replacement = fresh.get(dependency.id);
    if (replacement === undefined) continue;
    next.push(replacement);
    fresh.delete(dependency.id);
  }
  next.push(...fresh.values());
  return next;
};

/**
 * Build the results view over a live replica and the registry its results live
 * in. Without a registry one is built over the replica; the inactive lifetime
 * is the registry's, so the store takes no lifetime option of its own.
 */
export const createQueryResults = (
  replica: Replica,
  subscriptions: SubscriptionRegistry = createSubscriptionRegistry(replica),
): QueryResults => {
  const isRelevant = <T>(run: QueryRun<T>, from: Revision): boolean => {
    if (replica.revision === from) return false;
    const changes = replica.changesSince(from);
    // An empty window on an advanced revision is a journal gap (a replica
    // `load`), so treat it as relevant; otherwise match each change against
    // the read set, by component for content and by model for membership.
    return changes.length === 0 || changes.some((change) => touchesReadSet(run.reads, change));
  };

  const statusOf = <T>(
    writer: SubscriptionWriter<QueryResult<T>>,
    result: QueryResult<T>,
  ): QueryStatus => {
    if (result.error !== null) return "failed";
    if (result.data === undefined) return "unloaded";
    // The entry is the one place the revision the result reflects lives, so the
    // status is read from it rather than from a copy kept beside the source.
    return writer.reflected === replica.revision ? "current" : "stale";
  };

  /**
   * Replace the snapshot only when a visible field changed, so
   * `useSyncExternalStore` reads a stable reference between result changes.
   * The entry is the one place the snapshot lives; nothing copies it.
   */
  const refresh = <T>(writer: SubscriptionWriter<QueryResult<T>>): void => {
    const current = resultOf(writer);
    const status = statusOf(writer, current);
    const error = status === "failed" ? current.error : null;
    const loading = status === "unloaded";
    if (current.status === status && current.loading === loading && current.error === error) return;
    writer.publish({ data: current.data, status, loading, error });
  };

  /**
   * The values the rows `ids` keep resident: for each row, the resident
   * components its read set names. A selection claims exactly its components;
   * a whole-model read (`todo/*`) claims every resident component of that model.
   * Claims are not a projection: the row's other components stay wherever the
   * policy put them.
   */
  const claimsFor = <T>(run: QueryRun<T>, ids: Iterable<string>): readonly Dependency[] => {
    const dependencies: Dependency[] = [];
    for (const id of ids) {
      if (replica.get(id) === undefined) continue;
      const components = replica
        .residentComponents(id)
        .filter(
          (component) =>
            run.reads.components.has(component) || run.reads.models.has(componentModel(component)),
        );
      if (components.length > 0) dependencies.push({ id, components });
    }
    return dependencies;
  };

  /**
   * The values a result keeps resident: every row it touches — a source row or
   * a joined target — claimed by {@link claimsFor}.
   */
  const dependenciesOf = <T>(run: QueryRun<T>, result: QueryResult<T>): readonly Dependency[] => {
    const data = result.data;
    if (data === undefined) return [];
    const ids = new Set<string>();
    if (run.surface === "collection") {
      for (const id of data as readonly string[]) ids.add(id);
    } else {
      for (const row of data as readonly Record<string, unknown>[]) {
        ids.add(row.id as string);
        // A joined target is a row this result projects too, so its values are
        // leased exactly as a source row's are.
        for (const join of run.query.joins) {
          const value = row[join.as];
          for (const target of Array.isArray(value) ? value : [value]) {
            if (target !== null && typeof target === "object") {
              const id = (target as { readonly id?: unknown }).id;
              if (typeof id === "string") ids.add(id);
            }
          }
        }
      }
    }
    return claimsFor(run, ids);
  };

  const notifyAll = <T>(run: QueryRun<T>): void => {
    // Snapshot so a listener that unsubscribes mid-fan-out cannot skip a peer.
    for (const listener of Array.from(run.listeners.keys())) listener();
  };

  /**
   * The first run is a priming, not a re-emit: only listeners that opted into
   * it fire — plus a listener that joined before a relevant change landed, so
   * a subscribe that races the first run still wakes for the change it saw.
   */
  const notifyInitial = <T>(writer: SubscriptionWriter<QueryResult<T>>, run: QueryRun<T>): void => {
    for (const [listener, state] of Array.from(run.listeners)) {
      if (state.initial) {
        listener();
        continue;
      }
      // A listener that joined before a relevant change landed sees the
      // first settle even though it opted out of the priming: that change is
      // what its subscription is about.
      if (isRelevant(run, state.revision)) listener();
    }
  };

  /** Retry a failed result rather than leaving it stuck until the next change. */
  const retry = <T>(writer: SubscriptionWriter<QueryResult<T>>, run: QueryRun<T>): void => {
    const result = resultOf(writer);
    if (result.error !== null && result.data === undefined && !run.running) {
      hydrate(writer, run);
    }
  };

  /**
   * Run the source and settle the entry. `revision` is read before execution
   * starts, so a change that lands while the promise is pending is detected by
   * comparing it with the replica's revision after the result applies.
   */
  const execute = <T>(
    writer: SubscriptionWriter<QueryResult<T>>,
    run: QueryRun<T>,
    revision: Revision,
  ): void => {
    const before = resultOf(writer);
    const hadData = before.data !== undefined;
    const hadError = before.error !== null;
    const startedStale = before.status === "stale";
    let publishedStale = false;
    // The registry has handed this entry the batch's revision, but the visible
    // result is still the one the entry holds. Holding that revision back keeps
    // the status `stale` until `settle` advances it to the one it produced.
    writer.hold();
    run.running = true;
    refresh(writer);

    const settle = (data: readonly T[]): void => {
      run.running = false;
      const current = resultOf(writer);
      const changed = !hadData || !sameRows(current.data ?? [], data);
      // Keep the previous array on an equal re-run so the snapshot's data
      // reference — and therefore `useSyncExternalStore`'s read — is stable.
      if (changed || current.error !== null) {
        writer.publish({
          data: changed ? data : current.data,
          status: current.status,
          loading: current.loading,
          error: null,
        });
      }
      writer.seek(revision);
      writer.depend(dependenciesOf(run, resultOf(writer)));
      refresh(writer);
      // A view that saw `stale` must see the settle even when the rows are
      // equal, or it would stay stale.
      if (!hadData) notifyInitial(writer, run);
      else if (changed || hadError || startedStale || publishedStale) notifyAll(run);
      // A change that landed while this run was in flight was not reconciled
      // (a running entry is left alone), so settle from the current revision
      // before standing down.
      if (replica.revision !== revision) reconcile(writer, run, replica.revision);
    };

    const fail = (thrown: unknown): void => {
      run.running = false;
      const current = resultOf(writer);
      const error = toError(thrown);
      const changed = current.error?.message !== error.message;
      writer.publish({
        data: current.data,
        status: current.status,
        loading: current.loading,
        error,
      });
      refresh(writer);
      if (changed || startedStale || publishedStale) {
        if (hadData) notifyAll(run);
        else notifyInitial(writer, run);
      }
      if (replica.revision !== revision) reconcile(writer, run, replica.revision);
    };

    let result: readonly T[] | Promise<readonly T[]>;
    try {
      result = run.source.execute();
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
        const stillStale = resultOf(writer).status === "stale";
        if (!run.running || !hadData || startedStale || !stillStale) return;
        publishedStale = true;
        notifyAll(run);
      });
      return;
    }
    settle(result);
  };

  /** Bring a never-run entry up to date, then run it. */
  const hydrate = <T>(writer: SubscriptionWriter<QueryResult<T>>, run: QueryRun<T>): void => {
    if (run.running) return;
    if (run.source.isReady()) {
      execute(writer, run, replica.revision);
      return;
    }
    run.running = true;
    const failed = (thrown: unknown): void => {
      run.running = false;
      const current = resultOf(writer);
      writer.publish({
        data: current.data,
        status: current.status,
        loading: current.loading,
        error: toError(thrown),
      });
      refresh(writer);
      notifyInitial(writer, run);
    };
    try {
      const settled = run.source.ready();
      if (settled instanceof Promise) {
        settled.then(() => {
          run.running = false;
          execute(writer, run, replica.revision);
        }, failed);
        return;
      }
    } catch (thrown) {
      // A source that cannot prime is a failed result, not a subscribe that
      // throws: the caller keeps its unsubscribe path and its claims go away.
      failed(thrown);
      return;
    }
    run.running = false;
    execute(writer, run, replica.revision);
  };

  /**
   * Apply a batch as a patch instead of a re-run (#942): re-project the rows
   * the batch changed and splice them into the retained result. Returns false
   * when the batch is not one a patch may apply, so the caller re-runs.
   *
   * A patch is the run it replaces. `patchShapeOf` has already ruled out an
   * order, a limit, and a join, and `patchableRows` a predicate, an order key, a
   * join target, a structural key, or a membership change, so the changed rows
   * keep their place and only their projection is rewritten. The id set and its
   * order survive, and a row whose projection did not change keeps its array
   * reference, so a view re-renders only for a visible change.
   */
  const patch = <T>(
    writer: SubscriptionWriter<QueryResult<T>>,
    run: QueryRun<T>,
    revision: Revision,
    changes: readonly ReplicaChange[],
    unloaded: readonly string[],
  ): boolean => {
    if (run.surface !== "rows" || run.source.patch === undefined) return false;
    // A value the entry was holding left the replica: the claims follow the
    // values, so the re-run recomputes them instead of patching around them.
    if (unloaded.length > 0) return false;
    const current = resultOf(writer);
    const data = current.data;
    if (data === undefined) return false;
    const ids = patchableRows(run.reads, run.patchShape, changes);
    if (ids === null || ids.length === 0) return false;
    let patched: unknown;
    try {
      patched = run.source.patch(ids);
    } catch {
      // A patch that throws is not a result. The re-run owns reporting a
      // failure, so a broken patch path degrades to the run it replaced.
      return false;
    }
    // The seam is public and a plain-JS caller can answer anything. Only an
    // array is a payload the splice can consume; anything else (`undefined`, a
    // single row, a promise) declines rather than throwing out of the change
    // listener, which would leave the entry serving stale data with no re-run.
    if (!Array.isArray(patched)) return false;
    // SAFETY: only a `rows` result patches, and its `T` carries the id.
    if (!oneRowPerId(ids, patched as readonly { readonly id: string }[])) return false;
    // SAFETY: only a `rows` result patches, and its `T` is a projected row
    // carrying the id the splice matches on.
    const next = patchResultRows(
      data as readonly { readonly id: string }[],
      patched as readonly { readonly id: string }[],
    ) as readonly T[] | null;
    if (next === null) return false;
    // The id set is unchanged, but a claim is a *resident* component, not a row
    // id: the batch may have installed a projected component on a row the entry
    // did not previously claim. Heal the claims of the rows the batch named and
    // leave the rest alone, so this stays O(changed rows) rather than the walk
    // a re-run would do.
    writer.seek(revision);
    writer.depend(healClaims(writer.dependencies, ids, claimsFor(run, ids)));
    if (next !== data) {
      writer.publish({ data: next, status: "current", loading: false, error: null });
    }
    refresh(writer);
    if (next !== data || current.error !== null) notifyAll(run);
    // A change that landed while this batch was being applied was not
    // reconciled, so settle from the current revision before standing down.
    if (replica.revision !== revision) reconcile(writer, run, replica.revision);
    return true;
  };

  /**
   * Reconcile one entry against a revision. A journal gap (an empty change
   * list on an advanced revision) means the replica was replaced wholesale, so
   * every entry re-runs.
   *
   * A batch that only rewrites a projected value is patched in place; anything
   * that could move matching, ordering, or the row set re-runs (#942).
   *
   * An inactive result is not refreshed in the background: a relevant change
   * holds its revision back so a remount sees `stale`, and the re-run happens
   * when someone is listening. Its TTL ends it otherwise.
   */
  const reconcile = <T>(
    writer: SubscriptionWriter<QueryResult<T>>,
    run: QueryRun<T>,
    revision: Revision,
    changes?: readonly ReplicaChange[],
    unloaded: readonly string[] = [],
  ): void => {
    if (run.running) {
      // The run in flight will settle against the current revision; until then
      // the result reflects the revision the entry holds.
      writer.hold();
      return;
    }
    const result = resultOf(writer);
    if (result.data === undefined) {
      if (run.listeners.size === 0) return;
      if (result.error !== null && isRelevant(run, writer.reflected)) retry(writer, run);
      return;
    }
    if (writer.reflected === revision) return;
    if (run.listeners.size === 0) {
      // Nobody is listening, so hold the revision back and mark the result
      // stale: a remount inside the TTL re-runs it once. Holding it cannot be
      // skipped, because dispatch would otherwise advance it to the batch's.
      writer.hold();
      refresh(writer);
      return;
    }
    if (!isRelevant(run, writer.reflected)) {
      // Nothing this result read changed, so it is valid at this revision
      // without a re-run.
      writer.seek(revision);
      refresh(writer);
      return;
    }
    if (changes !== undefined && patch(writer, run, revision, changes, unloaded)) {
      return;
    }
    execute(writer, run, revision);
  };

  return {
    watch<T>(surface: QuerySurface, query: Query, source: QuerySource<T>): QueryStore<T> {
      const key = queryResultKey(surface, query);
      // A collection result keeps ids, a projected row keeps the whole shape;
      // only the latter needs the source and joined models read whole.
      const readNames =
        surface === "rows" ? selectionReadComponents(query) : planQuery(query).readComponents;
      const structural = structuralReads(query);
      const spec: SubscriptionSpec = {
        kind: "query",
        key,
        reads: readNames,
        sources: structural.rows,
        indices: structural.indices,
        covered: structural.covered,
      };

      const runFor = (): QueryRun<T> => ({
        surface,
        query,
        reads: compileReadComponents(readNames, structural.rows),
        patchShape: patchShapeOf(query),
        source,
        listeners: new Map(),
        running: false,
        attached: false,
      });

      /** Attach the entry's one change listener, and seed its snapshot. */
      const attach = (
        handle: Subscription<QueryResult<T>, QueryRun<T>>,
        run: QueryRun<T>,
      ): void => {
        if (run.attached) return;
        run.attached = true;
        if (handle.result === undefined) handle.publish(UNLOADED as QueryResult<T>);
        handle.onChange((changes, revision, unloaded, writer) =>
          reconcile(writer, run, revision, changes, unloaded),
        );
      };

      return {
        getSnapshot: () => {
          const entry = subscriptions.peek<QueryResult<T>, QueryRun<T>>("query", key);
          return entry?.result ?? (UNLOADED as QueryResult<T>);
        },
        subscribe(listener, subscribeOptions) {
          const handle = subscriptions.open<QueryResult<T>, QueryRun<T>>(spec, runFor());
          const run = handle.consumer;
          attach(handle, run);
          run.listeners.set(listener, {
            initial: subscribeOptions?.initial ?? true,
            revision: replica.revision,
          });
          try {
            const result = resultOf(handle);
            // An in-flight run settles against the current revision on its own,
            // so a remount only starts work the result has not done yet.
            if (!run.running) {
              if (result.data === undefined) {
                hydrate(handle, run);
              } else if (result.error !== null || handle.revision !== replica.revision) {
                // A remount sees the retained (possibly stale) result first; the
                // re-run settles in the same tick for a hydrated replica.
                execute(handle, run, replica.revision);
              } else {
                // Nothing relevant landed while the result was inactive, so it is
                // valid at this revision: record that, then publish without a
                // read or a re-run.
                handle.seek(replica.revision);
                refresh(handle);
              }
            }
          } catch (thrown) {
            // A listener that throws on the first result, or a source that
            // throws outside its own run, must not leave a claim with no
            // handle left to release it.
            run.listeners.delete(listener);
            handle.release();
            throw thrown;
          }
          return () => {
            if (!run.listeners.delete(listener)) return;
            // The last release makes the result inactive; the registry keeps it
            // and its claims for the one residency TTL.
            handle.release();
          };
        },
      };
    },
  };
};
