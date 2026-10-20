import { useCallback, useMemo, useSyncExternalStore } from "react";
import type {
  NoJoins,
  ProjectedRow,
  QueryBuilder,
  QueryRoot,
  QueryStatus,
  TSchema,
} from "@ebbjs/client";

import { useClient } from "./context";

/**
 * Projected rows a `QueryBuilder` resolves to, widened by its selected joins.
 * `Awaited` peels the builder's thenable so consumers get the row list type
 * directly. `TRow` follows the chain: a replica-backed query carries
 * `groupIds`, a candidate chain does not.
 */
export type QueryRows<
  TFields extends Record<string, TSchema>,
  TJoined extends object = NoJoins,
  TRow extends ProjectedRow<TFields> = ProjectedRow<TFields>,
> = Awaited<QueryBuilder<TFields, NoJoins, TJoined, TRow>>;

/** Result of {@link useQuery}: rows, status, and the derived loading/error. */
export interface UseQueryResult<
  TFields extends Record<string, TSchema>,
  TJoined extends object = NoJoins,
  TRow extends ProjectedRow<TFields> = ProjectedRow<TFields>,
> {
  /**
   * The cached rows, joined as selected. `undefined` while the query is
   * `unloaded`, so a first mount never renders "no result yet" as an empty
   * list; use {@link status} to distinguish the two.
   */
  readonly data: QueryRows<TFields, TJoined, TRow> | undefined;
  /** `unloaded` / `stale` / `current` / `failed`, from the engine cache. */
  readonly status: QueryStatus;
  /** True only while no result exists yet (`unloaded`). */
  readonly loading: boolean;
  readonly error: Error | null;
}

/**
 * Subscribe a component to the engine's cached query result.
 *
 * `build` receives `q` — the provider's client narrowed to each entity
 * namespace's `query()` — so `q.todo.query` is the same method as
 * `client.todo.query`. Annotate `q` with the caller's schema
 * (`(q: QueryRoot<Schema>) => q.todo.query()`) and let every type argument
 * infer: `q` is checked against the schema and `data` follows the chain,
 * joins included. Supplying a type argument instead would pin the row types
 * to their defaults, because TypeScript does not partially infer type
 * arguments.
 *
 * `build` runs once per `deps` change and per client swap (keep `deps` a
 * stable-length list). The store is keyed by the lowered query, so two
 * components building the same chain share one cached result, and a remount
 * reads it back with `status: "stale" | "current"` instead of starting over.
 * The snapshot reference stays stable until the result actually changes, so an
 * invalidation that re-runs to an equal result does not re-render.
 *
 * A held result renders synchronously on first mount: `status` starts at
 * `current`, not `unloaded`, so there is no loading flash for cached rows.
 * `stale` marks a usable result at an older replica revision while the re-run
 * is pending, `failed` is sticky until a run succeeds, and `unloaded` is never
 * rendered as an empty list.
 */
export function useQuery<
  S,
  TFields extends Record<string, TSchema>,
  TJoins extends object,
  TJoined extends object,
  TRow extends ProjectedRow<TFields> = ProjectedRow<TFields>,
>(
  build: (q: QueryRoot<S>) => QueryBuilder<TFields, TJoins, TJoined, TRow>,
  deps: readonly unknown[] = [],
): UseQueryResult<TFields, TJoined, TRow> {
  const client = useClient<S>();
  // SAFETY: the provider stores the same client these namespaces come from;
  // `QueryRoot` only narrows that surface to `query()`.
  const root = client as QueryRoot<S>;
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- `build` is re-run only when the caller's `deps` or the client change; it is intentionally not itself a dependency.
  const builder = useMemo(() => build(root), [root, ...deps]);
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
