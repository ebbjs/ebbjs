import { Type } from "@sinclair/typebox";
import { Static } from "@sinclair/typebox";
import { NanoIdSchema } from "./nanoid";
import { HLCTimestampSchema, type HLCTimestamp } from "./hlc";
import { compare } from "../hlc";

/**
 * The `<model>/<field>` name of one component: the segment before the first
 * `/` is the model the entity is committed under, the segment after it is the
 * row field the component's value lives at.
 */
export const ComponentNameSchema = Type.String({ pattern: "^[^/]+/[^/]+$" });
export type ComponentName = `${string}/${string}`;

export const UpdateMethodSchema = Type.Union([
  Type.Literal("merge"),
  Type.Literal("replace"),
  Type.Literal("drop"),
  Type.Literal("delete"),
]);
export type UpdateMethod = Static<typeof UpdateMethodSchema>;

/** The model segment of a `<model>/<field>` component name. */
export const componentModel = (component: string): string =>
  component.slice(0, component.indexOf("/"));

/** The field segment of a `<model>/<field>` component name. */
export const componentField = (component: string): string =>
  component.slice(component.indexOf("/") + 1);

/** The component a model's field is declared under. */
export const componentName = (model: string, field: string): ComponentName => `${model}/${field}`;

// A field value is either a leaf carrying a scalar/opaque `value` merged
// by last-writer-wins, or a `map` of nested field values merged key by
// key. The `map` key is the discriminant, so a map is self-describing on
// the wire and the server needs no schema to merge it.
export const FieldValueSchema = Type.Recursive((Self) =>
  Type.Union([
    Type.Object({
      value: Type.Unknown(),
      update_id: NanoIdSchema,
      hlc: Type.Optional(HLCTimestampSchema),
    }),
    // The leaf members are declared optional-never on the map branch so
    // reading `value` / `update_id` / `hlc` on the union stays total: the
    // map branch contributes `undefined`, matching what it holds at
    // runtime. They are never emitted on a map.
    Type.Object({
      map: Type.Record(Type.String(), Self),
      value: Type.Optional(Type.Never()),
      update_id: Type.Optional(Type.Never()),
      hlc: Type.Optional(Type.Never()),
    }),
  ]),
);
export type FieldValue = Static<typeof FieldValueSchema>;

/** A leaf field value: the object carrying `value`. */
export interface FieldLeaf {
  readonly value: unknown;
  readonly update_id: string;
  readonly hlc?: HLCTimestamp;
}

/** A map field value: nested field values merged key by key. */
export interface FieldMap {
  readonly map: Record<string, FieldValue>;
}

/** Narrow a field value to its map variant. */
export const isFieldMap = (field: FieldValue): field is FieldMap => "map" in field;

/** Narrow a field value to its leaf variant. */
export const isFieldLeaf = (field: FieldValue): field is FieldLeaf => !isFieldMap(field);

/**
 * Merge an incoming field value over an existing one, recursively, under
 * the wire's only merge rule. This is the protocol's definition of the
 * rule; the server and every client materializer mirror it so concurrent
 * writes converge identically everywhere.
 *
 * - leaf over leaf: higher HLC wins; equal HLC breaks toward the
 *   lexicographically greater `update_id`.
 * - map over map: the key sets are unioned and each key merges by the
 *   same rule, so a write to one key leaves its siblings untouched.
 * - a mismatched kind (a leaf replacing a map or vice versa) replaces
 *   the whole value; a field's kind is fixed by its schema, so this
 *   only happens for a schema violation and the patch is the newer
 *   intent.
 *
 * A leaf `value: null` is a tombstone: it participates in the merge like
 * any other leaf so a late write can still beat it, and the projection
 * is what hides a tombstoned map key.
 *
 * The merge copies the map only when a key actually changes. When the
 * incoming value loses (or contributes nothing), the existing value is
 * returned by reference, so a caller comparing identity can tell that
 * nothing observable changed without re-scanning the map. A winning key
 * still reuses every untouched sibling by reference.
 */
export const mergeFieldValue = (
  existing: FieldValue | undefined,
  incoming: FieldValue,
): FieldValue => {
  if (existing === undefined) return incoming;
  if (!isFieldMap(existing) || !isFieldMap(incoming)) {
    if (isFieldMap(existing) || isFieldMap(incoming)) return incoming;
    const hlcCmp = compare(existing.hlc ?? "", incoming.hlc ?? "");
    if (hlcCmp < 0) return incoming;
    if (hlcCmp > 0) return existing;
    return incoming.update_id >= existing.update_id ? incoming : existing;
  }

  let merged: Record<string, FieldValue> | undefined;
  for (const [key, value] of Object.entries(incoming.map)) {
    const previous = merged === undefined ? existing.map[key] : merged[key];
    const next = mergeFieldValue(previous, value);
    if (next !== previous) {
      if (merged === undefined) merged = { ...existing.map };
      merged[key] = next;
    }
  }
  return merged === undefined ? existing : { map: merged };
};

export const UpdateInputSchema = Type.Union([
  Type.Object(
    {
      id: Type.Optional(NanoIdSchema),
      subject_id: NanoIdSchema,
      component: ComponentNameSchema,
      method: Type.Union([Type.Literal("merge"), Type.Literal("replace")]),
      data: FieldValueSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: Type.Optional(NanoIdSchema),
      subject_id: NanoIdSchema,
      component: ComponentNameSchema,
      method: Type.Literal("drop"),
      data: Type.Null(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: Type.Optional(NanoIdSchema),
      subject_id: NanoIdSchema,
      method: Type.Literal("delete"),
      data: Type.Null(),
    },
    { additionalProperties: false },
  ),
]);

export const UpdateSchema = Type.Union([
  Type.Object(
    {
      id: NanoIdSchema,
      subject_id: NanoIdSchema,
      component: ComponentNameSchema,
      method: Type.Union([Type.Literal("merge"), Type.Literal("replace")]),
      data: FieldValueSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: NanoIdSchema,
      subject_id: NanoIdSchema,
      component: ComponentNameSchema,
      method: Type.Literal("drop"),
      data: Type.Null(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: NanoIdSchema,
      subject_id: NanoIdSchema,
      method: Type.Literal("delete"),
      data: Type.Null(),
    },
    { additionalProperties: false },
  ),
]);

/**
 * One write to one `(entity, component)`. `data` is the component's value,
 * never a row's field record; `delete` names the row and no component.
 */
export type Update =
  | {
      id: string;
      subject_id: string;
      component: ComponentName;
      method: "merge" | "replace";
      data: FieldValue;
    }
  | { id: string; subject_id: string; component: ComponentName; method: "drop"; data: null }
  | { id: string; subject_id: string; method: "delete"; data: null };

/** The component value an Update carries; `undefined` for `drop` and `delete`. */
export const updateComponentValue = (update: Update): FieldValue | undefined =>
  update.method === "merge" || update.method === "replace" ? update.data : undefined;

/** {@link Update} before its id is stamped. */
export type UpdateInput =
  | {
      id?: string;
      subject_id: string;
      component: ComponentName;
      method: "merge" | "replace";
      data: FieldValue;
    }
  | { id?: string; subject_id: string; component: ComponentName; method: "drop"; data: null }
  | { id?: string; subject_id: string; method: "delete"; data: null };

export const ActionSchema = Type.Object({
  id: NanoIdSchema,
  actor_id: NanoIdSchema,
  hlc: HLCTimestampSchema,
  gsn: Type.Number({ minimum: 0 }),
  updates: Type.Array(UpdateSchema),
});

/** One actor's batch of Updates, the unit the server commits and fans out. */
export interface Action {
  id: string;
  actor_id: string;
  hlc: HLCTimestamp;
  gsn: number;
  updates: Update[];
}
