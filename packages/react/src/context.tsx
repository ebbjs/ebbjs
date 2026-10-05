import { createContext, useContext, type ReactNode } from "react";
import type { AnyActionDef, NamespacedClient, SyncClient } from "@ebbjs/client";

/**
 * Holds the `SyncClient` for a subtree. `null` is the "no provider"
 * sentinel; {@link useClient} turns it into a loud error so a
 * mis-wired tree fails at the hook rather than later at a network call.
 *
 * Storage is deliberately erased to the base `SyncClient`: the
 * provider type carries the schema through its generics, and
 * {@link useClient} restores the precise `NamespacedClient<S, TActions>`
 * once. A single cast here keeps every call site cast-free.
 */
const EbbClientContext = createContext<SyncClient | null>(null);

export interface EbbProviderProps<
  S = undefined,
  TActions extends Record<string, AnyActionDef> = Record<string, never>,
> {
  /** The sync client every hook below reads and subscribes to. */
  readonly client: NamespacedClient<S, TActions>;
  readonly children: ReactNode;
}

/**
 * Makes a `NamespacedClient` available to the hooks below it.
 *
 * The caller owns the client, not the provider, so remounting the tree
 * (Fast Refresh, route transitions) doesn't tear down the connection.
 */
export function EbbProvider<
  S = undefined,
  TActions extends Record<string, AnyActionDef> = Record<string, never>,
>({ client, children }: EbbProviderProps<S, TActions>) {
  return <EbbClientContext.Provider value={client}>{children}</EbbClientContext.Provider>;
}

/** Read the nearest `<EbbProvider>`'s client, typed by the caller's schema. */
export function useClient<
  S = undefined,
  TActions extends Record<string, AnyActionDef> = Record<string, never>,
>(): NamespacedClient<S, TActions> {
  const client = useContext(EbbClientContext);
  if (client === null) {
    throw new Error(
      "useClient() must be called inside an <EbbProvider>. " +
        "Wrap the tree in <EbbProvider client={client}> at the app root.",
    );
  }
  return client as NamespacedClient<S, TActions>;
}
