/**
 * Unit tests for the browser-safe seed builder (`@ebbjs/core/seed`).
 *
 * `buildSeedAction` turns plain seed rows into one wire `Action`; these
 * tests pin that wire shape — every plain value stamped into a field
 * envelope — and the one rejection-tolerance policy in
 * `assertSeedAccepted`.
 */

import { describe, expect, it } from "vitest";

import {
  SeedRejectedError,
  TOLERATED_SEED_REJECTIONS,
  assertSeedAccepted,
  buildSeedAction,
  isToleratedSeedRejection,
  type SeedData,
  type SeedRejection,
} from "../index";

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
    (u) => u.component === component && (subjectId === undefined || u.subject_id === subjectId),
  );
  if (update === undefined) throw new Error(`no update for component "${component}"`);
  return update;
};

describe("buildSeedAction", () => {
  it("builds one Action carrying one Update per component", () => {
    const action = buildSeedAction("actor_1", buildRepresentativeSeed());

    expect(action.actor_id).toBe("actor_1");
    expect(action.updates).toHaveLength(13);
    for (const update of action.updates) {
      expect(update.method).toBe("replace");
      expect(update.data).not.toBeNull();
    }

    const group = componentOf(action, "group/name", "grp_1");
    expect(group.data).toMatchObject({ value: "Group One" });

    const member = componentOf(action, "groupMember/actor_id", "gm_1");
    expect(member.data).toMatchObject({ value: "actor_1" });
    expect(componentOf(action, "groupMember/group_id", "gm_1").data).toMatchObject({
      value: "grp_1",
    });
    expect(componentOf(action, "groupMember/permissions", "gm_1").data).toMatchObject({
      value: ["todo.*", "list.*"],
    });

    expect(componentOf(action, "todo/title", "todo_1").data).toMatchObject({ value: "Ship it" });
    expect(componentOf(action, "todo/status", "todo_1").data).toMatchObject({ value: "todo" });
    expect(componentOf(action, "todo/assignee_id", "todo_1").data).toMatchObject({ value: null });

    expect(componentOf(action, "relationship/source_id", "rel_1").data).toMatchObject({
      value: "todo_1",
    });
    expect(componentOf(action, "relationship/target_id", "rel_1").data).toMatchObject({
      value: "list_1",
    });
    expect(componentOf(action, "relationship/type", "rel_1").data).toMatchObject({
      value: "todo",
    });
    expect(componentOf(action, "relationship/field", "rel_1").data).toMatchObject({
      value: "list",
    });

    expect(componentOf(action, "entityGroup/entity_id", "eg_1").data).toMatchObject({
      value: "todo_1",
    });
    expect(componentOf(action, "entityGroup/group_id", "eg_1").data).toMatchObject({
      value: "grp_1",
    });
  });

  it("writes a group's app scope as a merge of a map envelope with one leaf per app id", () => {
    const action = buildSeedAction("actor_1", {
      groups: [{ id: "grp_1", name: "Shared", apps: { notes: true, issues: false } }],
      groupMembers: [],
      entities: [],
    });

    const apps = componentOf(action, "group/apps") as {
      data: { map: Record<string, { value: boolean; update_id: string; hlc: string }> };
    };

    expect(action.updates).toHaveLength(2);
    expect((componentOf(action, "group/apps") as { method: string }).method).toBe("merge");
    expect(Object.keys(apps.data.map)).toEqual(["notes", "issues"]);
    expect(apps.data.map["notes"]!.value).toBe(true);
    expect(apps.data.map["issues"]!.value).toBe(false);
    expect(apps.data.map["notes"]!.update_id).toBe("seed_update");
    expect(typeof apps.data.map["notes"]!.hlc).toBe("string");
  });

  it("omits the apps component when the group is left unscoped", () => {
    const action = buildSeedAction("actor_1", buildRepresentativeSeed());

    expect(action.updates.some((update) => update.component === "group/apps")).toBe(false);
  });

  it("stamps every plain value into a seed_update envelope with an HLC", () => {
    const action = buildSeedAction("actor_1", buildRepresentativeSeed());

    for (const update of action.updates) {
      const data = update.data as { value?: unknown; update_id?: string; hlc?: string };
      expect(data.update_id).toBe("seed_update");
      expect(typeof data.hlc).toBe("string");
      expect(data.hlc).not.toBe("");
    }
  });
});

describe("assertSeedAccepted", () => {
  it("defines the tolerance policy once", () => {
    expect([...TOLERATED_SEED_REJECTIONS]).toEqual(["already_exists", "duplicate_action"]);
    expect(isToleratedSeedRejection("already_exists")).toBe(true);
    expect(isToleratedSeedRejection("duplicate_action")).toBe(true);
    expect(isToleratedSeedRejection("not_authorized")).toBe(false);
    expect(isToleratedSeedRejection(undefined)).toBe(false);
  });

  it("passes tolerated rejections through", () => {
    expect(() => assertSeedAccepted([rejection("already_exists")])).not.toThrow();
    expect(() => assertSeedAccepted([rejection("duplicate_action")])).not.toThrow();
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
