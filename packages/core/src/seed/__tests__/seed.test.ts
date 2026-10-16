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

describe("buildSeedAction", () => {
  it("builds one Action carrying every seed row as a put Update", () => {
    const action = buildSeedAction("actor_1", buildRepresentativeSeed());

    expect(action.actor_id).toBe("actor_1");
    expect(action.updates).toHaveLength(5);
    for (const update of action.updates) {
      expect(update.method).toBe("put");
    }

    const group = action.updates.find((u) => u.subject_type === "group")!;
    expect(group.subject_id).toBe("grp_1");
    expect(group.data?.fields?.["name"]?.value).toBe("Group One");

    const member = action.updates.find((u) => u.subject_type === "groupMember")!;
    expect(member.subject_id).toBe("gm_1");
    expect(member.data?.fields?.["actor_id"]?.value).toBe("actor_1");
    expect(member.data?.fields?.["group_id"]?.value).toBe("grp_1");
    expect(member.data?.fields?.["permissions"]?.value).toEqual(["todo.*", "list.*"]);

    const entity = action.updates.find((u) => u.subject_type === "todo")!;
    expect(entity.subject_id).toBe("todo_1");
    expect(entity.data?.fields?.["title"]?.value).toBe("Ship it");
    expect(entity.data?.fields?.["status"]?.value).toBe("todo");
    expect(entity.data?.fields?.["assignee_id"]?.value).toBeNull();

    const relationship = action.updates.find((u) => u.subject_type === "relationship")!;
    expect(relationship.subject_id).toBe("rel_1");
    expect(relationship.data?.fields?.["source_id"]?.value).toBe("todo_1");
    expect(relationship.data?.fields?.["target_id"]?.value).toBe("list_1");
    expect(relationship.data?.fields?.["type"]?.value).toBe("todo");
    expect(relationship.data?.fields?.["field"]?.value).toBe("list");

    const entityGroup = action.updates.find((u) => u.subject_type === "entityGroup")!;
    expect(entityGroup.subject_id).toBe("eg_1");
    expect(entityGroup.data?.fields?.["entity_id"]?.value).toBe("todo_1");
    expect(entityGroup.data?.fields?.["group_id"]?.value).toBe("grp_1");
  });

  it("stamps every plain value into a seed_update envelope with an HLC", () => {
    const action = buildSeedAction("actor_1", buildRepresentativeSeed());

    for (const update of action.updates) {
      for (const field of Object.values(update.data?.fields ?? {})) {
        expect(field.update_id).toBe("seed_update");
        expect(typeof field.hlc).toBe("string");
        expect(field.hlc).not.toBe("");
      }
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
