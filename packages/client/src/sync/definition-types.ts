/**
 * Type-level views of `defineModel` / `defineRelationship` outputs.
 *
 * The schema keeps entity names and field maps as literals so the
 * namespace and the query builder can derive their typed surfaces from
 * one relationship map. These helpers are the shared walkers for both;
 * they hold no runtime code.
 */

import type { TSchema } from "@sinclair/typebox/type";

import type { ModelDef } from "@ebbjs/schema";
import type { RelationshipDef } from "@ebbjs/schema";

/** An entity definition with its field map erased. */
export type AnyModelDef = ModelDef<Record<string, TSchema>>;

/** A relationship definition with both endpoints' field maps erased. */
export type AnyRelationshipDef = RelationshipDef<AnyModelDef, AnyModelDef>;

/** Literal entity name carried by an `ModelDef`. */
export type EntityNameOf<D> = D extends ModelDef<Record<string, TSchema>, infer N> ? N : never;

/** Field map carried by an `ModelDef`. */
export type FieldsOf<D> = D extends ModelDef<infer F, infer _N> ? F : never;

/** `as` accessor name carried by a relationship. */
export type AccessorKeyOf<R> =
  R extends RelationshipDef<infer _S, infer _T, infer A, infer _C> ? A : never;

/** Literal name of a relationship's source entity. */
export type SourceNameOf<R> =
  R extends RelationshipDef<infer S, infer _T, infer _A, infer _C> ? EntityNameOf<S> : never;

/** Literal name of a relationship's target entity. */
export type TargetNameOf<R> =
  R extends RelationshipDef<infer _S, infer T, infer _A, infer _C> ? EntityNameOf<T> : never;
