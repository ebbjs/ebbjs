/**
 * The wire builders for the platform's four rows.
 *
 * Each row is one atomic component, so every builder here emits exactly **one**
 * Update carrying the whole value: there is no per-field Update to tear. The
 * component names come from `@ebbjs/core`; this module is the only place that
 * knows how a platform value is wrapped into a `FieldValue`.
 */

import {
  ebbComponent,
  generateId,
  type EbbComponentKind,
  type FieldValue,
  type Update,
} from "@ebbjs/core";

/** The ids one platform-row Update consumes. */
export interface SystemRowIds {
  updateId(): string;
  /**
   * The leaf's clock. Omitted only by a caller that has none; a leaf without one
   * merges as the oldest write.
   */
  hlc?(): string;
}

/** A fresh Update id and the caller's current clock. */
export const systemRowIds = (hlc: () => string): SystemRowIds => ({
  updateId: () => generateId("u"),
  hlc,
});

export const fixedRowIds = (updateId: string, hlc?: string): SystemRowIds => {
  const ids: SystemRowIds = { updateId: () => updateId };
  if (hlc === undefined) return ids;
  return { updateId: () => updateId, hlc: () => hlc };
};

/** One atomic component Update. `kind` is the value's shape, not its id. */
export const systemRowUpdate = (
  kind: EbbComponentKind,
  subjectId: string,
  value: Readonly<Record<string, unknown>>,
  ids: SystemRowIds,
): Update => {
  const updateId = ids.updateId();
  const hlc = ids.hlc?.();
  return {
    id: updateId,
    subject_id: subjectId,
    component: ebbComponent(kind),
    method: "replace",
    data: (hlc === undefined
      ? { value, update_id: updateId }
      : { value, update_id: updateId, hlc }) as FieldValue,
  };
};

/** A row `delete`: it names no component, so the server resolves the kind. */
export const systemRowDelete = (
  subjectId: string,
  ids: { updateId(): string; hlc?(): string },
): Update => ({
  id: ids.updateId(),
  subject_id: subjectId,
  method: "delete",
  data: null,
});

/** `ebb/group`. Omitting `apps` is unscoped (every app), which is not `[]`. */
export const groupRowUpdate = (
  args: { groupId: string; name: string; apps?: readonly string[] },
  ids: SystemRowIds,
): Update =>
  systemRowUpdate(
    "group",
    args.groupId,
    args.apps === undefined ? { name: args.name } : { name: args.name, apps: [...args.apps] },
    ids,
  );

export const grantRowUpdate = (
  args: {
    grantId: string;
    actorId: string;
    groupId: string;
    permissions: readonly string[];
  },
  ids: SystemRowIds,
): Update =>
  systemRowUpdate(
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
 * create and the row id is derived from it (`entityGroupId`), so a re-share is
 * idempotent.
 */
export const membershipRowUpdate = (
  args: { membershipId: string; entityId: string; groupId: string },
  ids: SystemRowIds,
): Update =>
  systemRowUpdate(
    "membership",
    args.membershipId,
    { entity_id: args.entityId, group_id: args.groupId },
    ids,
  );

/** `ebb/link`: one edge from its source. Moving an edge is a delete plus a create. */
export const linkRowUpdate = (
  args: {
    linkId: string;
    sourceId: string;
    targetId: string;
    field: string;
    type: string;
  },
  ids: SystemRowIds,
): Update =>
  systemRowUpdate(
    "link",
    args.linkId,
    {
      source_id: args.sourceId,
      target_id: args.targetId,
      type: args.type,
      field: args.field,
    },
    ids,
  );
