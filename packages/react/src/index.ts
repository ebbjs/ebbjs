/**
 * @ebbjs/react — React bindings for the `@ebbjs/client` namespace.
 *
 * Ships the client plumbing plus the data hooks:
 *
 * - `EbbProvider` — context carrying a `NamespacedClient<S, TActions>`
 * - `useClient<S>()` — read the client typed by the caller's schema
 * - `useConnection` — `useSyncExternalStore` over connection state
 * - `useQuery` — `useSyncExternalStore` over a materialized collection query
 * - `useEntity` — `useSyncExternalStore` over a single entity row
 * - `useEntityMutations` — stable write pass-throughs for one namespace
 */

export { EbbProvider, useClient, type EbbProviderProps } from "./context";

export { useConnection } from "./use-connection";

export { useQuery, type QueryRows, type UseQueryResult } from "./use-query";

export { useEntity, type UseEntityResult } from "./use-entity";

export { useEntityMutations, type UseEntityMutationsResult } from "./use-entity-mutations";

export type { ConnectionState } from "@ebbjs/client";
