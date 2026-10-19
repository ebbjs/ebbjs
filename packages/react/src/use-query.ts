import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { QueryBuilder, QueryStatus, TSchema } from "@ebbjs/client";

/**
 * Projected rows a `QueryBuilder` resolves to. `Awaited` peels the
 * builder's thenable so consumers get the row list type directly.
 */
export type QueryRows<TFields extends Record<string, TSchema>> = Awaited<QueryBuilder<TFields>>;

/** Result of {@link useQuery}: rows, status, and the derived loading/error. */
export interface UseQueryResult<TFields extends Record<string, TSchema>> {
  /**
   * The cached rows. `undefined` while the query is `unloaded`, so a first
   * mount never renders "no result yet" as an empty list; use {@link status}
   * to distinguish the two.
   */
  readonly data: QueryRows<TFields> | undefined;
  /** `unloaded` / `stale` / `current` / `failed`, from the engine cache. */
  readonly status: QueryStatus;
  /** True only while no result exists yet (`unloaded`). */
  readonly loading: boolean;
  readonly error: Error | null;
}

/**
 * Subscribe a component to the engine's cached query result.
 *
 * `build` runs once per `deps` change (keep `deps` a stable-length list).
 * The store is keyed by the lowered query, so two components building the
 * same chain share one cached result, and a remount reads it back with
 * `status: "stale" | "current"` instead of starting over. The snapshot
 * reference stays stable until the result actually changes, so an
 * invalidation that re-runs to an equal result does not re-render.
 */
export function useQuery<TFields extends Record<string, TSchema>>(
  build: () => QueryBuilder<TFields>,
  deps: readonly unknown[] = [],
): UseQueryResult<TFields> {
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- `build` is re-run only when the caller's `deps` change; it is intentionally not itself a dependency.
  const builder = useMemo(() => build(), deps);
  const store = useMemo(() => builder.result(), [builder]);
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(() => store.getSnapshot(), [store]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  return {
    data: snapshot.data,
    status: snapshot.status,
    loading: snapshot.loading,
    error: snapshot.error,
  };
}
