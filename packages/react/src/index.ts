/**
 * @ebbjs/react — React bindings for the `@ebbjs/client` namespace.
 *
 * Ships the client plumbing plus the data and sync-state hooks:
 *
 * - `EbbProvider` — context carrying a `NamespacedClient<S, TActions>`
 * - `useClient<C>()` — read the client typed by the caller's whole client
 *   type (schema and action map together)
 * - `useConnection` — `useSyncExternalStore` over connection state
 * - `useQuery` — the reactive read root: build a query through the typed
 *   entity namespaces and subscribe to its cached result
 * - `usePresence` — the peers observed on one presence channel of one entity,
 *   typed from the channel's declared schema
 * - `useOutbox` / `useConflicts` / `useEbbStatus` — read-only subscriptions to
 *   `client.sync.outbox`, `client.sync.conflicts`, and the aggregate
 *   `client.status`, so a UI can render pending depth, conflict depth, and
 *   "last synced" without polling
 * - `useSyncObservable<T>` — the generic wrapper those three build on, for
 *   `client.sync.backfill` and app-owned observables
 * - `createEbbHooks` — bind `useClient`, `useQuery`, `usePresence`, and the
 *   sync-state hooks to your client type once, so components need no generic
 *   and no callback annotation
 *
 * The sync-state hooks are read-only: conflict resolution stays on
 * `client.conflicts` (`list()` then `resolve`), so the decision and its
 * durable write stay outside a render pass.
 *
 * Writes are not a hook: every application write is an Action declared at
 * module scope with `defineAction` and called as `client.actions.<name>`.
 * The one write that is not — a collaborative-text edit — is the field
 * layer's own protocol, not an application mutation.
 */

export { EbbProvider, useClient, type EbbProviderProps } from "./context";

export { useConnection } from "./use-connection";

export { useSyncObservable } from "./use-sync-observable";

export { useOutbox } from "./use-outbox";

export { useConflicts } from "./use-conflicts";

export { useEbbStatus } from "./use-status";

export { useQuery, type QueryRows, type UseQueryResult } from "./use-query";

export { usePresence, type PresenceChannelOf, type PresencePeerMapOf } from "./use-presence";

export { createEbbHooks, type EbbHooks, type QueryRootOf } from "./create-ebb-hooks";

export type {
  ClientStatus,
  ConflictSnapshot,
  ConnectionState,
  OutboxSnapshot,
  QueryRoot,
  ReadonlyObservable,
} from "@ebbjs/client";
