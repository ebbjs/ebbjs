/**
 * @ebbjs/react — React bindings for the `@ebbjs/client` namespace.
 *
 * Ships the client plumbing plus the data hooks:
 *
 * - `EbbProvider` — context carrying a `NamespacedClient<S, TActions>`
 * - `useClient<C>()` — read the client typed by the caller's whole client
 *   type (schema and action map together)
 * - `useConnection` — `useSyncExternalStore` over connection state
 * - `useQuery` — the reactive read root: build a query through the typed
 *   entity namespaces and subscribe to its cached result
 * - `createEbbHooks` — bind `useClient` and `useQuery` to your client type
 *   once, so components need no generic and no callback annotation
 *
 * Writes are not a hook: every application write is an Action declared at
 * module scope with `defineAction` and called as `client.actions.<name>`.
 * The one write that is not — a collaborative-text edit — is the field
 * layer's own protocol, not an application mutation.
 */

export { EbbProvider, useClient, type EbbProviderProps } from "./context";

export { useConnection } from "./use-connection";

export { useQuery, type QueryRows, type UseQueryResult } from "./use-query";

export { createEbbHooks, type EbbHooks, type QueryRootOf } from "./create-ebb-hooks";

export type { ConnectionState, QueryRoot } from "@ebbjs/client";
