/**
 * `defineRelationship` — typed link between two `defineEntity` outputs.
 *
 * The builder is a pure factory returning a frozen relationship
 * definition; no behavior at registration time. The runtime registry
 * (`EntityRegistry`) consumes the definition when the caller registers
 * it, and the row accessors on `client.<entity>.get(id)` consume it
 * for traversal.
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
 * Wire-level edge kind. `"member"` marks an entity↔Group membership
 * edge; `"link"` a domain edge. The server identifies membership by
 * this value, so an app-authored domain edge must stay `"link"` (the
 * default).
 */
export type RelationshipKind = "link" | "member";

/**
 * Definition of one typed link between two entity definitions. Returned
 * by `defineRelationship`; consumed by `EntityRegistry.registerRelationship`
 * and the row accessors.
 *
 * `S` and `T` flow from the source and target `EntityDef` values so the
 * relationship knows the entity names it links. `A` carries the literal
 * `as` accessor name and `C` the literal `sourceCardinality`, so a
 * type-level walker can pick the right accessor value type per slot.
 */
export interface RelationshipDef<
  S extends EntityDef<Record<string, TSchema>>,
  T extends EntityDef<Record<string, TSchema>>,
  A extends string = string,
  C extends SourceCardinality = SourceCardinality,
> {
  readonly source: S;
  readonly target: T;
  /**
   * Accessor name on the source (the field name) and the lookup key
   * for the row accessor. Single source of truth: the field on the
   * source and the accessor key on
   * `client.<entity>.get(id)`.
   */
  readonly as: A;
  readonly sourceCardinality: C;
  /**
   * Wire-level `relationship_type` string carried on the `Relationship`
   * Update's `data.fields.type` value. Defaults to the source entity
   * name. Override for descriptive wire debugging.
   */
  readonly type: string;
  /**
   * Wire-level `kind` carried on the `Relationship` Update's
   * `data.fields.kind` value. Defaults to `"link"`; the injected
   * membership relationship declares `"member"`.
   */
  readonly kind: RelationshipKind;
}

/**
 * Input shape for `defineRelationship`. `sourceCardinality` and `type`
 * are optional; `sourceCardinality` is `"one"` and `type` is the source
 * entity name when omitted.
 */
export interface DefineRelationshipInput<
  S extends EntityDef<Record<string, TSchema>>,
  T extends EntityDef<Record<string, TSchema>>,
  A extends string = string,
  C extends SourceCardinality = SourceCardinality,
> {
  source: S;
  target: T;
  as: A;
  sourceCardinality?: C;
  type?: string;
  kind?: RelationshipKind;
}

/** Define a relationship by source, target, and accessor name. Frozen. */
export function defineRelationship<
  S extends EntityDef<Record<string, TSchema>>,
  T extends EntityDef<Record<string, TSchema>>,
  const A extends string,
  const C extends SourceCardinality = "one",
>(opts: DefineRelationshipInput<S, T, A, C>): RelationshipDef<S, T, A, C> {
  const sourceCardinality = (opts.sourceCardinality ?? "one") as C;
  const type: string = opts.type ?? opts.source.name;
  return Object.freeze({
    source: opts.source,
    target: opts.target,
    as: opts.as,
    sourceCardinality,
    type,
    kind: opts.kind ?? "link",
  });
}
