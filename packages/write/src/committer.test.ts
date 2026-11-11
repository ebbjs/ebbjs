/**
 * Unit tests for the committer — the one place a batch of operations
 * becomes a single Action.
 *
 * Operations are pure, so these tests supply a `CommitCapability` double: a
 * registry, an id/clock mint, and a submit hook that records every batch.
 * What an operation puts in its Updates is the operations' own business;
 * these pin only what the committer decides: one Action per batch, the sorted
 * union of the batch's group sets, nothing submitted for an empty batch, and a
 * server rejection returned to the caller rather than thrown.
 */

import type { Update } from "@ebbjs/core";
import { ModelRegistry, defineModel, e } from "@ebbjs/schema";
import { describe, expect, it } from "vitest";

import { commit, type CommitCapability } from "./committer";
import { type OperationCall, call, changeGroups, dropEntity } from "./operations";

const mkRegistry = (): ModelRegistry => {
  const registry = new ModelRegistry();
  registry.register(defineModel("todo", { title: e.string() }));
  return registry;
};

/** A capability whose submit hook records every batch it is handed. */
const mkCap = (
  response: { rejected: readonly { id: string; reason: string }[] } = { rejected: [] },
): { cap: CommitCapability; submitted: (readonly Update[])[] } => {
  const submitted: (readonly Update[])[] = [];
  let updateSeq = 0;
  return {
    cap: {
      registry: mkRegistry(),
      submitRelationshipUpdates: async (updates) => {
        submitted.push(updates);
        return response;
      },
      freshHlc: () => "hlc_1",
      generateUpdateId: () => `u_${++updateSeq}`,
      actorId: "actor_1",
    },
    submitted,
  };
};

const dropTodos: OperationCall[] = [
  call(dropEntity, { entity: "todo", id: "todo_1", fields: ["title"], groups: ["g_2", "g_1"] }),
  call(dropEntity, { entity: "todo", id: "todo_2", fields: ["title"], groups: ["g_1"] }),
];

describe("commit", () => {
  it("submits every operation's Updates as one Action, in call order", async () => {
    const { cap, submitted } = mkCap();

    await commit(dropTodos, cap);

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.map((update) => update.subject_id)).toEqual(["todo_1", "todo_2"]);
  });

  it("reports the batch's group set as one sorted, de-duplicated union", async () => {
    const { cap } = mkCap();

    const result = await commit(dropTodos, cap);

    expect(result.groups).toEqual(["g_1", "g_2"]);
  });

  it("submits nothing when the batch produces no Updates", async () => {
    const { cap, submitted } = mkCap();

    const result = await commit([call(changeGroups, { entity: "todo", entityId: "todo_1" })], cap);

    expect(submitted).toHaveLength(0);
    expect(result).toEqual({ response: { rejected: [] }, groups: [] });
  });

  it("returns the server's rejection instead of throwing it", async () => {
    const rejected = [{ id: "u_1", reason: "stale_gsn" }];
    const { cap } = mkCap({ rejected });

    const result = await commit(dropTodos, cap);

    expect(result.response.rejected).toEqual(rejected);
  });
});
