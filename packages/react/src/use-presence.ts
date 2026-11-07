import { useMemo, useSyncExternalStore } from "react";
import type {
  PeerPresence,
  PresenceChannelConfig,
  PresenceValue,
  TypedPresenceApi,
} from "@ebbjs/client";

import { useClient, type ErasedClient } from "./context";

/** The presence surface a client type carries, typed or not. */
type PresenceApiOf<C> = C extends { readonly presence: infer P } ? P : never;

/**
 * The channel map a client type declares, or the dynamic one an untyped client
 * falls back to. The registry rides the typed `presence` surface, so naming
 * its channels here keeps the hook's types sourced from `definePresence`.
 */
type ChannelsOf<C> =
  PresenceApiOf<C> extends TypedPresenceApi<infer Ch>
    ? Ch extends Readonly<Record<string, PresenceChannelConfig>>
      ? Ch
      : Readonly<Record<string, PresenceChannelConfig>>
    : Readonly<Record<string, PresenceChannelConfig>>;

/**
 * The presence channel names a client type declares. A client built without
 * `definePresence` declares none in particular, so every string is one.
 */
export type PresenceChannelOf<C> = keyof ChannelsOf<C> & string;

/**
 * The peer map {@link usePresence} returns for one channel: actor id to the
 * payload that actor last sent, typed from the channel's declared schema.
 */
export type PresencePeerMapOf<C, K extends PresenceChannelOf<C>> = ReadonlyMap<
  string,
  PeerPresence<PresenceValue<ChannelsOf<C>, K>>
>;

/** The store seam `useSyncExternalStore` needs, keyed to one `(entity, channel)`. */
interface PresenceSubscription {
  readonly subscribe: (onStoreChange: () => void) => () => void;
  readonly getSnapshot: () => ReadonlyMap<string, PeerPresence>;
}

/**
 * Subscribe a component to the peers observed on one presence channel of one
 * entity.
 *
 * ```tsx
 * const cameras = usePresence<Camera>("plan_1", "camera");
 * for (const [actorId, peer] of cameras) draw(actorId, peer.data);
 * ```
 *
 * The snapshot is `client.presence.forEntity(entityId, channel)`; the
 * subscription is `client.presence.onUpdate` filtered to the same target, so
 * a 20 Hz camera channel does not re-render a cursor consumer. The store
 * notifies on a peer's packet, on TTL expiry, and on stream reset, so a peer
 * that leaves stops rendering instead of leaving a stale cursor behind.
 *
 * `T` is the payload type the caller reads; pass it when the component does
 * not get a bound hook from {@link createEbbHooks}, which types the channel
 * and its payload from the client's `definePresence` registry instead.
 */
export function usePresence<T = unknown>(
  entityId: string,
  channel: string,
): ReadonlyMap<string, PeerPresence<T>> {
  const client = useClient();
  const subscription = useMemo(
    () => createPresenceSubscription(client, entityId, channel),
    [client, entityId, channel],
  );
  // SAFETY: `T` is the caller's claim about the channel's declared schema; the
  // map's entries are the store's own, so only the payload type is asserted.
  return useSyncExternalStore(subscription.subscribe, subscription.getSnapshot) as ReadonlyMap<
    string,
    PeerPresence<T>
  >;
}

function createPresenceSubscription(
  client: ErasedClient,
  entityId: string,
  channel: string,
): PresenceSubscription {
  let cached: ReadonlyMap<string, PeerPresence> | null = null;

  const subscribe = (onStoreChange: () => void): (() => void) =>
    client.presence.onUpdate((change) => {
      if (change.entityId === entityId && change.channel === channel) onStoreChange();
    });

  const getSnapshot = (): ReadonlyMap<string, PeerPresence> => {
    const next = client.presence.forEntity(entityId, channel);
    if (cached !== null && samePeers(cached, next)) return cached;
    cached = next;
    return next;
  };

  return { subscribe, getSnapshot };
}

/**
 * `useSyncExternalStore` compares snapshots by identity and rejects a
 * `getSnapshot` that mints one per call. `forEntity` is a fresh map per call,
 * so hold the previous map while its entries are the same objects: the store
 * replaces an entry on every packet, which is exactly when a re-render is due.
 */
function samePeers(
  a: ReadonlyMap<string, PeerPresence>,
  b: ReadonlyMap<string, PeerPresence>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [actorId, peer] of a) {
    if (b.get(actorId) !== peer) return false;
  }
  return true;
}
