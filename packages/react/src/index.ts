/**
 * @ebbjs/react — React bindings for the `@ebbjs/client` namespace.
 *
 * Ships the client plumbing plus the first data hook:
 *
 * - `EbbProvider` — context carrying a `NamespacedClient<S, TActions>`
 * - `useClient<S>()` — read the client typed by the caller's schema
 * - `useConnection` — `useSyncExternalStore` over connection state
 * - `useQuery` — `useSyncExternalStore` over a materialized collection query
 *
 * `useEntity` and `useEntityMutations` land in follow-up slices.
 */

export { EbbProvider, useClient, type EbbProviderProps } from "./context";

export { useConnection } from "./use-connection";

export { useQuery, type QueryRows, type UseQueryResult } from "./use-query";

export type { ConnectionState } from "@ebbjs/client";
