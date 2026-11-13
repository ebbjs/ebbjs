/**
 * The read view of a platform row.
 *
 * A platform row is an `ebb` row carrying one atomic component
 * (`ebb/group`, `ebb/grant`, `ebb/membership`, `ebb/link`) whose value is the
 * whole object. The public read surface, though, is the row's *value* — a
 * group row reads as `{id, name, apps}`, not as `{id, group: {name, apps}}`.
 * So the group / membership namespaces and the built-in `groups` join run over
 * a view: the component's value keys, each wrapped as a leaf so the ordinary
 * projection, field predicate, and ordering paths read them unchanged.
 *
 * The view is derived, never stored: the replica keeps the atomic row.
 */

import { systemValue, type EbbComponentKind, type Entity, type FieldValue } from "@ebbjs/core";
import type { DefaultedSchema } from "@ebbjs/schema";
import type { TArray, TOptional, TString } from "@sinclair/typebox/type";

/**
 * The field map of the `ebb/group` value. A component declares one object
 * shape, not a field map, so the client states the map the projection,
 * predicate, and ordering paths need and pins it against the schema's own
 * value type: `GroupFields` is `Static` of exactly these properties.
 */
export type GroupFieldMap = {
  name: DefaultedSchema<TString, string>;
  apps: TOptional<TArray<TString>>;
};

/**
 * The field map of the `ebb/grant` value (today's `groupMember`), pinned to
 * `GroupMemberFields` the same way.
 */
export type GrantFieldMap = {
  actor_id: DefaultedSchema<TString, string>;
  group_id: DefaultedSchema<TString, string>;
  permissions: DefaultedSchema<TArray<TString>, string[]>;
};

/** The view of one platform row's value, or `null` when it carries no such kind. */
export const componentRowView = (row: Entity, kind: EbbComponentKind): Entity | null => {
  const value = systemValue(row, kind);
  if (value === null) return null;
  const fields: Record<string, FieldValue> = {};
  for (const [field, entry] of Object.entries(value)) {
    // The envelope stamps belong to the atomic component, not to a projected
    // value, so the view carries neither: nothing reads them from a view row.
    fields[field] = { value: entry, update_id: "", hlc: "" } as FieldValue;
  }
  return { ...row, data: { ...row.data, fields } };
};
