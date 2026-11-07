import { createContext, useContext, type ReactNode } from "react";
import type { AnyPresenceRegistry, PeerPresence, PresenceChange, SyncClient } from "@ebbjs/client";

/** The presence surface the hooks read, with the registry erased to dynamic channels. */
interface PresenceSource {
  forEntity(entityId: string, channel: string): ReadonlyMap<string, PeerPresence<unknown>>;
  onUpdate(callback: (change: PresenceChange) => void): () => void;
}

/**
 * The provider's view of the app's client: its presence registry erased, so
 * every client yields the one non-generic `forEntity` the hooks call. Internal
 * to the provider; the public constraint is {@link EbbClient}.
 */
export type ErasedClient = Omit<SyncClient, "presence"> & {
  readonly presence: PresenceSource;
};

/**
 * A client the hooks accept: built with no presence registry, or with any
 * `definePresence(...)` registry.
 *
 * Both arms are the real class, so the provider keeps its nominal check — an
 * object that merely looks like a client is not one. Naming only
 * `SyncClient<undefined>` rejects every client with a registry, because a typed
 * `forEntity` promises a narrower map than the untyped one.
 */
export type EbbClient = SyncClient<undefined> | SyncClient<AnyPresenceRegistry>;

/**
 * The app's client, erased to {@link ErasedClient}: the caller's type re-enters
 * at {@link useClient}, so one cast there keeps call sites cast-free. `null` is
 * the "no provider" sentinel, turned into a loud error by the same hook.
 */
const EbbClientContext = createContext<ErasedClient | null>(null);

export interface EbbProviderProps<C extends EbbClient = EbbClient> {
  /** The sync client every hook below reads and subscribes to. */
  readonly client: C;
  readonly children: ReactNode;
}

/**
 * Makes the app's client available to the hooks below it. The caller owns the
 * client, so remounting the tree doesn't tear down the connection.
 */
export function EbbProvider<C extends EbbClient = EbbClient>({
  client,
  children,
}: EbbProviderProps<C>) {
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
export function useClient<C extends EbbClient = SyncClient>(): C {
  const client = useContext(EbbClientContext);
  if (client === null) {
    throw new Error(
      "useClient() must be called inside an <EbbProvider>. " +
        "Wrap the tree in <EbbProvider client={client}> at the app root.",
    );
  }
  return client as C;
}
