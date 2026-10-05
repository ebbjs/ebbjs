import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { QueryBuilder, TSchema } from "@ebbjs/client";

/**
 * Projected rows a `QueryBuilder` resolves to. `Awaited` peels the
 * builder's thenable so consumers get the row list type directly.
 */
export type QueryRows<TFields extends Record<string, TSchema>> = Awaited<QueryBuilder<TFields>>;

/** Result of {@link useQuery}: rows plus the subscribe lifecycle. */
export interface UseQueryResult<TFields extends Record<string, TSchema>> {
  readonly data: QueryRows<TFields>;
  readonly loading: boolean;
  readonly error: Error | null;
}

/** Internal reactive cell `useQuery` reads through `useSyncExternalStore`. */
interface QueryStore<TFields extends Record<string, TSchema>> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): UseQueryResult<TFields>;
}

/**
 * Build the per-hook store. Pure closure — no class, no external
 * state — so each `(builder)` pair owns one independent cell and
 * StrictMode's double-subscribe is ref-counted rather than leaking a
 * second builder listener.
 *
 * Snapshot stability is the point: `getSnapshot` returns the same
 * object until a materialization actually changes `{data, loading,
 * error}`, so `useSyncExternalStore` sees no change on a source-type
 * emit that did not affect this chain's result.
 */
function createQueryStore<TFields extends Record<string, TSchema>>(
  builder: QueryBuilder<TFields>,
): QueryStore<TFields> {
  let state: UseQueryResult<TFields> = { data: [], loading: true, error: null };
  const listeners = new Set<() => void>();
  let detachTrigger: (() => void) | null = null;
  // A change that lands mid-materialization would otherwise be missed:
  // flag it and re-run once the in-flight materialization settles.
  let materializing = false;
  let pending = false;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const applyRows = (rows: QueryRows<TFields>): void => {
    // Structural compare so an emit that left the result unchanged
    // produces no new snapshot (and therefore no re-render).
    const unchanged = JSON.stringify(rows) === JSON.stringify(state.data);
    if (unchanged && !state.loading && state.error === null) return;
    state = { data: unchanged ? state.data : rows, loading: false, error: null };
    notify();
  };

  const applyError = (error: Error): void => {
    state = { data: state.data, loading: false, error };
    notify();
  };

  const materialize = async (): Promise<void> => {
    if (materializing) {
      pending = true;
      return;
    }
    materializing = true;
    try {
      applyRows(await builder);
    } catch (thrown) {
      applyError(thrown instanceof Error ? thrown : new Error(String(thrown)));
    } finally {
      materializing = false;
      if (pending) {
        pending = false;
        void materialize();
      }
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        detachTrigger = builder.subscribe(() => void materialize());
        void materialize();
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        if (listeners.size === 0) {
          detachTrigger?.();
          detachTrigger = null;
        }
      };
    },
    getSnapshot: () => state,
  };
}

/**
 * Subscribe a component to a materialized collection query.
 *
 * `build` runs once per `deps` change (keep `deps` a stable-length
 * list), and `useSyncExternalStore` resubscribes whenever the builder
 * changes. The trigger is the builder's source-entity change stream:
 * any materialization of that entity type re-materializes the chain,
 * and an unchanged result suppresses the snapshot update — so a
 * non-matching change never re-renders the component.
 */
export function useQuery<TFields extends Record<string, TSchema>>(
  build: () => QueryBuilder<TFields>,
  deps: readonly unknown[] = [],
): UseQueryResult<TFields> {
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- `build` is re-run only when the caller's `deps` change; it is intentionally not itself a dependency.
  const builder = useMemo(() => build(), deps);
  const store = useMemo(() => createQueryStore(builder), [builder]);
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(() => store.getSnapshot(), [store]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
