import { makeHlc, type Action } from "@ebbjs/core";

/**
 * Reusable Action fixtures for the shared test suites. Each suite
 * builds a small set of Actions to drive the adapter under test
 * through the same shape of operations; these helpers centralize the
 * fixture data so the suites stay focused on assertions.
 */

const HLC_BASE = 1_711_036_800_000;

/**
 * A `put` for `todo_1`. `counter` offsets the HLC within `HLC_BASE` so
 * tests can order write time independently of GSN.
 */
export const buildPutAction = (counter = 0): Action => {
  const hlc = makeHlc(HLC_BASE, counter);

  return {
    id: "a_1",
    actor_id: "a_user1",
    hlc,
    gsn: 1,
    updates: [
      {
        id: "u_1",
        subject_id: "todo_1",
        subject_type: "todo",
        method: "put",
        data: {
          fields: {
            title: { value: "Hello", update_id: "u_1", hlc },
          },
        },
      },
    ],
  };
};

/**
 * A `patch` for `todo_1`, applied after {@link buildPutAction}. See that
 * builder for how `counter` orders the HLC independently of GSN.
 */
export const buildPatchAction = (counter = 1): Action => {
  const hlc = makeHlc(HLC_BASE, counter);

  return {
    id: "a_2",
    actor_id: "a_user1",
    hlc,
    gsn: 2,
    updates: [
      {
        id: "u_2",
        subject_id: "todo_1",
        subject_type: "todo",
        method: "patch",
        data: {
          fields: {
            title: { value: "Updated", update_id: "u_2", hlc },
          },
        },
      },
    ],
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
 * Build a `put` Action for one Relationship row, the shape the wire
 * writes when a source points at a target.
 */
export const buildRelationshipPutAction = (row: RelationshipRowFixture, gsn = 1): Action => {
  const hlc = makeHlc(HLC_BASE, gsn);
  const updateId = `u_${row.id}`;
  const field = (value: string) => ({ value, update_id: updateId, hlc });

  return {
    id: `a_${row.id}`,
    actor_id: "a_user1",
    hlc,
    gsn,
    updates: [
      {
        id: updateId,
        subject_id: row.id,
        subject_type: "relationship",
        method: "put",
        data: {
          fields: {
            source_id: field(row.sourceId),
            target_id: field(row.targetId),
            type: field(row.type),
            field: field(row.field),
          },
        },
      },
    ],
  };
};

export interface RelationshipPatchFixture {
  id: string;
  sourceId?: string;
  targetId?: string;
  /** Accessor name — the `as` of the relationship. */
  field?: string;
  /** Relationship type string. */
  type?: string;
}

/**
 * Build a `patch` Action that changes one or more natural-key fields
 * of a Relationship row.
 */
export const buildRelationshipPatchAction = (
  patch: RelationshipPatchFixture,
  gsn: number,
): Action => {
  const hlc = makeHlc(HLC_BASE, gsn);
  const updateId = `u_${patch.id}_patch`;
  const field = (value: string) => ({ value, update_id: updateId, hlc });
  const fields: Record<string, { value: string; update_id: string; hlc: string }> = {};
  if (patch.sourceId !== undefined) fields.source_id = field(patch.sourceId);
  if (patch.targetId !== undefined) fields.target_id = field(patch.targetId);
  if (patch.type !== undefined) fields.type = field(patch.type);
  if (patch.field !== undefined) fields.field = field(patch.field);

  return {
    id: `a_${patch.id}_patch`,
    actor_id: "a_user1",
    hlc,
    gsn,
    updates: [
      {
        id: updateId,
        subject_id: patch.id,
        subject_type: "relationship",
        method: "patch",
        data: { fields },
      },
    ],
  };
};

/** Build a `patch` Action that re-points a Relationship row at a new target. */
export const buildRelationshipRetargetAction = (
  args: { id: string; targetId: string },
  gsn: number,
): Action => buildRelationshipPatchAction({ id: args.id, targetId: args.targetId }, gsn);

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
        subject_type: "relationship",
        method: "delete",
        data: null,
      },
    ],
  };
};
