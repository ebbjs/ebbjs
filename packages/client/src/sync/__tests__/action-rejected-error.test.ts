/**
 * Shape tests for `ActionRejectedError`, the typed failure an Action
 * throws for a client-side membership refusal and for a server-side
 * rejection.
 */

import { describe, expect, it } from "vitest";

import { EntityValidationError } from "../../schema/entity-registry";
import { ActionRejectedError, type ActionRejection } from "../drafts";

const membershipRejection: ActionRejection = {
  id: "e_todo1",
  subjectType: "todo",
  reason: "last_membership",
  details: "removing this membership would leave the entity with no owning group",
};

const serverRejection: ActionRejection = {
  id: "act_1",
  reason: "not_authorized",
  details: "actor lacks todo.put in group g_1",
};

describe("ActionRejectedError", () => {
  it("carries the rejection reasons and formats one message line per rejection", () => {
    const error = new ActionRejectedError([membershipRejection, serverRejection]);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ActionRejectedError");
    expect(error.rejections).toEqual([membershipRejection, serverRejection]);
    expect(error.message.split("\n")).toEqual([
      "ActionRejectedError: 2 rejected update(s)",
      "  - todo e_todo1: last_membership (removing this membership would leave the entity with no owning group)",
      "  - act_1: not_authorized (actor lacks todo.put in group g_1)",
    ]);
  });

  it("omits the subject type and details when the rejection has neither", () => {
    const error = new ActionRejectedError([{ id: "act_2", reason: "duplicate" }]);

    expect(error.message).toBe("ActionRejectedError: 1 rejected update(s)\n  - act_2: duplicate");
  });

  it("keeps a stable message for an empty rejection list", () => {
    expect(new ActionRejectedError([]).message).toBe("ActionRejectedError");
  });

  it("mirrors EntityValidationError's error surface", () => {
    const validation = new EntityValidationError([{ entityName: "todo", message: "bad field" }]);
    const rejected = new ActionRejectedError([membershipRejection]);

    expect(rejected).toBeInstanceOf(Error);
    expect(validation).toBeInstanceOf(Error);
    expect(rejected.name).toBe("ActionRejectedError");
    expect(Array.isArray(rejected.rejections)).toBe(true);
    expect(validation.violations).toHaveLength(1);
    expect(rejected.rejections).toHaveLength(1);
  });
});
