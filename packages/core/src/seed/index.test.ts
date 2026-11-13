/**
 * Unit tests for the browser-safe seed builder (`@ebbjs/core/seed`).
 *
 * `buildSeedAction` turns plain seed rows into one wire `Action`; these
 * tests pin that wire shape — every plain value stamped into a field
 * envelope — and the rejection-tolerance policy in `assertSeedAccepted`.
 */

import { describe, expect, it } from "vitest";

import {
  SeedRejectedError,
  assertSeedAccepted,
  buildSeedAction,
  isToleratedSeedRejection,
  type SeedData,
  type SeedRejection,
} from "./index";

const rejection = (reason: string): SeedRejection => ({ id: "action_1", reason });

/** A representative seed exercising every row kind. */
const buildRepresentativeSeed = (): SeedData => ({
  groups: [{ id: "grp_1", name: "Group One" }],
  groupMembers: [
    {
      id: "gm_1",
      actorId: "actor_1",
      groupId: "grp_1",
      permissions: ["todo.*", "list.*"],
    },
  ],
  entities: [
    {
      id: "todo_1",
      type: "todo",
      patches: [
        { fields: { title: "Ship it" } },
        { fields: { status: "todo", assignee_id: null } },
      ],
    },
  ],
  relationships: [
    {
      id: "rel_1",
      sourceId: "todo_1",
      targetId: "list_1",
      type: "todo",
      field: "list",
    },
  ],
  entityGroups: [{ id: "eg_1", entityId: "todo_1", groupId: "grp_1" }],
});

/** The one Update carrying `component`, or a failure naming the miss. */
const componentOf = (
  action: ReturnType<typeof buildSeedAction>,
  component: string,
  subjectId?: string,
) => {
  const update = action.updates.find(
    (u) =>
      u.method !== "delete" &&
      u.component === component &&
      (subjectId === undefined || u.subject_id === subjectId),
  );
  if (update === undefined) throw new Error(`no update for component "${component}"`);
  return update;
};

describe("buildSeedAction", () => {
  it("builds one Action carrying one Update per component", () => {
    const action = buildSeedAction("actor_1", buildRepresentativeSeed());

    expect(action.actor_id).toBe("actor_1");
    expect(action.updates).toHaveLength(7);
    for (const update of action.updates) {
      expect(update.method).toBe("replace");
      expect(update.data).not.toBeNull();
    }

    expect(componentOf(action, "ebb/group", "grp_1").data).toMatchObject({
      value: { name: "Group One" },
    });
    expect(componentOf(action, "ebb/grant", "gm_1").data).toMatchObject({
      value: { actor_id: "actor_1", group_id: "grp_1", permissions: ["todo.*", "list.*"] },
    });

    expect(componentOf(action, "todo/title", "todo_1").data).toMatchObject({ value: "Ship it" });
    expect(componentOf(action, "todo/status", "todo_1").data).toMatchObject({ value: "todo" });
    expect(componentOf(action, "todo/assignee_id", "todo_1").data).toMatchObject({ value: null });

    expect(componentOf(action, "ebb/link", "rel_1").data).toMatchObject({
      value: { source_id: "todo_1", target_id: "list_1", type: "todo", field: "list" },
    });

    expect(componentOf(action, "ebb/membership", "eg_1").data).toMatchObject({
      value: { entity_id: "todo_1", group_id: "grp_1" },
    });
  });

  it("writes a group's app scope into the group's one atomic value", () => {
    const action = buildSeedAction("actor_1", {
      groups: [{ id: "grp_1", name: "Shared", apps: ["notes", "issues"] }],
      groupMembers: [],
      entities: [],
    });

    expect(action.updates).toHaveLength(1);
    const group = componentOf(action, "ebb/group");
    expect(group.method).toBe("replace");
    expect(group.data).toMatchObject({
      value: { name: "Shared", apps: ["notes", "issues"] },
    });
  });

  it("distinguishes an unscoped group from one scoped to no app", () => {
    const unscoped = buildSeedAction("actor_1", {
      groups: [{ id: "grp_1", name: "Shared" }],
      groupMembers: [],
      entities: [],
    });
    const noApps = buildSeedAction("actor_1", {
      groups: [{ id: "grp_1", name: "Shared", apps: [] }],
      groupMembers: [],
      entities: [],
    });

    expect(componentOf(unscoped, "ebb/group").data).toMatchObject({ value: { name: "Shared" } });
    expect(componentOf(noApps, "ebb/group").data).toMatchObject({
      value: { name: "Shared", apps: [] },
    });
  });

  it("stamps every plain value into a seed_update envelope with an HLC", () => {
    const action = buildSeedAction("actor_1", buildRepresentativeSeed());

    for (const update of action.updates) {
      const data = update.data as { value?: unknown; update_id?: string; hlc?: string };
      expect(data.update_id).toBe("seed_update");
      expect(data.hlc).toEqual(expect.any(String));
      expect(data.hlc).not.toBe("");
    }
  });
});

describe("assertSeedAccepted", () => {
  it("tolerates a duplicate or already-present seed", () => {
    for (const reason of ["already_exists", "duplicate_action"]) {
      expect(isToleratedSeedRejection(reason)).toBe(true);
      expect(() => assertSeedAccepted([rejection(reason)])).not.toThrow();
    }
  });

  it("does not tolerate a validation rejection", () => {
    expect(isToleratedSeedRejection("not_authorized")).toBe(false);
    expect(isToleratedSeedRejection(undefined)).toBe(false);
  });

  it("passes an empty rejection list", () => {
    expect(() => assertSeedAccepted([])).not.toThrow();
  });

  it("throws SeedRejectedError carrying the fatal rejections", () => {
    let thrown: unknown;
    try {
      assertSeedAccepted([rejection("already_exists"), rejection("not_authorized")]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SeedRejectedError);
    expect((thrown as SeedRejectedError).rejections).toEqual([rejection("not_authorized")]);
  });
});
