import { createContext, useContext, type ReactNode } from "react";
import type { SyncClient } from "@ebbjs/client";

/**
 * Holds the `SyncClient` for a subtree. `null` is the "no provider"
 * sentinel; {@link useClient} turns it into a loud error so a
 * mis-wired tree fails at the hook rather than later at a network call.
 */
const EbbClientContext = createContext<SyncClient | null>(null);

export interface EbbProviderProps {
  /** The sync client every hook below reads and subscribes to. */
  readonly client: SyncClient;
  readonly children: ReactNode;
}

/**
 * Makes a `SyncClient` available to the hooks below it.
 *
 * The caller owns the client, not the provider, so remounting the tree
 * (Fast Refresh, route transitions) doesn't tear down the connection.
 */
export function EbbProvider({ client, children }: EbbProviderProps) {
  return <EbbClientContext.Provider value={client}>{children}</EbbClientContext.Provider>;
}

/** Read the nearest `<EbbProvider>`'s client. */
export function useClient(): SyncClient {
  const client = useContext(EbbClientContext);
  if (client === null) {
    throw new Error(
      "useClient() must be called inside an <EbbProvider>. " +
        "Wrap the tree in <EbbProvider client={client}> at the app root.",
    );
  }
  return client;
}
