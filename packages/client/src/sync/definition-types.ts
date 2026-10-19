/**
 * Type-level views of `defineEntity` / `defineRelationship` outputs.
 *
 * The schema keeps entity names and field maps as literals so the
 * namespace and the query builder can derive their typed surfaces from
 * one relationship map. These helpers are the shared walkers for both;
 * they hold no runtime code.
 */

import type { TSchema } from "@sinclair/typebox/type";

import type { EntityDef } from "../schema/entity";
import type { RelationshipDef } from "../schema/relationship";

/** An entity definition with its field map erased. */
export type AnyEntityDef = EntityDef<Record<string, TSchema>>;

/** A relationship definition with both endpoints' field maps erased. */
export type AnyRelationshipDef = RelationshipDef<AnyEntityDef, AnyEntityDef>;

/** Literal entity name carried by an `EntityDef`. */
export type EntityNameOf<D> = D extends EntityDef<Record<string, TSchema>, infer N> ? N : never;

/** Field map carried by an `EntityDef`. */
export type FieldsOf<D> = D extends EntityDef<infer F, infer _N> ? F : never;

/** `as` accessor name carried by a relationship. */
export type AccessorKeyOf<R> =
  R extends RelationshipDef<infer _S, infer _T, infer A, infer _C> ? A : never;

/** Literal name of a relationship's source entity. */
export type SourceNameOf<R> =
  R extends RelationshipDef<infer S, infer _T, infer _A, infer _C> ? EntityNameOf<S> : never;

/** Literal name of a relationship's target entity. */
export type TargetNameOf<R> =
  R extends RelationshipDef<infer _S, infer T, infer _A, infer _C> ? EntityNameOf<T> : never;
