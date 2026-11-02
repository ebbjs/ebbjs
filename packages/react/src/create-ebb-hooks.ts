/**
 * `createEbbHooks<C>()` — bind the hooks to your client type once, then use
 * them without a generic or an annotation.
 *
 * React context erases types: `useClient` cannot learn the provider's client
 * type, so it has to be told. Naming it at every call site is noise, and
 * `useQuery` cannot take the schema as a type argument either (TypeScript does
 * not partially infer type arguments, so the row types would fall back to
 * their defaults). Binding once, at module scope, is the way out:
 *
 * ```tsx
 * // use-ebb.ts
 * export const { useClient: useEbb, useQuery } = createEbbHooks<AppClient>();
 *
 * // in a component
 * const client = useEbb();
 * const { data } = useQuery((q) => q.issue.query().with({ assignee: true }));
 * ```
 *
 * `q` is the client's read root: every namespace narrowed to `query()`, so a
 * write stays a compile error there. Call the factory at module scope — each
 * call makes new hook functions, and a per-render call would hand React a new
 * hook identity on every render.
 */

import type { ProjectedRow, QueryBuilder, SyncClient, TSchema } from "@ebbjs/client";

import { useClient } from "./context";
import { useQueryRoot, type UseQueryResult } from "./use-query";

/**
 * The read root of a client type: every namespace that exposes `query()`,
 * narrowed to just `query()`. {@link QueryRoot} says the same for a schema;
 * deriving it from the client is what lets a bound hook type `q` without the
 * caller naming anything.
 */
export type QueryRootOf<C> = {
  [K in keyof C as C[K] extends { query: (...args: never[]) => unknown } ? K : never]: {
    query: C[K] extends { query: infer Q } ? Q : never;
  };
};

/** The hooks {@link createEbbHooks} returns, bound to one client type. */
export interface EbbHooks<C extends SyncClient> {
  /** The provider's client, typed as `C` — no generic at the call site. */
  useClient(): C;
  /**
   * {@link useQuery} bound to `C`: `build`'s `q` is the client's read root,
   * so neither the callback nor the call needs a type.
   */
  useQuery<
    TFields extends Record<string, TSchema>,
    TJoins extends object,
    TJoined extends object,
    TRow extends ProjectedRow<TFields> = ProjectedRow<TFields>,
  >(
    build: (q: QueryRootOf<C>) => QueryBuilder<TFields, TJoins, TJoined, TRow>,
    deps?: readonly unknown[],
  ): UseQueryResult<TFields, TJoined, TRow>;
}

/** Bind the hooks to one client type. Call it once, at module scope. */
export function createEbbHooks<C extends SyncClient>(): EbbHooks<C> {
  const useBoundClient = (): C => useClient<C>();

  // oxlint-disable-next-line react-hooks/rules-of-hooks -- a custom hook built by a factory; the body only wires `useQueryRoot`.
  const useBoundQuery: EbbHooks<C>["useQuery"] = (build, deps = []) =>
    // SAFETY: `C` carries the same namespaces the read root narrows; the cast
    // only hides the extra members (mutations, sync methods) `query()` ignores.
    useQueryRoot(useBoundClient() as QueryRootOf<C>, build, deps);

  return { useClient: useBoundClient, useQuery: useBoundQuery };
}
