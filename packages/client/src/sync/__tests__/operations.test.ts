/**
 * Unit tests for the `changeGroups` operation — the pure membership
 * delta every draft membership verb builds.
 */

import { describe, expect, it } from "vitest";

import { EntityRegistry } from "@ebbjs/schema";
import { ActionRejectedError, call, changeGroups, type OpContext } from "@ebbjs/write";
import { commit, type CommitCapability } from "@ebbjs/write";

const mkCtx = (): OpContext => ({
  registry: new EntityRegistry(),
  ids: {
    updateId: () => "u_1",
    hlc: () => "hlc_1",
    newId: (prefix: string) => `${prefix}_1`,
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
    ).toThrowError(ActionRejectedError);
  });

  it("refuses a membership write whose fan-out scope cannot be resolved", () => {
    expect(() =>
      changeGroups(mkCtx(), {
        entity: "todo",
        entityId: "todo_1",
        removes: [{ membershipId: "eg_1", groupId: "" }],
      }),
    ).toThrowError(ActionRejectedError);
  });

  it("commits a membership span through the committer", async () => {
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
