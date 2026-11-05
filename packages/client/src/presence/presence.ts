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
import {
  createPresenceStore,
  type PeerPresence,
  type PresenceChange,
  type PresenceStore,
} from "./store";
import { createPresenceTransport, type PresenceTransport } from "./transport";

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

/** The normalized channel map behind a registry type. */
export type PresenceChannelsOf<R> = R extends { readonly channels: infer C }
  ? C extends Readonly<Record<string, PresenceChannelConfig>>
    ? C
    : Readonly<Record<string, PresenceChannelConfig>>
  : Readonly<Record<string, PresenceChannelConfig>>;

/**
 * The `client.presence` surface. With a declared registry the channel name and
 * the value type are checked at the call site; without one, channels are
 * dynamic strings and values are unvalidated `unknown`.
 */
export type PresenceApi<R = undefined> = R extends AnyPresenceRegistry
  ? TypedPresenceApi<PresenceChannelsOf<R>>
  : UntypedPresenceApi;

/** `client.presence` on a client built without a registry. */
export interface UntypedPresenceApi {
  set(entityId: string, channel: string, value: unknown): void;
  clear(entityId: string, channel: string): void;
  forEntity<T = unknown>(entityId: string, channel: string): ReadonlyMap<string, PeerPresence<T>>;
  onUpdate(callback: (change: PresenceChange) => void): () => void;
  /** Send every pending (debounced) write now; resolves once they settle. */
  flush(): Promise<void>;
}

/** `client.presence` on a client built with `definePresence(...)`. */
export interface TypedPresenceApi<C extends Readonly<Record<string, PresenceChannelConfig>>> {
  set<K extends keyof C & string>(entityId: string, channel: K, value: PresenceValue<C, K>): void;
  clear(entityId: string, channel: keyof C & string): void;
  forEntity<K extends keyof C & string>(
    entityId: string,
    channel: K,
  ): ReadonlyMap<string, PeerPresence<PresenceValue<C, K>>>;
  onUpdate(callback: (change: PresenceChange) => void): () => void;
  /** Send every pending (debounced) write now; resolves once they settle. */
  flush(): Promise<void>;
}

/**
 * The runtime behind `client.presence`: the public surface plus the two
 * connection hooks the client owns.
 */
export interface Presence extends UntypedPresenceApi {
  /** Fold one `presence` packet from the live stream into the store. */
  ingest(payload: unknown): void;
  /** Drop every observed peer: the stream that carried them is gone. */
  reset(): void;
  /** Cancel pending sends; the client is shutting down. */
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
export function createPresence(opts: PresenceOptions): Presence {
  const channels = opts.registry?.channels;
  const declared = channels === undefined ? [] : Object.keys(channels);
  const store: PresenceStore = createPresenceStore({
    localActorId: opts.actorId,
    channels,
  });
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
    },

    clear(entityId, channel) {
      assertChannel(channel);
      transport.send(entityId, channel, null);
    },

    forEntity<T>(entityId: string, channel: string): ReadonlyMap<string, PeerPresence<T>> {
      return store.forEntity<T>(entityId, channel);
    },

    onUpdate(callback) {
      return store.onUpdate(callback);
    },

    flush() {
      return transport.flush();
    },

    ingest(payload) {
      store.ingest(payload);
    },

    reset() {
      store.clear();
    },

    close() {
      transport.cancel();
      store.close();
    },
  };
}
