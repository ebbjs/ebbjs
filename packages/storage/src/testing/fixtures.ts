import {
  componentName,
  EBB_COMPONENTS,
  makeHlc,
  type Action,
  type EbbComponentKind,
  type Entity,
  type FieldValue,
  type Update,
} from "@ebbjs/core";

import type { OutboxConflict } from "../types/outbox-store";

/**
 * Reusable Action fixtures for the shared test suites. Each suite
 * builds a small set of Actions to drive the adapter under test
 * through the same shape of operations; these helpers centralize the
 * fixture data so the suites stay focused on assertions.
 */

export const HLC_BASE = 1_711_036_800_000;

/** One (`replace` or `merge`) Update per field, ids derived from `idBase`. */
const componentUpdates = (
  subjectId: string,
  model: string,
  method: "merge" | "replace",
  fields: Record<string, FieldValue>,
  idBase: string,
): Update[] =>
  Object.entries(fields).map(([field, value]) => ({
    id: `${idBase}_${field}`,
    subject_id: subjectId,
    component: componentName(model, field),
    method,
    data: value,
  }));

/**
 * A `put` equivalent for `todo_1`: one `replace` per component. `counter`
 * offsets the HLC within `HLC_BASE` so tests can order write time
 * independently of GSN.
 */
export const buildPutAction = (counter = 0): Action => {
  const hlc = makeHlc(HLC_BASE, counter);

  return {
    id: "a_1",
    actor_id: "a_user1",
    hlc,
    gsn: 1,
    updates: componentUpdates(
      "todo_1",
      "todo",
      "replace",
      { title: { value: "Hello", update_id: "u_1_title", hlc } },
      "u_1",
    ),
  };
};

/**
 * A `patch` equivalent for `todo_1` — one `merge` of its component, applied
 * after {@link buildPutAction}. See that builder for how `counter` orders the
 * HLC independently of GSN.
 */
export const buildPatchAction = (counter = 1): Action => {
  const hlc = makeHlc(HLC_BASE, counter);

  return {
    id: "a_2",
    actor_id: "a_user1",
    hlc,
    gsn: 2,
    updates: componentUpdates(
      "todo_1",
      "todo",
      "merge",
      { title: { value: "Updated", update_id: "u_2_title", hlc } },
      "u_2",
    ),
  };
};

export interface RelationshipRowFixture {
  id: string;
  sourceId: string;
  targetId: string;
  /** Accessor name — the `as` of the relationship. */
  field: string;
  /** Relationship type string. */
  type: string;
}

/**
 * One atomic component Update: the whole value at one leaf, the shape every
 * platform row write has since #805.
 */
const systemRowUpdate = (
  kind: EbbComponentKind,
  subjectId: string,
  value: Record<string, unknown>,
  updateId: string,
  hlc: string,
): Update => ({
  id: updateId,
  subject_id: subjectId,
  component: EBB_COMPONENTS[kind],
  method: "replace",
  data: { value, update_id: updateId, hlc },
});

/**
 * Build a create Action for one `ebb/link` row: one `replace` carrying the
 * whole value, the shape the wire writes when a source points at a target.
 */
export const buildRelationshipPutAction = (row: RelationshipRowFixture, gsn = 1): Action => {
  const hlc = makeHlc(HLC_BASE, gsn);
  const updateId = `u_${row.id}`;

  return {
    id: `a_${row.id}`,
    actor_id: "a_user1",
    hlc,
    gsn,
    updates: [
      systemRowUpdate(
        "link",
        row.id,
        {
          source_id: row.sourceId,
          target_id: row.targetId,
          type: row.type,
          field: row.field,
        },
        updateId,
        hlc,
      ),
    ],
  };
};

/**
 * Build an Action that rewrites an `ebb/link` row's whole value. A platform
 * component is atomic, so there is no partial write: a "patch" names the
 * complete value, exactly as the wire's `replace` does.
 */
export const buildRelationshipPatchAction = (row: RelationshipRowFixture, gsn: number): Action =>
  buildRelationshipPutAction(row, gsn);

export const buildRelationshipDeleteAction = (args: { id: string }, gsn: number): Action => {
  const hlc = makeHlc(HLC_BASE, gsn);

  return {
    id: `a_${args.id}_delete`,
    actor_id: "a_user1",
    hlc,
    gsn,
    updates: [
      {
        id: `u_${args.id}_delete`,
        subject_id: args.id,
        method: "delete",
        data: null,
      },
    ],
  };
};

export interface EntityGroupRowFixture {
  id: string;
  entityId: string;
  groupId: string;
}

/**
 * Build a create Action for one `ebb/membership` row: one `replace` carrying
 * the whole value, the shape the wire writes when an entity joins a group.
 */
export const buildEntityGroupPutAction = (row: EntityGroupRowFixture, gsn = 1): Action => {
  const hlc = makeHlc(HLC_BASE, gsn);
  const updateId = `u_${row.id}`;

  return {
    id: `a_${row.id}`,
    actor_id: "a_user1",
    hlc,
    gsn,
    updates: [
      systemRowUpdate(
        "membership",
        row.id,
        { entity_id: row.entityId, group_id: row.groupId },
        updateId,
        hlc,
      ),
    ],
  };
};

/**
 * Build an Action that rewrites an `ebb/membership` row's whole value. Like
 * {@link buildRelationshipPatchAction}, a patch is a whole-value replace.
 */
export const buildEntityGroupPatchAction = (row: EntityGroupRowFixture, gsn: number): Action =>
  buildEntityGroupPutAction(row, gsn);

/** Build a delete Action for an `ebb/membership` row. */
export const buildEntityGroupDeleteAction = (args: { id: string }, gsn: number): Action => {
  const hlc = makeHlc(HLC_BASE, gsn);

  return {
    id: `a_${args.id}_delete`,
    actor_id: "a_user1",
    hlc,
    gsn,
    updates: [
      {
        id: `u_${args.id}_delete`,
        subject_id: args.id,
        method: "delete",
        data: null,
      },
    ],
  };
};

/** A `todo_<id>` row for the before/after payload fixtures: one `title` leaf at `hlc`. */
export const buildTodoEntity = (id: string, title: string, hlc: string): Entity => ({
  id,
  type: "todo",
  data: { fields: { title: { value: title, update_id: `u_${id}`, hlc } } },
  exists: true,
  created_hlc: hlc,
  updated_hlc: hlc,
  deleted_hlc: null,
  last_gsn: 1,
});

/** The same row with `deleted_hlc` set — a tombstone. */
export const buildDeletedTodoEntity = (id: string, title: string, hlc: string): Entity => ({
  ...buildTodoEntity(id, title, hlc),
  deleted_hlc: hlc,
});

/**
 * A conflict payload for a losing write on `todo_1`: the `title` slot's
 * local / remote sides, detected at `detectedAtMs`. Callers attach it to
 * an outbox entry to exercise the durable status transition.
 */
export const buildOutboxConflict = (detectedAtMs = 1): OutboxConflict => ({
  scope: "field",
  subjects: ["todo_1"],
  remoteActions: [{ actorId: "actor_2", actionId: "a_peer", gsn: 2 }],
  subjectStates: [
    {
      subjectId: "todo_1",
      model: "todo",
      before: buildTodoEntity("todo_1", "Hello", makeHlc(HLC_BASE)),
      after: buildTodoEntity("todo_1", "Updated", makeHlc(HLC_BASE, detectedAtMs)),
    },
  ],
  holds: [{ kind: "component", subjectId: "todo_1", component: "todo/title" }],
  slots: [
    {
      subjectId: "todo_1",
      component: "todo/title",
      path: [],
      local: { value: "Hello", update_id: "u_1", hlc: makeHlc(HLC_BASE) },
      remote: { update_id: "u_2", hlc: makeHlc(HLC_BASE, detectedAtMs), value: "Updated" },
    },
  ],
  catchUpId: "cu_1",
  conflictId: `c_${detectedAtMs}`,
  detectedAtHlc: makeHlc(HLC_BASE, detectedAtMs),
});
