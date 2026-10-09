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
import { defineRelationship, type RelationshipDef } from "./relationship";
import type { CollaborativeTextSchema } from "./entity";
import type { TSchema } from "@sinclair/typebox/type";
import { assertAccessorNameAvailable, assertEntityNameAvailable } from "./reserved";
import {
  buildTextDocumentEntity,
  DEFAULT_DOCUMENT_ENTITY,
  isCollaborativeText,
} from "../fields/collaborative-text/schema";
import {
  entityGroupSystemEntity,
  groupMemberSystemEntity,
  groupSystemEntity,
  relationshipSystemEntity,
} from "./system-entities";

type AnyEntityDef = EntityDef<Record<string, TSchema>>;
type AnyRelationshipDef = RelationshipDef<AnyEntityDef, AnyEntityDef>;

/**
 * Raised when an entity declares a derived field whose accessor name
 * collides with a user-declared relationship on the same source. The
 * registry would otherwise overwrite the user's relationship silently.
 */
export class DerivedFieldCollisionError extends Error {
  constructor(sourceName: string, field: string) {
    super(
      `Entity "${sourceName}" declares the derived field "${field}" and also a ` +
        `relationship with the same accessor; rename one of them.`,
    );
    this.name = "DerivedFieldCollisionError";
  }
}

/** Document entity name a derived field expands to. */
type ExpandedDocName<F> =
  F extends CollaborativeTextSchema<infer E>
    ? [E] extends [string]
      ? E
      : typeof DEFAULT_DOCUMENT_ENTITY
    : never;

/** Every document entity name contributed by `TEntities`' derived fields. */
type DerivedDocNames<TEntities> = {
  [K in keyof TEntities]: TEntities[K] extends EntityDef<infer F, string>
    ? ExpandedDocName<F[keyof F]>
    : never;
}[keyof TEntities];

/**
 * The entity map `defineSchema` exposes: the user's entities plus one
 * generated document entity per derived body (keyed by its document
 * name). The generated entities are erased to `AnyEntityDef`; the
 * per-field typing that matters lives on the parent's derived
 * accessors.
 */
export type ExpandedEntities<TEntities extends Record<string, AnyEntityDef>> = TEntities &
  Record<DerivedDocNames<TEntities> & string, AnyEntityDef>;

/**
 * Raised when `defineSchema` sees a relationship whose source or
 * target entity was never registered. Without this check the row type
 * promises an accessor the runtime cannot build, so the omission
 * surfaces later as an `undefined` at the call site rather than as a
 * schema-authoring error here.
 */
export class UnregisteredRelationshipEndpointError extends Error {
  /** Name of the missing entity — the one to add to `entities`. */
  readonly entityName: string;
  /** Which end of the relationship `entityName` occupies. */
  readonly role: "source" | "target";
  /** `as` accessor on the source that would have resolved the endpoint. */
  readonly accessor: string;

  constructor(info: {
    entityName: string;
    role: "source" | "target";
    sourceName: string;
    accessor: string;
  }) {
    const reference =
      info.role === "source"
        ? `relationship "${info.accessor}" references its source entity "${info.entityName}"`
        : `relationship "${info.accessor}" on entity "${info.sourceName}" references ` +
          `target entity "${info.entityName}"`;
    super(
      `Schema ${reference}, which is not registered. Add "${info.entityName}" to the ` +
        `"entities" map passed to defineSchema.`,
    );
    this.name = "UnregisteredRelationshipEndpointError";
    this.entityName = info.entityName;
    this.role = info.role;
    this.accessor = info.accessor;
  }
}

/**
 * Assert that both endpoints of `rel` are registered. Called after
 * every entity (system and user) is registered, so `registry` mirrors
 * the full set `defineSchema` will expose. A dangling endpoint is a
 * schema-authoring bug: `buildRowAccessors` would otherwise type-check
 * the accessor but drop it at runtime.
 */
function assertRelationshipEndpointsRegistered(
  rel: AnyRelationshipDef,
  registry: EntityRegistry,
): void {
  const endpoints = [
    ["source", rel.source.name],
    ["target", rel.target.name],
  ] as const;
  for (const [role, entityName] of endpoints) {
    if (registry.has(entityName)) continue;
    throw new UnregisteredRelationshipEndpointError({
      entityName,
      role,
      sourceName: rel.source.name,
      accessor: rel.as,
    });
  }
}

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
 * system entities (`relationship`, `group`, `groupMember`,
 * `entityGroup`) are registered alongside user entities so the
 * public relationship-write path (`link` / `unlink` / `setLinks`)
 * can submit Relationship Updates and the membership write path can
 * submit `entityGroup` Updates. Membership is a dedicated
 * `entityGroup` row, not an injected relationship. The registry owns
 * the cardinality / overwrite rules; this builder delegates without
 * adding its own. A relationship whose source or target is neither a
 * system entity nor a member of `entities` throws
 * `UnregisteredRelationshipEndpointError` before the schema is frozen.
 */
export function defineSchema<
  TEntities extends Record<string, AnyEntityDef>,
  TRelationships extends Record<string, AnyRelationshipDef> = Record<string, never>,
>(
  input: DefineSchemaInput<TEntities, TRelationships>,
): Schema<ExpandedEntities<TEntities>, TRelationships> {
  const expanded = expandDerivedFields(input.entities, input.relationships);
  const registry = new EntityRegistry();
  seedRegistry(registry, expanded.entities, expanded.relationships);
  return Object.freeze({
    entities: expanded.entities,
    // Runtime relationships include the generated collaborative-text
    // edges; the static `TRelationships` stays the caller's map so the
    // typed row accessors are derived from declared relationships only
    // (the derived accessors supply the body's own type).
    relationships: expanded.relationships,
    version: input.version,
    minSupportedVersion: input.minSupportedVersion,
    _registry: registry,
  }) as unknown as Schema<ExpandedEntities<TEntities>, TRelationships>;
}

/**
 * Expand each entity's derived fields into a document entity plus a
 * `collaborative-text` relationship. The generated document entity is
 * merged into the returned entity map so it is a first-class registered
 * entity (a `client.<doc>` namespace and an atomic draft), which is
 * also what lets `defineSchema`'s endpoint assertion accept the
 * generated relationship.
 */
export function expandDerivedFields(
  entities: Record<string, AnyEntityDef>,
  relationships: Record<string, AnyRelationshipDef> | undefined,
): {
  entities: Record<string, AnyEntityDef>;
  relationships: Record<string, AnyRelationshipDef> | undefined;
} {
  const expandedEntities: Record<string, AnyEntityDef> = { ...entities };
  let expandedRelationships: Record<string, AnyRelationshipDef> | undefined =
    relationships === undefined ? undefined : { ...relationships };

  for (const entity of Object.values(entities)) {
    const derived = entity.derived as Record<string, { kind: string; entity?: string }> | undefined;
    if (derived === undefined) continue;
    for (const [field, marker] of Object.entries(derived)) {
      if (!isCollaborativeText(marker)) continue;
      const table = (expandedRelationships ??= {});
      const collision = Object.values(table).some(
        (rel) => rel.source.name === entity.name && rel.as === field,
      );
      if (collision) throw new DerivedFieldCollisionError(entity.name, field);

      const docName = marker.entity ?? DEFAULT_DOCUMENT_ENTITY;
      const docEntity = expandedEntities[docName] ?? buildTextDocumentEntity(docName);
      expandedEntities[docName] = docEntity;
      table[`${entity.name}::${field}`] = defineRelationship({
        source: entity,
        target: docEntity,
        as: field,
        sourceCardinality: "one",
        kind: "collaborative-text",
      });
    }
  }

  return { entities: expandedEntities, relationships: expandedRelationships };
}

/**
 * Register the system entities and the user entities/relationships
 * onto `registry`. Shared by `defineSchema` and the per-client
 * registry builder so the two can't drift. Rejects app-authored
 * names that collide with the reserved system / membership names,
 * and relationships whose source or target entity is not registered.
 */
export function seedRegistry(
  registry: EntityRegistry,
  entities: Record<string, AnyEntityDef>,
  relationships: Record<string, AnyRelationshipDef> | undefined,
): void {
  registry.register(relationshipSystemEntity);
  registry.register(groupSystemEntity);
  registry.register(groupMemberSystemEntity);
  registry.register(entityGroupSystemEntity);
  for (const entity of Object.values(entities)) {
    assertEntityNameAvailable(entity.name);
    registry.register(entity);
  }
  if (relationships !== undefined) {
    for (const rel of Object.values(relationships)) {
      assertRelationshipEndpointsRegistered(rel, registry);
      assertAccessorNameAvailable(rel.source.name, rel.as);
      registry.registerRelationship(rel);
    }
  }
}
