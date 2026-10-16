/**
 * Unit tests for the committer — the one place a batch of operations
 * becomes a single Action.
 *
 * Operations are pure, so these tests supply a `CommitCapability`
 * double: a registry, an id/clock mint, and a submit hook that records
 * every batch. The committer imposes no group-set gate: a batch that
 * spans groups is submitted as one Action and each Update keeps its own
 * scope (#473).
 */

import { describe, expect, it } from "vitest";
import type { Update } from "@ebbjs/core";

import { defineEntity, e } from "../../schema/entity";
import { EntityRegistry } from "../../schema/entity-registry";
import { defineRelationship } from "../../schema/relationship";
import {
  AtomicActionError,
  call,
  changeGroups,
  createEntity,
  writeRelationship,
} from "../operations";
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

describe("commit — per-Update scope (#473)", () => {
  it("submits content ops with different group sets as one Action", async () => {
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
          groups: ["g_2"],
        }),
      ],
      cap,
    );

    expect(submitted).toHaveLength(1);
    // One put + one entityGroup row per create.
    expect(submitted[0]).toHaveLength(4);
    expect(result.groups).toEqual(["g_1", "g_2"]);
    expect(result.response.rejected).toEqual([]);
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

  it("allows a relationship-only batch to span groups", async () => {
    const { cap, submitted } = mkCap();

    const result = await commit(
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
    );

    // Two relationship puts into different groups; the server delivers
    // each by its own scope.
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toHaveLength(2);
    expect(result.groups).toEqual(["g_1", "g_2"]);
  });

  it("allows a membership batch to span the affected groups", async () => {
    const { cap, submitted } = mkCap();

    const result = await commit(
      [
        call(changeGroups, {
          entity: "todo",
          entityId: "todo_1",
          puts: ["g_2"],
          currentGroups: ["g_3"],
        }),
        call(changeGroups, {
          entity: "todo",
          entityId: "todo_2",
          removes: [{ membershipId: "eg_1", groupId: "g_3" }],
          currentGroups: ["g_3", "g_4"],
        }),
      ],
      cap,
    );

    expect(submitted).toHaveLength(1);
    // One entityGroup put + one entityGroup delete.
    expect(submitted[0]).toHaveLength(2);
    expect(result.groups).toEqual(["g_2", "g_3"]);
  });

  it("submits a content create in g_1 plus a membership delta into g_2 as one Action", async () => {
    const { cap, submitted } = mkCap();

    const result = await commit(
      [
        call(createEntity, {
          entity: "todo",
          id: "todo_1",
          fields: { title: "a" },
          groups: ["g_1"],
        }),
        call(changeGroups, { entity: "todo", entityId: "todo_2", puts: ["g_2"] }),
      ],
      cap,
    );

    expect(submitted).toHaveLength(1);
    // One content put + one entityGroup put for the create, plus one
    // entityGroup put for the membership delta.
    expect(submitted[0]).toHaveLength(3);
    expect(result.groups).toEqual(["g_1", "g_2"]);
  });

  it("allows a content create in g_1 plus a membership delta into g_1", async () => {
    const { cap, submitted } = mkCap();

    const result = await commit(
      [
        call(createEntity, {
          entity: "todo",
          id: "todo_1",
          fields: { title: "a" },
          groups: ["g_1"],
        }),
        call(changeGroups, {
          entity: "todo",
          entityId: "todo_2",
          puts: ["g_1"],
          currentGroups: ["g_1"],
        }),
      ],
      cap,
    );

    expect(submitted).toHaveLength(1);
    expect(result.groups).toEqual(["g_1"]);
  });

  it("refuses a membership delta that would leave the entity unowned", async () => {
    const { cap, submitted } = mkCap();

    const error = (await capture(() =>
      commit(
        [
          call(changeGroups, {
            entity: "todo",
            entityId: "todo_1",
            removes: [{ membershipId: "eg_1", groupId: "g_1" }],
            currentGroups: ["g_1"],
          }),
        ],
        cap,
      ),
    )) as AtomicActionError;

    expect(error).toBeInstanceOf(AtomicActionError);
    expect(error.rejections.map((r) => r.reason)).toEqual(["last_membership"]);
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
