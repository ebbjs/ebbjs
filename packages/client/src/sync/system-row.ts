/**
 * The read view of a platform row.
 *
 * A platform row carries its whole object in one atomic component. The public
 * read surface is the row's *value* — a group reads as `{id, name, apps}`, not
 * as `{id, group: {name, apps}}` — so the system namespaces and the built-in
 * `groups` join run over a view: the value's keys, each wrapped as a leaf so the
 * projection, field predicate, and ordering paths read them unchanged.
 *
 * The view is derived, never stored: the replica keeps the atomic row.
 */

import { systemValue, type EbbComponentKind, type Entity, type FieldValue } from "@ebbjs/core";
import type { DefaultedSchema } from "@ebbjs/schema";
import type { TArray, TOptional, TString } from "@sinclair/typebox/type";

/**
 * The field map of the `ebb/group` value. A component declares one object shape,
 * not a field map, so the client states the map the projection, predicate, and
 * ordering paths need.
 */
export type GroupFieldMap = {
  name: DefaultedSchema<TString, string>;
  apps: TOptional<TArray<TString>>;
};

/** The field map of the `ebb/grant` value. */
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
    // value, so the view carries neither.
    fields[field] = { value: entry, update_id: "", hlc: "" } as FieldValue;
  }
  return { ...row, data: { ...row.data, fields } };
};
