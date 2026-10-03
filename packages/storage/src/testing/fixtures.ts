import { makeHlc, type Action } from "@ebbjs/core";

/**
 * Reusable Action fixtures for the shared test suites. Each suite
 * builds a small set of Actions to drive the adapter under test
 * through the same shape of operations; these helpers centralize the
 * fixture data so the suites stay focused on assertions.
 */

const HLC_BASE = 1_711_036_800_000;

export const buildPutAction = (): Action => ({
  id: "a_1",
  actor_id: "a_user1",
  hlc: makeHlc(HLC_BASE),
  gsn: 1,
  updates: [
    {
      id: "u_1",
      subject_id: "todo_1",
      subject_type: "todo",
      method: "put",
      data: {
        fields: {
          title: { value: "Hello", update_id: "u_1", hlc: makeHlc(HLC_BASE) },
        },
      },
    },
  ],
});

export const buildPatchAction = (): Action => ({
  id: "a_2",
  actor_id: "a_user1",
  hlc: makeHlc(HLC_BASE, 1),
  gsn: 2,
  updates: [
    {
      id: "u_2",
      subject_id: "todo_1",
      subject_type: "todo",
      method: "patch",
      data: {
        fields: {
          title: { value: "Updated", update_id: "u_2", hlc: makeHlc(HLC_BASE, 1) },
        },
      },
    },
  ],
});

export interface RelationshipRowFixture {
  id: string;
  sourceId: string;
  targetId: string;
  /** Accessor name — the `as` of the relationship. */
  field: string;
  /** Relationship type string. */
  type: string;
  kind?: string;
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
            kind: field(row.kind ?? "link"),
          },
        },
      },
    ],
  };
};

/** Build a `patch` Action that re-points a Relationship row at a new target. */
export const buildRelationshipRetargetAction = (
  args: { id: string; targetId: string },
  gsn: number,
): Action => {
  const hlc = makeHlc(HLC_BASE, gsn);
  const updateId = `u_${args.id}_retarget`;

  return {
    id: `a_${args.id}_retarget`,
    actor_id: "a_user1",
    hlc,
    gsn,
    updates: [
      {
        id: updateId,
        subject_id: args.id,
        subject_type: "relationship",
        method: "patch",
        data: {
          fields: {
            target_id: { value: args.targetId, update_id: updateId, hlc },
          },
        },
      },
    ],
  };
};

/** Build a soft-delete Action for a Relationship row. */
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
