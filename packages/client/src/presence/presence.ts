/**
 * Ephemeral presence — the client's per-entity, per-channel view of the
 * other actors on the live stream.
 *
 * The server's `/sync/presence` endpoint broadcasts whatever payload we POST
 * to every SSE subscriber for the same entity. Presence therefore rides the
 * single stream `subscribe()` already holds (#666): `SyncClient` folds each
 * `presence` packet into the receive store before the subscriber's `onEvent`
 * sees it, so presence covers exactly the groups you subscribe to, and the
 * peer set is dropped when that stream closes.
 *
 * Three pieces, each with one job:
 *
 *   - `definePresence` (./define) declares channels and their options.
 *   - `createPresenceTransport` (./transport) coalesces sends per
 *     `(entityId, channel)` and POSTs `{entity_id, data: {channel, value}}`.
 *   - `createPresenceStore` (./store) holds `(entityId, channel, actorId)`
 *     entries, applies the channel TTL and entry cap, and reports changes.
 *
 * This module is transport-only (no CodeMirror dependency). The CM6 cursor
 * rendering lives in `@ebbjs/codemirror/src/presence/cursor-decoration` and
 * reads the same `forEntity()` map.
 *
 * Leaving: `leave()` retracts every `(entityId, channel)` this client has
 * announced with a null, so peers drop this actor instead of waiting out the
 * channel's TTL. `close()` is local teardown and sends nothing: a transient
 * remount must not broadcast an absence. A page that is really going away
 * calls `leave({ keepalive: true })` from its unload handler.
 *
 * Network model:
 *   - Outgoing: `POST /sync/presence` with `{entity_id, data: {channel, value}}`
 *   - Incoming: `presence` events on the `/sync/live` stream that
 *     `subscribe()` already holds open
 */

import type { Static, TSchema } from "@sinclair/typebox/type";
import { Value } from "@sinclair/typebox/value";

import {
  UndeclaredPresenceChannelError,
  PresenceValidationError,
  type AnyPresenceRegistry,
  type PresenceChannelConfig,
} from "./define";
import { targetKey } from "./keys";
import {
  createPresenceStore,
  type PeerPresence,
  type PresenceChange,
  type PresenceStore,
} from "./store";
import {
  createPresenceTransport,
  type PresenceSendOptions,
  type PresenceTransport,
} from "./transport";

export {
  definePresence,
  DEFAULT_PRESENCE_DEBOUNCE_MS,
  DEFAULT_PRESENCE_MAX_ENTRIES,
  DEFAULT_PRESENCE_TTL_MS,
  MAX_PRESENCE_PAYLOAD_BYTES,
  PresencePayloadTooLargeError,
  PresenceValidationError,
  UndeclaredPresenceChannelError,
  type AnyPresenceRegistry,
  type NormalizedPresenceChannel,
  type PresenceChannelConfig,
  type PresenceChannelOptions,
  type PresenceChannelSpec,
  type PresenceChannels,
  type PresenceRegistry,
} from "./define";
export {
  createPresenceStore,
  type PeerPresence,
  type PresenceChange,
  type PresenceChannelConfigs,
  type PresenceStore,
  type PresenceStoreOptions,
} from "./store";
export {
  createPresenceTransport,
  type PresenceSendOptions,
  type PresenceTransport,
  type PresenceTransportOptions,
} from "./transport";

/**
 * A local cursor/selection position expressed in run-id coordinates.
 *
 * Presence itself is channel-agnostic; this is the payload shape the
 * collaborative-text demo puts on its `cursor` channel, kept here so the
 * CodeMirror helper and the demo agree on one type.
 */
export interface CursorPresence {
  /** Run id at the selection anchor. */
  readonly anchorId: string;
  /** Offset within the anchor run (0-based). */
  readonly anchorOffset: number;
  /** Run id at the selection head. Equal to anchorId if no selection. */
  readonly headId: string;
  /** Offset within the head run (0-based). */
  readonly headOffset: number;
}

/** The value a declared channel carries: `Static<>` of its schema. */
export type PresenceValue<
  C extends Readonly<Record<string, PresenceChannelConfig>>,
  K extends keyof C,
> = C[K]["schema"] extends TSchema ? Static<C[K]["schema"]> : unknown;

/** The channel map a client's presence is keyed by: declared, or dynamic. */
export type PresenceChannelsMap = Readonly<Record<string, PresenceChannelConfig>>;

/** The normalized channel map behind a registry type. */
export type PresenceChannelsOf<R> = R extends { readonly channels: infer C }
  ? C extends PresenceChannelsMap
    ? C
    : PresenceChannelsMap
  : PresenceChannelsMap;

/**
 * The `client.presence` surface, typed by the channel map. With a declared
 * registry the channel name and the value type are checked at the call site;
 * without one the map is dynamic and payloads are unvalidated `unknown`.
 *
 * One interface rather than a registry/no-registry pair: a registered client
 * must be usable wherever a plain `SyncClient` is, and a caller-named
 * `forEntity<T>` would force it to promise every payload type at once.
 */
export interface PresenceApi<C extends PresenceChannelsMap = PresenceChannelsMap> {
  set<K extends keyof C & string>(entityId: string, channel: K, value: PresenceValue<C, K>): void;
  clear(entityId: string, channel: keyof C & string): void;
  forEntity<K extends keyof C & string>(
    entityId: string,
    channel: K,
  ): ReadonlyMap<string, PeerPresence<PresenceValue<C, K>>>;
  onUpdate(callback: (change: PresenceChange) => void): () => void;
  /** Send every pending (debounced) write now; resolves once they settle. */
  flush(): Promise<void>;
  /**
   * Send a null for every target this client currently claims, then forget
   * them. Best-effort and idempotent: a second call sends nothing.
   * `keepalive` marks the POSTs so a pagehide-issued leave survives page
   * teardown; it defaults to false.
   */
  leave(options?: PresenceSendOptions): Promise<void>;
}

/**
 * The runtime behind `client.presence`: the public surface plus the three
 * connection hooks the client owns.
 */
export interface PresenceRuntime extends PresenceApi {
  /** Fold one `presence` packet from the live stream into the store. */
  ingest(payload: unknown): void;
  /** Drop every observed peer: the stream that carried them is gone. */
  reset(): void;
  /**
   * Local teardown: drop the claimed targets and cancel pending sends. It
   * sends no leave — a transient remount must not broadcast an absence — so a
   * page that is actually going away calls {@link PresenceApi.leave} first.
   */
  close(): void;
}

export interface PresenceOptions {
  readonly serverUrl: string;
  readonly actorId: string;
  readonly fetchImpl: typeof fetch;
  /** Channel declarations; absent means dynamic, unvalidated channels. */
  readonly registry?: AnyPresenceRegistry;
}

/**
 * Build the client's presence runtime. Declared channels validate on send and
 * enforce their options; an undeclared channel on a registered client is a
 * runtime error (JS callers) as well as a compile error (TypeScript callers).
 */
export function createPresence(opts: PresenceOptions): PresenceRuntime {
  const channels = opts.registry?.channels;
  const declared = channels === undefined ? [] : Object.keys(channels);
  const store: PresenceStore = createPresenceStore({
    localActorId: opts.actorId,
    channels,
  });
  /**
   * The `(entity, channel)` targets this session has announced state on, so
   * `leave()` can retract exactly those and nothing else.
   */
  const claimed = new Map<string, { readonly entityId: string; readonly channel: string }>();
  const transport: PresenceTransport = createPresenceTransport({
    serverUrl: opts.serverUrl,
    actorId: opts.actorId,
    fetchImpl: opts.fetchImpl,
    channels,
  });

  /**
   * Resolve a channel's config, or `null` on an untyped client. A registered
   * client must not send on a channel it never declared: peers would receive a
   * shape no one agreed to.
   */
  const assertChannel = (channel: string): PresenceChannelConfig | null => {
    if (channels === undefined) return null;
    const config = channels[channel];
    if (config === undefined) throw new UndeclaredPresenceChannelError(channel, declared);
    return config;
  };

  return {
    set(entityId, channel, value) {
      const config = assertChannel(channel);
      if (config !== null && !Value.Check(config.schema, value)) {
        throw new PresenceValidationError(channel, value);
      }
      transport.send(entityId, channel, value);
      claimed.set(targetKey(entityId, channel), { entityId, channel });
    },

    clear(entityId, channel) {
      assertChannel(channel);
      transport.send(entityId, channel, null);
      // The null just announced our absence, so there is nothing left to
      // retract for this target.
      claimed.delete(targetKey(entityId, channel));
    },

    forEntity(entityId, channel) {
      return store.forEntity(entityId, channel);
    },

    onUpdate(callback) {
      return store.onUpdate(callback);
    },

    flush() {
      return transport.flush();
    },

    async leave(options) {
      const targets = [...claimed.values()];
      claimed.clear();
      for (const target of targets) {
        transport.send(target.entityId, target.channel, null, {
          keepalive: options?.keepalive === true,
        });
      }
      // The page may be gone before the debounce fires: post now.
      await transport.flush();
    },

    ingest(payload) {
      store.ingest(payload);
    },

    reset() {
      store.clear();
    },

    close() {
      claimed.clear();
      transport.cancel();
      store.close();
    },
  };
}
