/**
 * `defineAction` — pure declaration of a cross-entity Action.
 *
 * The builder is a factory returning a frozen `ActionDef`: the entity
 * types to create (`writes`, referenced as `EntityDef` values, not
 * instances) plus one `RelationshipDef` per edge the Action may wire.
 * `values` carries the create input per entity name. A declared
 * relationship whose source value omits its `as` key is auto-wired to
 * the target created in the same Action; an explicit `as` value (an
 * existing target id) links to a pre-existing entity instead.
 *
 * Calling `defineAction` allocates nothing and performs no I/O. Entity
 * ids are minted when `client.atomic(actionDef)` lowers the
 * declaration, which runs the same resolver as the callback form (see
 * `../sync/atomic`). The declaration is safe to build at module load
 * and share across clients.
 *
 * `defineAction` copies the containers it owns — the `writes` tuple, the
 * `values` map, each per-entity value record, and array-valued pointer
 * entries — and freezes them. It never freezes or mutates the caller's
 * objects. Copying is one level deep: nested objects inside a field
 * value stay by reference.
 */

import type { Static, TSchema } from "@sinclair/typebox/type";

import type { EntityDef } from "./entity";
import type { RelationshipDef } from "./relationship";

type AnyEntityDef = EntityDef<Record<string, TSchema>>;
type AnyRelationshipDef = RelationshipDef<AnyEntityDef, AnyEntityDef>;

/**
 * One entry in `writes`: an entity type to create, or a relationship the
 * Action may wire. `EntityDef` and `RelationshipDef` are discriminated
 * structurally — `EntityDef` carries `name` / `shape`, `RelationshipDef`
 * does not.
 */
export type ActionWrite = AnyEntityDef | AnyRelationshipDef;

/** Entity name carried by an entity write; `never` for a relationship write. */
type EntityNameOf<W> = W extends { readonly name: infer N extends string; readonly shape: unknown }
  ? N
  : never;

/** Entity field values carried by an entity write. */
type FieldsOf<W> = W extends { readonly shape: infer Sh extends TSchema } ? Static<Sh> : never;

/**
 * `as` keys contributed by relationship writes whose source is `Name`.
 * These are the pointer inputs `values` may set explicitly; when
 * omitted, the declaration auto-wires the co-created target.
 */
type RelationshipKeysFor<Writes extends readonly ActionWrite[], Name extends string> = {
  [W in Writes[number] as W extends {
    readonly source: { readonly name: infer SourceName extends string };
    readonly as: infer As extends string;
  }
    ? SourceName extends Name
      ? As
      : never
    : never]: never;
};

/**
 * Explicit relationship pointer: an existing target id, or a list of
 * ids for a many-cardinality edge. A declared relationship omitted from
 * `values` is auto-wired to the target created in the same Action.
 */
export type ActionPointer = string | readonly string[];

/**
 * Create input per entity name, inferred from the entity writes in
 * `writes`. Entity fields flow from the `EntityDef` shapes. A
 * relationship's `as` key is typed from the `RelationshipDef` in
 * `writes` and is optional: omit it to auto-wire the co-created target,
 * or set it to link a pre-existing entity.
 */
export type ActionValues<Writes extends readonly ActionWrite[]> = {
  [W in Writes[number] as EntityNameOf<W>]: Omit<
    FieldsOf<W>,
    keyof RelationshipKeysFor<Writes, EntityNameOf<W>>
  > &
    Partial<Record<keyof RelationshipKeysFor<Writes, EntityNameOf<W>>, ActionPointer>>;
};

/**
 * Materialized handles returned by `client.atomic(actionDef)`: the
 * projected entity fields with the eagerly-allocated id, keyed by
 * entity name.
 */
export type ActionHandles<Writes extends readonly ActionWrite[]> = {
  [W in Writes[number] as EntityNameOf<W>]: FieldsOf<W> & {
    readonly id: string;
  } & Record<string, unknown>;
};

/**
 * A frozen, side-effect-free Action declaration. `Writes` is the
 * literal `writes` tuple, so entity names and field values flow into
 * `ActionValues` / `ActionHandles`.
 */
export interface ActionDef<Writes extends readonly ActionWrite[] = readonly ActionWrite[]> {
  readonly writes: Writes;
  readonly values: ActionValues<Writes>;
}

/** Input accepted by {@link defineAction}. */
export interface DefineActionInput<Writes extends readonly ActionWrite[]> {
  readonly writes: Writes;
  readonly values: ActionValues<Writes>;
}

/** Copy a field value one level deep and freeze the copy when it is an array. */
const freezeFieldValue = (value: unknown): unknown =>
  Array.isArray(value) ? Object.freeze([...value]) : value;

/**
 * Copy the value containers `defineAction` owns and freeze them. One
 * level of container / array copying only: per-entity field records and
 * array-valued pointer entries are copied and frozen, while nested
 * objects inside a field value stay by reference and stay mutable.
 */
const freezeValues = (values: Record<string, unknown>): Record<string, unknown> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(values).map(([name, fields]) => [
        name,
        Object.freeze(
          Object.fromEntries(
            Object.entries(fields as Record<string, unknown>).map(([key, value]) => [
              key,
              freezeFieldValue(value),
            ]),
          ),
        ),
      ]),
    ),
  );

/**
 * Declare an Action by the entity types it writes and the values to
 * create. Frozen; no ids are allocated and no writes are staged until
 * the definition is handed to `client.atomic`.
 *
 * Each `RelationshipDef` in `writes` types its source's pointer input.
 * Omit that input to auto-wire the target created in the same Action;
 * set it to an existing id to link a pre-existing entity. `client.atomic`
 * creates auto-wired targets before their sources (independent entities
 * keep `writes` order) and resolves to the created handles keyed by
 * entity name. Because that order is dependency order rather than
 * `writes` order, the emitted update ordering can differ from an
 * equivalent callback even though the canonical Action content matches.
 */
export function defineAction<const Writes extends readonly ActionWrite[]>(
  input: DefineActionInput<Writes>,
): ActionDef<Writes> {
  const def: ActionDef<Writes> = {
    writes: Object.freeze([...input.writes]) as unknown as Writes,
    values: freezeValues(input.values as Record<string, unknown>) as ActionValues<Writes>,
  };
  return Object.freeze(def);
}
