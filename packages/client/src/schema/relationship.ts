/**
 * `defineRelationship` — typed link between two `defineEntity` outputs.
 *
 * The builder is a pure factory returning a frozen relationship
 * definition; no behavior at registration time. The runtime registry
 * (`EntityRegistry`) consumes the definition when the caller registers
 * it, and `SyncClient.relationship({...})` consumes it to produce a
 * traversal handle.
 *
 * Both ends of the link must be `defineEntity` outputs. The wire shape
 * (`Relationship` system entity in `@ebbjs/core`) is unchanged; this
 * builder is the schema-layer surface that produces wire Updates via
 * `SyncClient.buildRelationshipWrite`.
 */

import type { EntityDef } from "./entity";
import type { TSchema } from "@sinclair/typebox/type";

/**
 * Source-side cardinality. Describes how the source entity holds the
 * pointer to the target. The reverse direction is always a collection
 * (no need to express it here).
 */
export type SourceCardinality = "one" | "many";

/**
 * Definition of one typed link between two entity definitions. Returned
 * by `defineRelationship`; consumed by `EntityRegistry.registerRelationship`
 * and `SyncClient.relationship({...})`.
 *
 * `S` and `T` flow from the source and target `EntityDef` values so the
 * relationship knows the entity names it links.
 */
export interface RelationshipDef<
  S extends EntityDef<Record<string, TSchema>>,
  T extends EntityDef<Record<string, TSchema>>,
> {
  readonly source: S;
  readonly target: T;
  /**
   * Accessor name on the source (the field name) and the lookup key
   * for the primitive handle. Single source of truth: the field on the
   * source and the accessor key for
   * `client.relationship({source, target, as})`.
   */
  readonly as: string;
  readonly sourceCardinality: SourceCardinality;
  /**
   * Wire-level `relationship_type` string carried on the `Relationship`
   * Update's `data.fields.type` value. Defaults to the source entity
   * name. Override for descriptive wire debugging.
   */
  readonly type: string;
}

/**
 * Input shape for `defineRelationship`. `sourceCardinality` and `type`
 * are optional; `sourceCardinality` is `"one"` and `type` is the source
 * entity name when omitted.
 */
export interface DefineRelationshipInput<
  S extends EntityDef<Record<string, TSchema>>,
  T extends EntityDef<Record<string, TSchema>>,
> {
  source: S;
  target: T;
  as: string;
  sourceCardinality?: SourceCardinality;
  type?: string;
}

/** Define a relationship by source, target, and accessor name. Frozen. */
export function defineRelationship<
  S extends EntityDef<Record<string, TSchema>>,
  T extends EntityDef<Record<string, TSchema>>,
>(opts: DefineRelationshipInput<S, T>): RelationshipDef<S, T> {
  const sourceCardinality: SourceCardinality = opts.sourceCardinality ?? "one";
  const type: string = opts.type ?? opts.source.name;
  return Object.freeze({
    source: opts.source,
    target: opts.target,
    as: opts.as,
    sourceCardinality,
    type,
  });
}
