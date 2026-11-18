import {
  componentName,
  ebbComponent,
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

/** The row create every put opens with: the row's model and creation time. */
const rowCreate = (subjectId: string, model: string, hlc: string, updateId: string): Update => ({
  id: updateId,
  subject_id: subjectId,
  model,
  method: "create",
  hlc,
  data: null,
});

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
 * A `put` equivalent for `todo_1`: the row's create, then one `replace` per
 * component. `counter` offsets the HLC within `HLC_BASE` so tests can order
 * write time independently of GSN.
 */
export const buildPutAction = (counter = 0): Action => {
  const hlc = makeHlc(HLC_BASE, counter);

  return {
    id: "a_1",
    actor_id: "a_user1",
    hlc,
    gsn: 1,
    updates: [
      rowCreate("todo_1", "todo", hlc, "u_1_create"),
      ...componentUpdates(
        "todo_1",
        "todo",
        "replace",
        { title: { value: "Hello", update_id: "u_1_title", hlc } },
        "u_1",
      ),
    ],
  };
};

/** A `create`-only Action for `todo_1`: a complete row with no components. */
export const buildCreateAction = (counter = 3): Action => {
  const hlc = makeHlc(HLC_BASE, counter);

  return {
    id: "a_3",
    actor_id: "a_user1",
    hlc,
    gsn: 3,
    updates: [rowCreate("todo_1", "todo", hlc, "u_3_create")],
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

/** One atomic component Update: the whole value at one leaf. */
const systemRowUpdate = (
  kind: EbbComponentKind,
  subjectId: string,
  value: Record<string, unknown>,
  updateId: string,
  hlc: string,
): Update => ({
  id: updateId,
  subject_id: subjectId,
  component: ebbComponent(kind),
  method: "replace",
  data: { value, update_id: updateId, hlc },
});

/** One edge a link write carries: its accessor, its type label, and its target. */
export interface LinkEdgeFixture {
  /** Accessor name — the `as` of the relationship. */
  readonly as: string;
  /** Relationship type string. */
  readonly type: string;
  readonly targetId: string;
}

/** The accessor → type → target nesting that is one edge's key. */
type LinkLeaves = Record<string, Record<string, Record<string, FieldValue>>>;

/** Wrap the nesting as the `ebb/link` component's map value. */
const linkComponentValue = (leaves: LinkLeaves): FieldValue => ({
  map: Object.fromEntries(
    Object.entries(leaves).map(([as, byType]) => [
      as,
      {
        map: Object.fromEntries(
          Object.entries(byType).map(([type, byTarget]) => [type, { map: byTarget }]),
        ),
      },
    ]),
  ),
});

/**
 * Build a link write for one source row: one `ebb/link` merge carrying a
 * presence leaf per added edge and a tombstone (`value: null`) per removed one.
 * The create is optional, so a caller can write edges onto a row it already
 * holds.
 */
export const buildLinkAction = (
  args: {
    sourceId: string;
    /** The source row's committed model. */
    model: string;
    present?: readonly LinkEdgeFixture[];
    removed?: readonly LinkEdgeFixture[];
    /** Carry the row's create with the edges. */
    create?: boolean;
  },
  gsn = 1,
): Action => {
  const hlc = makeHlc(HLC_BASE, gsn);
  const updateId = `u_link_${args.sourceId}_${gsn}`;
  const leaves: LinkLeaves = {};
  const leaf = (edge: LinkEdgeFixture, value: boolean | null): void => {
    const byType = (leaves[edge.as] ??= {});
    const byTarget = (byType[edge.type] ??= {});
    byTarget[edge.targetId] = { value, update_id: updateId, hlc };
  };
  for (const edge of args.present ?? []) leaf(edge, true);
  for (const edge of args.removed ?? []) leaf(edge, null);

  return {
    id: `a_link_${args.sourceId}_${gsn}`,
    actor_id: "a_user1",
    hlc,
    gsn,
    updates: [
      ...(args.create === false
        ? []
        : [rowCreate(args.sourceId, args.model, hlc, `${updateId}_create`)]),
      {
        id: updateId,
        subject_id: args.sourceId,
        component: ebbComponent("link"),
        method: "merge",
        data: linkComponentValue(leaves),
      },
    ],
  };
};

export interface MembershipRowFixture {
  id: string;
  entityId: string;
  groupId: string;
}

/**
 * Build a create Action for one `ebb/membership` row: the row's create, then
 * one `replace` carrying the whole value, the shape the wire writes when an
 * entity joins a group.
 */
export const buildMembershipPutAction = (row: MembershipRowFixture, gsn = 1): Action => {
  const hlc = makeHlc(HLC_BASE, gsn);
  const updateId = `u_${row.id}`;

  return {
    id: `a_${row.id}_${gsn}`,
    actor_id: "a_user1",
    hlc,
    gsn,
    updates: [
      rowCreate(row.id, "ebb", hlc, `${updateId}_create`),
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

/** Build a delete Action for an `ebb/membership` row. */
export const buildMembershipDeleteAction = (args: { id: string }, gsn: number): Action => {
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
  model: "todo",
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
