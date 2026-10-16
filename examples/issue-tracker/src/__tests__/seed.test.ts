import { describe, expect, it } from "vitest";
import type { EntitySeed, SeedData } from "@ebbjs/core/seed";
import {
  SAMPLE_ISSUE_ID,
  SEED_PERMISSIONS,
  SEEDER_ACTOR_ID,
  SHARED_GROUP_ID,
  SHARED_MEMBER_ID,
  SHARED_WORKSPACE_ID,
  SHARED_WORKSPACE_MEMBERSHIP_ID,
  SHARED_WORKSPACE_SLUG,
  SAMPLE_ISSUE_MEMBERSHIP_ID,
  buildActorSeed,
  buildSharedSeed,
  deriveActorSeedIds,
  workspaceEntityId,
} from "../seed";

/** Project a seeded entity's plain field values for assertions. */
const entityFields = (seed: SeedData, id: string): Record<string, unknown> => {
  const row = seed.entities.find((entry) => entry.id === id);
  if (row === undefined) throw new Error(`no seeded entity ${id}`);
  return { ...row.patches[0]!.fields };
};

const entity = (seed: SeedData, id: string): EntitySeed => {
  const row = seed.entities.find((entry) => entry.id === id);
  if (row === undefined) throw new Error(`no seeded entity ${id}`);
  return row;
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

describe("buildActorSeed", () => {
  const actorId = "alice";
  const ids = deriveActorSeedIds(actorId);
  const seed = buildActorSeed(actorId);

  it("creates the actor's group and own membership with the seed permissions", () => {
    expect(seed.groups).toEqual([{ id: ids.groupId, name: "alice's Workspace" }]);
    expect(seed.groupMembers).toEqual([
      {
        id: ids.memberId,
        actorId,
        groupId: ids.groupId,
        permissions: [...SEED_PERMISSIONS],
      },
    ]);
  });

  it("creates the workspace and profile rows as the schema's entity types", () => {
    expect(entity(seed, ids.workspaceId).type).toBe("workspace");
    expect(entityFields(seed, ids.workspaceId)).toEqual({
      name: "alice's Workspace",
      slug: "alice",
      description: "Personal workspace for alice",
    });

    expect(entity(seed, ids.profileId).type).toBe("profile");
    expect(entityFields(seed, ids.profileId)).toEqual({
      actor_id: "alice",
      display_name: "alice",
      avatar_url: "",
    });
  });

  it("files the workspace and profile into the actor's group", () => {
    expect(seed.entityGroups).toEqual([
      {
        id: ids.workspaceMembershipId,
        entityId: ids.workspaceId,
        groupId: ids.groupId,
      },
      {
        id: ids.profileMembershipId,
        entityId: ids.profileId,
        groupId: ids.groupId,
      },
    ]);
  });

  it("stores no group_id field on a user entity", () => {
    expect(Object.keys(entityFields(seed, ids.workspaceId))).not.toContain("group_id");
    expect(Object.keys(entityFields(seed, ids.profileId))).not.toContain("group_id");
  });

  it("stores each entity field as a plain value", () => {
    expect(entity(seed, ids.workspaceId).patches[0]!.fields["name"]).toBe("alice's Workspace");
  });
});

describe("buildSharedSeed", () => {
  const seed = buildSharedSeed();

  it("creates the shared group and the seeder's membership", () => {
    expect(seed.groups).toEqual([{ id: SHARED_GROUP_ID, name: "Shared Workspace" }]);
    expect(seed.groupMembers).toEqual([
      {
        id: SHARED_MEMBER_ID,
        actorId: SEEDER_ACTOR_ID,
        groupId: SHARED_GROUP_ID,
        permissions: [...SEED_PERMISSIONS],
      },
    ]);
  });

  it("creates the shared workspace with a sample issue", () => {
    expect(entity(seed, SHARED_WORKSPACE_ID).type).toBe("workspace");
    expect(entityFields(seed, SHARED_WORKSPACE_ID)).toEqual({
      name: "Shared Workspace",
      slug: SHARED_WORKSPACE_SLUG,
      description: "Issues shared with every member.",
    });

    expect(entity(seed, SAMPLE_ISSUE_ID).type).toBe("issue");
    expect(entityFields(seed, SAMPLE_ISSUE_ID)).toEqual({
      title: "Welcome to ebb",
      status: "todo",
      priority: "medium",
    });
  });

  it("files the shared workspace and sample issue into the shared group", () => {
    expect(seed.entityGroups).toEqual([
      {
        id: SHARED_WORKSPACE_MEMBERSHIP_ID,
        entityId: SHARED_WORKSPACE_ID,
        groupId: SHARED_GROUP_ID,
      },
      {
        id: SAMPLE_ISSUE_MEMBERSHIP_ID,
        entityId: SAMPLE_ISSUE_ID,
        groupId: SHARED_GROUP_ID,
      },
    ]);
  });

  it("stores no group_id field on a user entity", () => {
    expect(Object.keys(entityFields(seed, SHARED_WORKSPACE_ID))).not.toContain("group_id");
    expect(Object.keys(entityFields(seed, SAMPLE_ISSUE_ID))).not.toContain("group_id");
  });
});
