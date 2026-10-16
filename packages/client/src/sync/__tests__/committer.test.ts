/**
 * Unit tests for the committer — the one place a batch of operations
 * becomes a single Action.
 *
 * Operations are pure, so these tests supply a `CommitCapability`
 * double: a registry, an id/clock mint, and a submit hook that records
 * every batch. Coherence is the committer's job, so a mismatch must be
 * refused before the submit hook is ever called.
 */

import { describe, expect, it } from "vitest";
import type { Update } from "@ebbjs/core";

import { defineEntity, e } from "../../schema/entity";
import { EntityRegistry } from "../../schema/entity-registry";
import { defineRelationship } from "../../schema/relationship";
import { AtomicActionError, call, createEntity, writeRelationship } from "../operations";
import { commit, type CommitCapability } from "../committer";

const todo = defineEntity("todo", { title: e.string() });
const list = defineEntity("list", { name: e.string() });

const mkRegistry = (): EntityRegistry => {
  const registry = new EntityRegistry();
  registry.register(todo);
  registry.register(list);
  registry.registerRelationship(defineRelationship({ source: todo, target: list, as: "list" }));
  return registry;
};

const mkCap = (): { cap: CommitCapability; submitted: Update[][] } => {
  const submitted: Update[][] = [];
  let updateSeq = 0;
  return {
    cap: {
      registry: mkRegistry(),
      submitRelationshipUpdates: async (updates) => {
        submitted.push([...updates]);
        return { rejected: [] };
      },
      freshHlc: () => "hlc_1",
      generateUpdateId: () => `u_${++updateSeq}`,
      actorId: "actor_1",
    },
    submitted,
  };
};

/** Run `fn`, returning the thrown value (commit rejects rather than throws). */
const capture = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
};

describe("commit — content coherence", () => {
  it("refuses content ops with different group sets, naming each subject and both sets", async () => {
    const { cap, submitted } = mkCap();

    const error = (await capture(() =>
      commit(
        [
          call(createEntity, {
            entity: "todo",
            id: "todo_1",
            fields: { title: "a" },
            groups: ["g_1"],
          }),
          call(createEntity, {
            entity: "todo",
            id: "todo_2",
            fields: { title: "b" },
            groups: ["g_2"],
          }),
        ],
        cap,
      ),
    )) as AtomicActionError;

    expect(error).toBeInstanceOf(AtomicActionError);
    expect(
      error.rejections.map((r) => ({ id: r.id, subjectType: r.subjectType, reason: r.reason })),
    ).toEqual([
      { id: "todo_1", subjectType: "todo", reason: "group_mismatch" },
      { id: "todo_2", subjectType: "todo", reason: "group_mismatch" },
    ]);
    for (const rejection of error.rejections) {
      expect(rejection.details).toContain("g_1");
      expect(rejection.details).toContain("g_2");
    }
    expect(submitted).toHaveLength(0);
  });

  it("submits one Action when the content ops share a group set", async () => {
    const { cap, submitted } = mkCap();

    const result = await commit(
      [
        call(createEntity, {
          entity: "todo",
          id: "todo_1",
          fields: { title: "a" },
          groups: ["g_1"],
        }),
        call(createEntity, {
          entity: "todo",
          id: "todo_2",
          fields: { title: "b" },
          groups: ["g_1"],
        }),
      ],
      cap,
    );

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toHaveLength(4);
    expect(result.groups).toEqual(["g_1"]);
    expect(result.response.rejected).toEqual([]);
  });

  it("refuses a relationship-only batch whose ops span groups", async () => {
    const { cap, submitted } = mkCap();

    const error = (await capture(() =>
      commit(
        [
          call(writeRelationship, {
            entity: "todo",
            sourceId: "todo_1",
            as: "list",
            pointer: { targetId: "list_1" },
            groups: ["g_1"],
          }),
          call(writeRelationship, {
            entity: "todo",
            sourceId: "todo_2",
            as: "list",
            pointer: { targetId: "list_2" },
            groups: ["g_2"],
          }),
        ],
        cap,
      ),
    )) as AtomicActionError;

    expect(error).toBeInstanceOf(AtomicActionError);
    expect(error.rejections.map((r) => r.reason)).toEqual(["group_mismatch", "group_mismatch"]);
    expect(submitted).toHaveLength(0);
  });

  it("computes the group set of a relationship-only batch rather than treating it as vacuous", async () => {
    const { cap, submitted } = mkCap();

    const result = await commit(
      [
        call(writeRelationship, {
          entity: "todo",
          sourceId: "todo_1",
          as: "list",
          pointer: { targetId: "list_1" },
          groups: ["g_2", "g_1"],
        }),
        call(writeRelationship, {
          entity: "todo",
          sourceId: "todo_2",
          as: "list",
          pointer: { targetId: "list_2" },
          groups: ["g_1", "g_2"],
        }),
      ],
      cap,
    );

    expect(submitted).toHaveLength(1);
    expect(result.groups).toEqual(["g_1", "g_2"]);
  });
});
