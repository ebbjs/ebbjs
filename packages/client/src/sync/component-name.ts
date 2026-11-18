/**
 * The component a row field is named under.
 *
 * `ebb/` is the platform's namespace rather than the row's: an `ebb/*`
 * component may sit on a row of any model and never takes that row's model as
 * its namespace (#820). The one such component a row carries alongside its own
 * fields is `ebb/link`, whose value lives at the `link` field; every other
 * field is a component of the row's own model.
 */

import {
  componentName,
  EBB_COMPONENT_KINDS,
  EBB_MODEL_NAME,
  ebbComponent,
  ebbComponentField,
  type ComponentName,
  type EbbComponentKind,
} from "@ebbjs/core";

/** The platform kind whose value lives at each platform field name. */
const PLATFORM_FIELD_KINDS: ReadonlyMap<string, EbbComponentKind> = new Map(
  EBB_COMPONENT_KINDS.map((kind) => [ebbComponentField(kind), kind]),
);

export const fieldComponent = (model: string, field: string): ComponentName => {
  const kind = model === EBB_MODEL_NAME ? undefined : PLATFORM_FIELD_KINDS.get(field);
  return kind === undefined ? componentName(model, field) : ebbComponent(kind);
};
