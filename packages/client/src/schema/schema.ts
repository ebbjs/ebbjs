/**
 * `defineSchema` — composes per-entity and per-relationship definitions
 * into a single `Schema` value the rest of the SDK consumes.
 *
 * The builder is pure: no I/O, no side effects beyond constructing
 * the runtime `EntityRegistry` and freezing the result. It's safe to
 * call at module top level and share the value across clients.
 */

import type { EntityDef, FieldMarker } from "./entity";
import { EntityRegistry } from "./entity-registry";

/**
 * The compiled schema handed to `createClient({ schema })`. The
 * `TEntities` / `TRelationships` generics are inferred from the
 * inputs so callers see typed entity and relationship shapes without
 * an explicit annotation.
 */
export interface Schema<
  TEntities extends Record<string, EntityDef<Record<string, FieldMarker>>>,
  TRelationships = undefined,
> {
  readonly entities: TEntities;
  /**
   * Optional relationship map. When `defineSchema` is called without a
   * `relationships` input, `relationships` is `undefined` at runtime so
   * callers can distinguish "no relationships" from "an empty
   * relationship map".
   */
  readonly relationships: TRelationships | undefined;
  /** Schema version advertised to the server on handshake. */
  readonly version: number;
  /**
   * Lower bound of acceptable server-compatibility versions. When
   * set, the server can reject connections whose stored schema is
   * older than this floor. When omitted, the client only advertises
   * `version`.
   */
  readonly minSupportedVersion?: number;
  /** Runtime registry seeded by `defineSchema`. */
  readonly _registry: EntityRegistry;
}

/**
 * Inputs accepted by `defineSchema`. Mirrors {@link Schema} but
 * without the derived `_registry` and with `relationships` and
 * `minSupportedVersion` optional.
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
