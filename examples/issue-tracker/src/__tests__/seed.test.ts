import { describe, expect, it } from "vitest";
import type { Action, Update } from "@ebbjs/core";
import {
  SEED_PERMISSIONS,
  SEEDER_ACTOR_ID,
  SHARED_GROUP_ID,
  SHARED_WORKSPACE_ID,
  SHARED_WORKSPACE_SLUG,
  SAMPLE_ISSUE_ID,
  buildActorSeedAction,
  buildSharedSeedAction,
  deriveActorSeedIds,
  workspaceEntityId,
} from "../seed";

/** Updates in the Action with the given subject type. */
const updatesOfType = (action: Action, type: string): readonly Update[] =>
  action.updates.filter((update) => update.subject_type === type);

/** Flat field map of a `put`/`patch` Update; system rows are leaf-only. */
const fieldsOf = (update: Update): Record<string, unknown> => {
  const data = update.data;
  if (data === null || !("fields" in data)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data.fields)) {
    out[key] = "value" in value ? value.value : value;
  }
  return out;
};

/** The single Update for `subjectId`, or a loud failure. */
const only = (action: Action, subjectId: string): Update => {
  const matches = action.updates.filter((update) => update.subject_id === subjectId);
  expect(matches).toHaveLength(1);
  return matches[0];
};

describe("deriveActorSeedIds", () => {
  it("derives the same deterministic ids for the same actor", () => {
    expect(deriveActorSeedIds("alice")).toEqual({
      groupId: "grp_alice",
      memberId: "gm_alice",
      workspaceId: "ws_alice",
      profileId: "prof_alice",
      workspaceMembershipId: "eg_ws_alice",
      profileMembershipId: "eg_prof_alice",
    });
    expect(deriveActorSeedIds("alice")).toEqual(deriveActorSeedIds("alice"));
    expect(deriveActorSeedIds("alice").groupId).not.toBe(deriveActorSeedIds("bob").groupId);
  });
});

describe("workspaceEntityId", () => {
  it("maps the shared slug to the shared workspace id", () => {
    expect(workspaceEntityId(SHARED_WORKSPACE_SLUG)).toBe(SHARED_WORKSPACE_ID);
  });

  it("maps a personal slug to its derived workspace id", () => {
    expect(workspaceEntityId("alice")).toBe("ws_alice");
  });
});

describe("buildActorSeedAction", () => {
  const actorId = "alice";
  const action = buildActorSeedAction(actorId);
  const ids = deriveActorSeedIds(actorId);

  it("is attributed to the actor and creates exactly one group", () => {
    expect(action.actor_id).toBe(actorId);
    const groups = updatesOfType(action, "group");
    expect(groups).toHaveLength(1);
    expect(fieldsOf(groups[0])).toEqual({ name: "alice's Workspace" });
  });

  it("creates the actor's own groupMember with the seed permissions", () => {
    const members = updatesOfType(action, "groupMember");
    expect(members).toHaveLength(1);
    expect(members[0].subject_id).toBe(ids.memberId);
    expect(fieldsOf(members[0])).toEqual({
      actor_id: actorId,
      group_id: ids.groupId,
      permissions: [...SEED_PERMISSIONS],
    });
  });

  it("creates the workspace and profile entities", () => {
    expect(fieldsOf(only(action, ids.workspaceId))).toEqual({
      name: "alice's Workspace",
      slug: "alice",
      description: "Personal workspace for alice",
    });
    expect(fieldsOf(only(action, ids.profileId))).toEqual({
      actor_id: "alice",
      display_name: "alice",
      avatar_url: "",
    });
  });

  it("files the workspace and profile into the actor's group", () => {
    const memberships = updatesOfType(action, "entityGroup");
    expect(memberships).toHaveLength(2);
    expect(fieldsOf(only(action, ids.workspaceMembershipId))).toEqual({
      entity_id: ids.workspaceId,
      group_id: ids.groupId,
    });
    expect(fieldsOf(only(action, ids.profileMembershipId))).toEqual({
      entity_id: ids.profileId,
      group_id: ids.groupId,
    });
  });

  it("stores no group_id field on a user entity", () => {
    const userEntityIds = new Set([ids.workspaceId, ids.profileId]);
    const userUpdates = action.updates.filter((update) => userEntityIds.has(update.subject_id));
    expect(userUpdates).toHaveLength(2);
    for (const update of userUpdates) {
      expect(Object.keys(fieldsOf(update))).not.toContain("group_id");
    }
  });

  it("mints fresh update ids and HLCs on every build", () => {
    const second = buildActorSeedAction(actorId);
    expect(second.id).not.toBe(action.id);
    expect(second.updates.map((update) => update.id)).not.toEqual(
      action.updates.map((update) => update.id),
    );
  });
});

describe("buildSharedSeedAction", () => {
  const action = buildSharedSeedAction();

  it("is attributed to the service seeder", () => {
    expect(action.actor_id).toBe(SEEDER_ACTOR_ID);
  });

  it("creates the shared group and the seeder's membership", () => {
    const groups = updatesOfType(action, "group");
    expect(groups).toHaveLength(1);
    expect(groups[0].subject_id).toBe(SHARED_GROUP_ID);

    const members = updatesOfType(action, "groupMember");
    expect(members).toHaveLength(1);
    expect(fieldsOf(members[0])).toEqual({
      actor_id: SEEDER_ACTOR_ID,
      group_id: SHARED_GROUP_ID,
      permissions: [...SEED_PERMISSIONS],
    });
  });

  it("creates the shared workspace with a sample issue", () => {
    expect(fieldsOf(only(action, SHARED_WORKSPACE_ID))).toEqual({
      name: "Shared Workspace",
      slug: SHARED_WORKSPACE_SLUG,
      description: "Issues shared with every member.",
    });
    expect(fieldsOf(only(action, SAMPLE_ISSUE_ID))).toEqual({
      title: "Welcome to ebb",
      status: "todo",
      priority: "medium",
      assignee_id: null,
    });
  });

  it("files the shared workspace and sample issue into the shared group", () => {
    const memberships = updatesOfType(action, "entityGroup");
    expect(memberships).toHaveLength(2);
    expect(
      memberships
        .map((update) => fieldsOf(update))
        .sort((a, b) => String(a.entity_id).localeCompare(String(b.entity_id))),
    ).toEqual([
      { entity_id: SAMPLE_ISSUE_ID, group_id: SHARED_GROUP_ID },
      { entity_id: SHARED_WORKSPACE_ID, group_id: SHARED_GROUP_ID },
    ]);
  });

  it("stores no group_id field on a user entity", () => {
    const userUpdates = action.updates.filter(
      (update) =>
        update.subject_id === SHARED_WORKSPACE_ID || update.subject_id === SAMPLE_ISSUE_ID,
    );
    expect(userUpdates).toHaveLength(2);
    for (const update of userUpdates) {
      expect(Object.keys(fieldsOf(update))).not.toContain("group_id");
    }
  });
});
