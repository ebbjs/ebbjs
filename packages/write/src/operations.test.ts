/**
 * Unit tests for the `changeGroups` operation — the pure membership
 * delta every draft membership verb builds.
 */

import { describe, expect, it } from "vitest";
import { componentModel, type Update } from "@ebbjs/core";

import { ModelRegistry } from "@ebbjs/schema";
import { ActionRejectedError, changeGroups, type OpContext } from "./operations";

/** The Updates of one model, grouped into one list per subject row. */
const rowsOf = (updates: readonly Update[], model: string): readonly (readonly Update[])[] => {
  const bySubject = new Map<string, Update[]>();
  for (const update of updates) {
    if (update.method === "delete" || componentModel(update.component) !== model) continue;
    const row = bySubject.get(update.subject_id);
    if (row === undefined) bySubject.set(update.subject_id, [update]);
    else row.push(update);
  }
  return [...bySubject.values()];
};

/** A row's component values, keyed by field. */
const fieldsOf = (row: readonly Update[]): Record<string, unknown> =>
  Object.fromEntries(
    row
      .filter((update) => update.method === "merge" || update.method === "replace")
      .map((update) => [
        update.method === "delete" ? "" : update.component.slice(update.component.indexOf("/") + 1),
        update.method === "delete" ? null : (update.data as { value: unknown }).value,
      ]),
  );

const mkCtx = (): OpContext => ({
  registry: new ModelRegistry(),
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

    expect(result.updates.map((update) => update.method)).toEqual(["replace", "replace", "delete"]);
    const [groupRow] = rowsOf(result.updates, "entityGroup");
    expect(fieldsOf(groupRow!)["group_id"]).toBe("g_2");
    expect(result.updates.at(-1)!.subject_id).toBe("eg_1");
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
});
