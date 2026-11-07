import { createContext, useContext, type ReactNode } from "react";
import type { SyncClient } from "@ebbjs/client";

import { useLeaveOnPageHide } from "./use-presence-leave";

/**
 * The app's client, erased to `SyncClient`: the caller's type re-enters at
 * {@link useClient}, so one cast there keeps call sites cast-free. `null` is
 * the "no provider" sentinel, turned into a loud error by the same hook.
 */
const EbbClientContext = createContext<SyncClient | null>(null);

export interface EbbProviderProps<C extends SyncClient = SyncClient> {
  /** The sync client every hook below reads and subscribes to. */
  readonly client: C;
  readonly children: ReactNode;
}

/**
 * Makes the app's client available to the hooks below it. The caller owns the
 * client, so remounting the tree doesn't tear down the connection.
 *
 * A client built with `definePresence(...)` is accepted because its typed
 * presence is assignable to the plain one: the dynamic channel map yields
 * `unknown` payloads, and the typed surface only narrows them.
 *
 * The provider also leaves presence on `pagehide`: page teardown is the one
 * moment an actor really is gone, and it is not a React lifetime, so no hook
 * in the tree would see it. It does not call `client.close()` — a remount, a
 * route swap, or a client swap unmounts the provider without the actor
 * leaving — and it does not own the client.
 */
export function EbbProvider<C extends SyncClient = SyncClient>({
  client,
  children,
}: EbbProviderProps<C>) {
  useLeaveOnPageHide(client);

  return <EbbClientContext.Provider value={client}>{children}</EbbClientContext.Provider>;
}

/**
 * Read the nearest `<EbbProvider>`'s client, typed by the client type — reads
 * and actions in one name:
 *
 * ```tsx
 * type AppClient = typeof client;
 * const bound = useClient<AppClient>();
 * ```
 *
 * Throws outside a provider. {@link createEbbHooks} binds this, `useQuery`,
 * and `usePresence` once so components need no generic at all.
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
