/**
 * @ebbjs/react — React bindings for the `@ebbjs/client` namespace.
 *
 * This first slice ships the client plumbing every later hook builds on:
 *
 * - `EbbProvider` — context carrying the `SyncClient`
 * - `useClient` — read the client, throwing outside a provider
 * - `useConnection` — `useSyncExternalStore` over connection state
 *
 * Data hooks (`useQuery`, `useEntity`, `useEntityMutations`) land in
 * follow-up slices; the package deliberately stops at connection state.
 */

export { EbbProvider, useClient, type EbbProviderProps } from "./context";

export { useConnection } from "./use-connection";

export type { ConnectionState } from "@ebbjs/client";
