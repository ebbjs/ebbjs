/**
 * Declaring ephemeral presence channels (#677).
 *
 * Presence is the one part of the framework that is not about durable
 * data: it never enters the Action log, it is lossy on disconnect, and the
 * server holds no state for it. An app declares the shapes it broadcasts
 * with `definePresence(...)` and passes the result to `createClient({ presence })`.
 * A client without a registry still has `client.presence`; its channels are
 * dynamic strings and its values unvalidated `unknown`.
 *
 * A channel is either a bare TypeBox schema or `{schema, debounceMs?, ttlMs?,
 * maxEntries?}`. The registry is pure data: normalized to each channel's
 * effective config and frozen, so nothing downstream can drift from what the
 * app declared.
 */

import type { TSchema } from "@sinclair/typebox/type";

/** Default coalescing window for a channel's outgoing sends. */
export const DEFAULT_PRESENCE_DEBOUNCE_MS = 100;
/**
 * Default receiver-side staleness TTL. The server emits no leave event, so a
 * peer that stops sending can only be aged out locally.
 */
export const DEFAULT_PRESENCE_TTL_MS = 30_000;
/** Default cap on observed entries per `(entity, channel)`. */
export const DEFAULT_PRESENCE_MAX_ENTRIES = 100;
/**
 * Largest serialized `{entity_id, data}` body the client will POST. The
 * server's own caps are separate (#678); this one exists so an oversized
 * payload fails at the call site instead of being silently dropped.
 */
export const MAX_PRESENCE_PAYLOAD_BYTES = 8 * 1024;

/** Per-channel transport and receive knobs, all optional. */
export interface PresenceChannelOptions {
  /** Trailing-debounce window for sends on this channel, in ms. */
  readonly debounceMs?: number;
  /**
   * How long an observed entry stays live without a fresh send, in ms.
   * `Infinity` opts the channel out of expiry.
   */
  readonly ttlMs?: number;
  /** Maximum observed entries per `(entity, channel)`. */
  readonly maxEntries?: number;
}

/** One channel declaration: a schema, or a schema plus options. */
export type PresenceChannelSpec = TSchema | (PresenceChannelOptions & { readonly schema: TSchema });

/** The channel map handed to `definePresence`. */
export type PresenceChannels = Readonly<Record<string, PresenceChannelSpec>>;

/** A channel's effective config: the schema plus every default filled in. */
export interface PresenceChannelConfig<S extends TSchema = TSchema> {
  readonly schema: S;
  readonly debounceMs: number;
  readonly ttlMs: number;
  readonly maxEntries: number;
}

/** The config a channel spec normalizes to, preserving the schema's type. */
export type NormalizedPresenceChannel<C> = C extends TSchema
  ? PresenceChannelConfig<C>
  : C extends { readonly schema: infer S extends TSchema }
    ? PresenceChannelConfig<S>
    : PresenceChannelConfig;

/**
 * A declared presence registry. The channel map is carried in the type so
 * the client's `presence` surface can derive channel names and
 * `Static<schema>` value types from it.
 */
export type PresenceRegistry<C extends PresenceChannels = PresenceChannels> = {
  readonly channels: { readonly [K in keyof C]: NormalizedPresenceChannel<C[K]> };
};

/**
 * A registry of unknown channels: what a client without a declaration holds.
 * The client only reads `channels`; it never needs the declared spec types.
 */
export type AnyPresenceRegistry = {
  readonly channels: Readonly<Record<string, PresenceChannelConfig>>;
};

/**
 * Normalize and freeze a channel map. Pure: the returned registry is a new
 * object, its `channels` map is frozen, and so is every channel config.
 *
 * ```ts
 * const presence = definePresence({
 *   camera: { schema: Type.Object({x: Type.Number(), y: Type.Number()}), ttlMs: 5_000 },
 *   tool: Type.String(),
 * });
 * ```
 */
export function definePresence<C extends PresenceChannels>(channels: C): PresenceRegistry<C> {
  const normalized: Record<string, PresenceChannelConfig> = {};
  for (const [name, spec] of Object.entries(channels)) {
    const options = isChannelOptions(spec) ? spec : { schema: spec };
    normalized[name] = Object.freeze({
      schema: options.schema,
      debounceMs: options.debounceMs ?? DEFAULT_PRESENCE_DEBOUNCE_MS,
      ttlMs: options.ttlMs ?? DEFAULT_PRESENCE_TTL_MS,
      maxEntries: options.maxEntries ?? DEFAULT_PRESENCE_MAX_ENTRIES,
    });
  }
  return Object.freeze({ channels: Object.freeze(normalized) }) as PresenceRegistry<C>;
}

/** A send or clear named a channel the client's registry does not declare. */
export class UndeclaredPresenceChannelError extends Error {
  readonly channel: string;
  readonly declared: readonly string[];

  constructor(channel: string, declared: readonly string[]) {
    const known = declared.length === 0 ? "(none)" : declared.join(", ");
    super(`presence channel "${channel}" is not declared; declared channels: ${known}`);
    this.name = "UndeclaredPresenceChannelError";
    this.channel = channel;
    this.declared = declared;
  }
}

/** A value failed `Value.Check` against the channel's declared schema. */
export class PresenceValidationError extends Error {
  readonly channel: string;
  readonly value: unknown;

  constructor(channel: string, value: unknown) {
    super(`presence value for channel "${channel}" does not match its declared schema`);
    this.name = "PresenceValidationError";
    this.channel = channel;
    this.value = value;
  }
}

/** A serialized send body exceeded {@link MAX_PRESENCE_PAYLOAD_BYTES}. */
export class PresencePayloadTooLargeError extends Error {
  readonly entityId: string;
  readonly channel: string;
  readonly bytes: number;
  readonly limit: number;

  constructor(args: { entityId: string; channel: string; bytes: number; limit: number }) {
    super(
      `presence payload for channel "${args.channel}" on "${args.entityId}" is ${args.bytes} bytes, over the ${args.limit}-byte limit`,
    );
    this.name = "PresencePayloadTooLargeError";
    this.entityId = args.entityId;
    this.channel = args.channel;
    this.bytes = args.bytes;
    this.limit = args.limit;
  }
}

const isChannelOptions = (
  spec: PresenceChannelSpec,
): spec is PresenceChannelOptions & { readonly schema: TSchema } =>
  typeof (spec as { readonly schema?: unknown }).schema !== "undefined";
