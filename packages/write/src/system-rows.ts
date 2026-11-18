/**
 * The platform **row** emitters: `ebb/group`, `ebb/grant`, and
 * `ebb/membership` Updates.
 *
 * Each of the three is one atomic component on a row of its own, so a builder
 * here emits the row's create followed by exactly **one** Update carrying the
 * whole value: there is no per-field Update to tear. `ebb/link` is not a row
 * kind — it is a keyed component of its source — and its Updates are built in
 * `relationship.ts`. The component names come from `@ebbjs/core`; this module
 * is the only place that knows how an atomic platform value is wrapped into a
 * `FieldValue`.
 */

import {
  ebbComponent,
  EBB_MODEL_NAME,
  generateId,
  type EbbComponentKind,
  type FieldValue,
  type Update,
} from "@ebbjs/core";

import { rowCreate } from "./row-create";

/** The ids one row's Updates consume: a fresh Update id each, and the row's clock. */
export interface SystemRowIds {
  updateId(): string;
  /** The row's clock: its creation time and the stamp of its component value. */
  hlc(): string;
}

/** A fresh Update id and the caller's current clock. */
export const systemRowIds = (hlc: () => string): SystemRowIds => ({
  updateId: () => generateId("u"),
  hlc,
});

/** The row's create. A platform row is committed under the platform model. */
export const systemRowCreate = (subjectId: string, ids: SystemRowIds): Update =>
  rowCreate(subjectId, EBB_MODEL_NAME, ids);

/** One atomic component Update. `kind` is the value's shape, not its id. */
export const systemRowUpdate = (
  kind: EbbComponentKind,
  subjectId: string,
  value: Readonly<Record<string, unknown>>,
  ids: SystemRowIds,
): Update => {
  const updateId = ids.updateId();
  return {
    id: updateId,
    subject_id: subjectId,
    component: ebbComponent(kind),
    method: "replace",
    data: { value, update_id: updateId, hlc: ids.hlc() } as FieldValue,
  };
};

/** A row `delete`: it names no component, so the server resolves the kind. */
export const systemRowDelete = (subjectId: string, ids: { updateId(): string }): Update => ({
  id: ids.updateId(),
  subject_id: subjectId,
  method: "delete",
  data: null,
});

/** A platform row: its create, then its one atomic component. */
const platformRowUpdates = (
  kind: EbbComponentKind,
  subjectId: string,
  value: Readonly<Record<string, unknown>>,
  ids: SystemRowIds,
): Update[] => [systemRowCreate(subjectId, ids), systemRowUpdate(kind, subjectId, value, ids)];

/** `ebb/group`. Omitting `apps` is unscoped (every app), which is not `[]`. */
export const groupRowUpdates = (
  args: { groupId: string; name: string; apps?: readonly string[] },
  ids: SystemRowIds,
): Update[] =>
  platformRowUpdates(
    "group",
    args.groupId,
    args.apps === undefined ? { name: args.name } : { name: args.name, apps: [...args.apps] },
    ids,
  );

export const grantRowUpdates = (
  args: {
    grantId: string;
    actorId: string;
    groupId: string;
    permissions: readonly string[];
  },
  ids: SystemRowIds,
): Update[] =>
  platformRowUpdates(
    "grant",
    args.grantId,
    {
      actor_id: args.actorId,
      group_id: args.groupId,
      permissions: [...args.permissions],
    },
    ids,
  );

/**
 * `ebb/membership`: one entity filed in one group. The pair is immutable after
 * create and the row id is derived from it (`membershipRowId`), so a re-share is
 * idempotent.
 */
export const membershipRowUpdates = (
  args: { membershipId: string; entityId: string; groupId: string },
  ids: SystemRowIds,
): Update[] =>
  platformRowUpdates(
    "membership",
    args.membershipId,
    { entity_id: args.entityId, group_id: args.groupId },
    ids,
  );
