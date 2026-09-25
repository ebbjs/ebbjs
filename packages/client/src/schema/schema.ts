/**
 * `defineSchema` — composes per-entity and per-relationship definitions
 * into a single `Schema` value the rest of the SDK consumes.
 *
 * The builder is pure: no I/O, no side effects beyond constructing
 * the runtime `EntityRegistry` and freezing the result. It's safe to
 * call at module top level and share the value across clients.
 */

import type { EntityDef } from "./entity";
import { EntityRegistry } from "./entity-registry";
import type { RelationshipDef } from "./relationship";
import type { TSchema } from "@sinclair/typebox/type";

type AnyEntityDef = EntityDef<Record<string, TSchema>>;
type AnyRelationshipDef = RelationshipDef<AnyEntityDef, AnyEntityDef>;

/**
 * The compiled schema handed to `createClient({ schema })`. The
 * `TEntities` / `TRelationships` generics are inferred from the
 * inputs so callers see typed entity and relationship shapes without
 * an explicit annotation.
 *
 * `TRelationships` defaults to `undefined` so callers that omit the
 * `relationships` slot get a clean `s.relationships === undefined`
 * at the type level. Passing `relationships` narrows it to the
 * specific Record type.
 */
export interface Schema<
  TEntities extends Record<string, AnyEntityDef>,
  TRelationships = undefined,
> {
  readonly entities: TEntities;
  /**
   * Relationship map. `undefined` when no `relationships` input was
   * passed to `defineSchema`; a populated Record otherwise. Empty
   * `{}` and `undefined` are distinguishable at runtime so callers
   * can tell "no relationships declared" from "explicitly empty".
   */
  readonly relationships: TRelationships;
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
  TEntities extends Record<string, AnyEntityDef>,
  TRelationships extends Record<string, AnyRelationshipDef> = Record<string, never>,
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
 * Entities are registered with `EntityRegistry.register` and
 * relationships with `EntityRegistry.registerRelationship`. The
 * registry owns the cardinality / overwrite rules; this builder
 * delegates without adding its own.
 */
export function defineSchema<
  TEntities extends Record<string, AnyEntityDef>,
  TRelationships extends Record<string, AnyRelationshipDef> = Record<string, never>,
>(input: DefineSchemaInput<TEntities, TRelationships>): Schema<TEntities, TRelationships> {
  const registry = new EntityRegistry();
  for (const entity of Object.values(input.entities)) {
    registry.register(entity);
  }
  if (input.relationships !== undefined) {
    for (const rel of Object.values(input.relationships)) {
      registry.registerRelationship(rel);
    }
  }
  return Object.freeze({
    entities: input.entities,
    relationships: input.relationships,
    version: input.version,
    minSupportedVersion: input.minSupportedVersion,
    _registry: registry,
  }) as Schema<TEntities, TRelationships>;
}
