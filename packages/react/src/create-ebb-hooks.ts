/**
 * Bind `useClient`, `useQuery`, and `usePresence` to one client type.
 *
 * React context erases types, so `useClient` must be told the client type at
 * every call site; `useQuery` cannot take the schema as a type argument
 * instead (TypeScript does not partially infer type arguments, so the rows
 * would fall back to their defaults), and `usePresence` cannot name a channel
 * from the client's registry. Binding once removes all three:
 *
 * ```tsx
 * export const { useClient: useEbb, useQuery, usePresence } =
 *   createEbbHooks<AppClient>();
 *
 * const client = useEbb();
 * const { data } = useQuery((q) => q.issue.query().with({ assignee: true }));
 * const cameras = usePresence(planId, "camera");
 * ```
 *
 * Call it at module scope: each call makes new hook functions, and a
 * per-render call would hand React a new hook identity on every render.
 */

import type { ProjectedRow, QueryBuilder, TSchema } from "@ebbjs/client";

import { useClient, type EbbClient } from "./context";
import { usePresence, type PresenceChannelOf, type PresencePeerMapOf } from "./use-presence";
import { useQueryRoot, type UseQueryResult } from "./use-query";

/**
 * The read root of a client type: its namespaces narrowed to `query()`, so a
 * write is not on it. {@link QueryRoot} says the same for a schema.
 */
export type QueryRootOf<C> = {
  [K in keyof C as C[K] extends { query: (...args: never[]) => unknown } ? K : never]: {
    query: C[K] extends { query: infer Q } ? Q : never;
  };
};

/** The hooks {@link createEbbHooks} returns, bound to one client type. */
export interface EbbHooks<C extends EbbClient> {
  /** The provider's client, typed as `C` — no generic at the call site. */
  useClient(): C;
  /** {@link useQuery} bound to `C`: `q` is the read root, so nothing needs a type. */
  useQuery<
    TFields extends Record<string, TSchema>,
    TJoins extends object,
    TJoined extends object,
    TRow extends ProjectedRow<TFields> = ProjectedRow<TFields>,
  >(
    build: (q: QueryRootOf<C>) => QueryBuilder<TFields, TJoins, TJoined, TRow>,
    deps?: readonly unknown[],
  ): UseQueryResult<TFields, TJoined, TRow>;
  /**
   * {@link usePresence} bound to `C`: the channel is checked against the
   * client's `definePresence` registry and the peer payload follows its schema.
   */
  usePresence<K extends PresenceChannelOf<C>>(
    entityId: string,
    channel: K,
  ): PresencePeerMapOf<C, K>;
}

/** Bind the hooks to one client type. Call it once, at module scope. */
export function createEbbHooks<C extends EbbClient>(): EbbHooks<C> {
  const useBoundClient = (): C => useClient<C>();

  // oxlint-disable-next-line react-hooks/rules-of-hooks -- a custom hook built by a factory; the body only wires `useQueryRoot`.
  const useBoundQuery: EbbHooks<C>["useQuery"] = (build, deps = []) =>
    // SAFETY: `C` carries the same namespaces the read root narrows; the cast
    // only hides the extra members (mutations, sync methods) `query()` ignores.
    useQueryRoot(useBoundClient() as QueryRootOf<C>, build, deps);

  const useBoundPresence: EbbHooks<C>["usePresence"] = (entityId, channel) =>
    // SAFETY: the registry types this channel's payload and the provider holds
    // that same client; only the declared payload type is asserted.
    usePresence(entityId, channel) as PresencePeerMapOf<C, typeof channel>;

  return {
    useClient: useBoundClient,
    useQuery: useBoundQuery,
    usePresence: useBoundPresence,
  };
}
