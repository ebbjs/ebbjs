/**
 * Shape tests for `AtomicActionError`, the typed failure the atomic
 * resolver throws for a coherence refusal and for a server-side
 * rejection. Mirrors `EntityValidationError`: extends `Error`, sets
 * `name`, carries the structured reasons as a readonly array, and
 * formats a multi-line `message` from them.
 */

import { describe, expect, it } from "vitest";

import { EntityValidationError } from "../../schema/entity-registry";
import { AtomicActionError, type AtomicRejection } from "../atomic";

const coherenceRejection: AtomicRejection = {
  id: "e_todo1",
  subjectType: "todo",
  reason: "group_mismatch",
  details: "belongs to group(s) [g_1]; the Action writes to [g_1, g_2]",
};

const serverRejection: AtomicRejection = {
  id: "act_1",
  reason: "not_authorized",
  details: "actor lacks todo.put in group g_1",
};

describe("AtomicActionError", () => {
  it("carries the rejection reasons and formats one message line per rejection", () => {
    const error = new AtomicActionError([coherenceRejection, serverRejection]);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AtomicActionError");
    expect(error.rejections).toEqual([coherenceRejection, serverRejection]);
    expect(error.message.split("\n")).toEqual([
      "AtomicActionError: 2 rejected update(s)",
      "  - todo e_todo1: group_mismatch (belongs to group(s) [g_1]; the Action writes to [g_1, g_2])",
      "  - act_1: not_authorized (actor lacks todo.put in group g_1)",
    ]);
  });

  it("omits the subject type and details when the rejection has neither", () => {
    const error = new AtomicActionError([{ id: "act_2", reason: "duplicate" }]);

    expect(error.message).toBe("AtomicActionError: 1 rejected update(s)\n  - act_2: duplicate");
  });

  it("keeps a stable message for an empty rejection list", () => {
    expect(new AtomicActionError([]).message).toBe("AtomicActionError");
  });

  it("mirrors EntityValidationError's error surface", () => {
    const validation = new EntityValidationError([{ entityName: "todo", message: "bad field" }]);
    const atomic = new AtomicActionError([coherenceRejection]);

    expect(atomic).toBeInstanceOf(Error);
    expect(validation).toBeInstanceOf(Error);
    expect(atomic.name.endsWith("Error")).toBe(true);
    expect(Array.isArray(atomic.rejections)).toBe(true);
    expect(validation.violations).toHaveLength(1);
    expect(atomic.rejections).toHaveLength(1);
  });
});
