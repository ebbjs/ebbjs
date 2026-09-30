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
