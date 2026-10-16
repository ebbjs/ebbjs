/**
 * Unit tests for the `changeGroups` operation — the pure membership
 * delta both the imperative verbs and the atomic drafts build.
 */

import { describe, expect, it } from "vitest";

import { EntityRegistry } from "../../schema/entity-registry";
import { AtomicActionError, call, changeGroups, type OpContext } from "../operations";
import { commit, type CommitCapability } from "../committer";

const mkCtx = (): OpContext => ({
  registry: new EntityRegistry(),
  ids: {
    entityId: () => "e_1",
    updateId: () => "u_1",
    hlc: () => "hlc_1",
  },
  actorId: "actor_1",
});

describe("changeGroups", () => {
  it("emits an entityGroup put per added group then a delete per removed row", () => {
    const result = changeGroups(mkCtx(), {
      entity: "todo",
      entityId: "todo_1",
      puts: ["g_2"],
      removes: [{ membershipId: "eg_1", groupId: "g_1" }],
      currentGroups: ["g_1"],
    });

    expect(result.updates.map((update) => update.method)).toEqual(["put", "delete"]);
    expect(result.updates[0]!.subject_type).toBe("entityGroup");
    expect(result.updates[0]!.data?.fields?.["group_id"]?.value).toBe("g_2");
    expect(result.updates[1]!.subject_id).toBe("eg_1");
    expect(result.groups).toEqual(["g_1", "g_2"]);
    expect(result.subject).toEqual({ id: "todo_1", type: "todo" });
  });

  it("refuses a delta that would leave the entity with no owning group", () => {
    expect(() =>
      changeGroups(mkCtx(), {
        entity: "todo",
        entityId: "todo_1",
        removes: [{ membershipId: "eg_1", groupId: "g_1" }],
        currentGroups: ["g_1"],
      }),
    ).toThrowError(AtomicActionError);
  });

  it("refuses a membership write whose fan-out scope cannot be resolved", () => {
    expect(() =>
      changeGroups(mkCtx(), {
        entity: "todo",
        entityId: "todo_1",
        removes: [{ membershipId: "eg_1", groupId: "" }],
      }),
    ).toThrowError(AtomicActionError);
  });

  it("commits a system-only span through the committer", async () => {
    const submitted: unknown[] = [];
    const cap: CommitCapability = {
      registry: new EntityRegistry(),
      submitRelationshipUpdates: async (updates) => {
        submitted.push(updates);
        return { rejected: [] };
      },
      freshHlc: () => "hlc_1",
      generateUpdateId: () => "u_1",
      actorId: "actor_1",
    };

    const { groups } = await commit(
      [
        call(changeGroups, {
          entity: "todo",
          entityId: "todo_1",
          puts: ["g_2"],
          currentGroups: ["g_1"],
        }),
      ],
      cap,
    );

    expect(submitted).toHaveLength(1);
    expect(groups).toEqual(["g_2"]);
  });
});
