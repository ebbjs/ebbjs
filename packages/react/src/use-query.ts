import { useCallback, useMemo, useSyncExternalStore } from "react";
import type {
  NamespacedClient,
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
 * The engine behind both query hooks: subscribe to the cached result `build`
 * lowers to, against `root`.
 */
export function useQueryRoot<
  TRoot,
  TFields extends Record<string, TSchema>,
  TJoins extends object,
  TJoined extends object,
  TRow extends ProjectedRow<TFields> = ProjectedRow<TFields>,
>(
  root: TRoot,
  build: (q: TRoot) => QueryBuilder<TFields, TJoins, TJoined, TRow>,
  deps: readonly unknown[],
): UseQueryResult<TFields, TJoined, TRow> {
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

/**
 * Subscribe a component to the engine's cached query result.
 *
 * `build` receives `q` — the client narrowed to each namespace's `query()` —
 * so `q.todo.query` is `client.todo.query`. Annotate `q` with the schema
 * (`(q: QueryRoot<Schema>) => …`) and let every type argument infer; a type
 * argument instead would pin the rows to their defaults. To skip the
 * annotation, use the bound hook from {@link createEbbHooks}.
 *
 * `build` runs once per `deps` change and per client swap (keep `deps` a
 * stable-length list). The store is keyed by the lowered query, so two
 * components building the same chain share one result, and a remount reads it
 * back as `stale` / `current` rather than restarting. A held result renders
 * synchronously, so there is no loading flash; `failed` is sticky until a run
 * succeeds, and `unloaded` is never rendered as an empty list.
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
  const client = useClient<NamespacedClient<S>>();
  // SAFETY: the provider stores the same client these namespaces come from;
  // `QueryRoot` only narrows that surface to `query()`.
  const root = client as QueryRoot<S>;
  return useQueryRoot(root, build, deps);
}
