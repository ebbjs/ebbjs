import { createContext, useContext, type ReactNode } from "react";
import type { SyncClient } from "@ebbjs/client";

/**
 * Holds the `SyncClient` for a subtree. `null` is the "no provider"
 * sentinel; {@link useClient} turns it into a loud error so a
 * mis-wired tree fails at the hook rather than later at a network call.
 *
 * Storage is deliberately erased to the base `SyncClient`: the caller's
 * client type carries the schema and action map through one generic,
 * and {@link useClient} restores it once. A single cast here keeps every
 * call site cast-free.
 */
const EbbClientContext = createContext<SyncClient | null>(null);

export interface EbbProviderProps<C extends SyncClient = SyncClient> {
  /** The sync client every hook below reads and subscribes to. */
  readonly client: C;
  readonly children: ReactNode;
}

/**
 * Makes a `NamespacedClient` available to the hooks below it.
 *
 * The caller owns the client, not the provider, so remounting the tree
 * (Fast Refresh, route transitions) doesn't tear down the connection.
 */
export function EbbProvider<C extends SyncClient = SyncClient>({
  client,
  children,
}: EbbProviderProps<C>) {
  return <EbbClientContext.Provider value={client}>{children}</EbbClientContext.Provider>;
}

/**
 * Read the nearest `<EbbProvider>`'s client, typed by the whole client
 * type — schema and action map together:
 *
 * ```tsx
 * type AppClient = NamespacedClient<typeof schema, typeof appActions>;
 * const client = useClient<AppClient>();
 * ```
 *
 * Naming the client once (rather than a schema and an action map here)
 * keeps the call site stable when a client grows: entities, actions, and
 * anything added beside them stay in one type. An app can also wrap this
 * in its own `useAppClient()` so components carry no generic at all.
 */
export function useClient<C extends SyncClient = SyncClient>(): C {
  const client = useContext(EbbClientContext);
  if (client === null) {
    throw new Error(
      "useClient() must be called inside an <EbbProvider>. " +
        "Wrap the tree in <EbbProvider client={client}> at the app root.",
    );
  }
  return client as C;
}
