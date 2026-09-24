/**
 * `defineSchema` — composes per-entity and per-relationship definitions
 * into a single `Schema` value the rest of the SDK consumes.
 *
 * The builder is pure: no I/O, no side effects beyond constructing
 * the runtime `EntityRegistry` and freezing the result. It's safe to
 * call at module top level and share the value across clients.
 *
 * The shape today is a thin pass-through over `EntityRegistry`. The
 * relationship slot composes through the same `_registry` instance,
 * so when #149 lands its `defineRelationship` primitive the registry
 * grows a registration method without changing `Schema`'s surface.
 */

import type { EntityDef, FieldMarker } from "./entity";
import { EntityRegistry } from "./entity-registry";

/**
 * The compiled schema handed to `createClient({ schema })`. The
 * `TEntities` / `TRelationships` generics are inferred from the
 * inputs so callers see typed entity and relationship shapes without
 * an explicit annotation.
 *
 * `_registry` is prefixed with `_` to signal "internal — read at your
 * own risk." The SDK uses it to seed the per-client
 * `EntityRegistry`; app code should treat the schema as immutable
 * and access entities via `schema.entities.<name>` instead.
 */
export interface Schema<
  TEntities extends Record<string, EntityDef<Record<string, FieldMarker>>>,
  TRelationships = undefined,
> {
  readonly entities: TEntities;
  /**
   * Optional relationship map. The shape is intentionally open
   * (`Record<string, unknown>`) because #149's
   * `defineRelationship` primitive is still in flight; once it
   * lands this becomes `TRelationships` and the registry composes
   * relationships through the same registration path. When
   * `defineSchema` is called without a `relationships` input,
   * `relationships` is `undefined` at runtime so callers can
   * distinguish "no relationships" from "an empty relationship
   * map" — that distinction matters once #149 lands its
   * relationship cardinality checks.
   */
  readonly relationships: TRelationships | undefined;
  /** Schema version advertised to the server on handshake. */
  readonly version: number;
  /**
   * Lower bound of acceptable server-compatibility versions. When
   * set, the server can reject connections whose stored schema is
   * older than this floor (server-side rejection logic lives in
   * #124). When omitted, the client only advertises `version`.
   */
  readonly minSupportedVersion?: number;
  /** Runtime registry seeded by `defineSchema`. */
  readonly _registry: EntityRegistry;
}

/**
 * Inputs accepted by `defineSchema`. Mirrors {@link Schema} but
 * without the derived `_registry` and with both `relationships` and
 * `minSupportedVersion` optional so callers can omit them while
 * authoring the first draft of a schema.
 */
export interface DefineSchemaInput<
  TEntities extends Record<string, EntityDef<Record<string, FieldMarker>>>,
  TRelationships extends Record<string, unknown> = Record<string, never>,
> {
  readonly entities: TEntities;
  readonly relationships?: TRelationships;
  readonly version: number;
  readonly minSupportedVersion?: number;
}

/**
 * Compose per-entity and per-relationship definitions into a single
 * `Schema` value. The result is frozen so accidental mutation is a
 * hard error rather than a silent failure.
 *
 * Each entry of `entities` is registered into a fresh
 * `EntityRegistry`; that registry is exposed on `_registry` for the
 * SDK to seed per-client validation. The builder performs no
 * validation of the entity shapes — `defineEntity` already does that
 * and `EntityRegistry` enforces field-name membership at write /
 * query time.
 */
export function defineSchema<
  TEntities extends Record<string, EntityDef<Record<string, FieldMarker>>>,
  TRelationships extends Record<string, unknown> = Record<string, never>,
>(input: DefineSchemaInput<TEntities, TRelationships>): Schema<TEntities, TRelationships> {
  const registry = new EntityRegistry();
  for (const entity of Object.values(input.entities)) {
    registry.register(entity);
  }
  return Object.freeze({
    entities: input.entities,
    relationships: input.relationships,
    version: input.version,
    minSupportedVersion: input.minSupportedVersion,
    _registry: registry,
  }) as Schema<TEntities, TRelationships>;
}
