/**
 * Typed seed data for the issue-tracker demo.
 *
 * Two `SeedData` values, each submitted as its own Action through
 * `client.seed()`:
 *
 * 1. The signed-in actor's personal workspace (`grp_<actorId>`) with
 *    their own `groupMember` row, a `workspace` and a `profile`, and one
 *    `entityGroup` per user entity. Attributed to the actor, so the
 *    server's group-bootstrap exemption sees the actor bootstrapping
 *    their own group.
 * 2. A shared workspace seeded by the dedicated service actor
 *    `demo-seeder` (the invite/service-account pattern from #126),
 *    carrying a sample issue. The signed-in actor is deliberately not
 *    added to it — that membership bookkeeping is #441.
 *
 * Every id is derived from the actor id (or a fixed literal for the
 * shared fixtures), so re-running on reload is idempotent: the same rows
 * are re-`put`, and the seed permissions cover the re-put path (a
 * committed group is authorized by `group.create` in that group, not by
 * the bootstrap exemption).
 *
 * Browser-safe by construction: this module imports only
 * `@ebbjs/client`.
 */

import type { EntitySeed, SeedData } from "@ebbjs/client";
import { issue, profile, workspace } from "./schema";

/** Service actor that owns the shared workspace fixtures. */
export const SEEDER_ACTOR_ID = "demo-seeder";

/**
 * Permissions the seed grants each actor in their own group. Broad enough
 * that the idempotent re-seed passes the permission table on reload: the
 * group, its own membership, and every user entity it files are all
 * writable by the actor that created them.
 */
export const SEED_PERMISSIONS = [
  "group.*",
  "groupMember.*",
  "entityGroup.*",
  "relationship.*",
  "workspace.*",
  "profile.*",
  "issue.*",
] as const;

/** Shared workspace fixtures, fixed so every actor sees the same ids. */
export const SHARED_GROUP_ID = "grp_shared";
export const SHARED_MEMBER_ID = "gm_shared";
export const SHARED_WORKSPACE_ID = "ws_shared";
export const SHARED_WORKSPACE_SLUG = "shared";
export const SHARED_WORKSPACE_MEMBERSHIP_ID = "eg_ws_shared";
export const SAMPLE_ISSUE_ID = "issue_sample";
export const SAMPLE_ISSUE_MEMBERSHIP_ID = "eg_issue_shared";

/** Stable ids the personal-workspace seed mints for one actor. */
export interface ActorSeedIds {
  readonly groupId: string;
  readonly memberId: string;
  readonly workspaceId: string;
  readonly profileId: string;
  readonly workspaceMembershipId: string;
  readonly profileMembershipId: string;
}

/** Derive the actor's deterministic personal-workspace ids. */
export function deriveActorSeedIds(actorId: string): ActorSeedIds {
  return {
    groupId: `grp_${actorId}`,
    memberId: `gm_${actorId}`,
    workspaceId: `ws_${actorId}`,
    profileId: `prof_${actorId}`,
    workspaceMembershipId: `eg_ws_${actorId}`,
    profileMembershipId: `eg_prof_${actorId}`,
  };
}

/**
 * Resolve a workspace row's entity id from its slug. The seed pins the
 * id scheme (`ws_<slug>`, with the shared workspace fixed at `ws_shared`),
 * so a list view can address a query row with `get(id)` until #447
 * surfaces group ids on query rows and removes the need.
 */
export function workspaceEntityId(slug: string): string {
  return slug === SHARED_WORKSPACE_SLUG ? SHARED_WORKSPACE_ID : `ws_${slug}`;
}

/** One seed field envelope. The server validates the HLC as a positive integer. */
type SeedFieldValue = EntitySeed["patches"][number]["fields"][string];

const SEED_UPDATE_ID = "seed_update";
const SEED_HLC = "1";

const field = (value: unknown): SeedFieldValue => ({
  value,
  update_id: SEED_UPDATE_ID,
  hlc: SEED_HLC,
});

const fields = (values: Record<string, unknown>): Record<string, SeedFieldValue> =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, field(value)]));

/** One user entity with every field carried as a seed envelope. */
const entity = (id: string, type: string, values: Record<string, unknown>): EntitySeed => ({
  id,
  type,
  patches: [{ fields: fields(values) }],
});

/** The actor's personal workspace, profile, and own group membership. */
export function buildActorSeed(actorId: string): SeedData {
  const ids = deriveActorSeedIds(actorId);
  const workspaceName = `${actorId}'s Workspace`;

  return {
    groups: [{ id: ids.groupId, name: workspaceName }],
    groupMembers: [
      {
        id: ids.memberId,
        actorId,
        groupId: ids.groupId,
        permissions: [...SEED_PERMISSIONS],
      },
    ],
    entities: [
      entity(ids.workspaceId, workspace.name, {
        name: workspaceName,
        slug: actorId,
        description: `Personal workspace for ${actorId}`,
      }),
      entity(ids.profileId, profile.name, {
        actor_id: actorId,
        display_name: actorId,
        avatar_url: "",
      }),
    ],
    entityGroups: [
      { id: ids.workspaceMembershipId, entityId: ids.workspaceId, groupId: ids.groupId },
      { id: ids.profileMembershipId, entityId: ids.profileId, groupId: ids.groupId },
    ],
  };
}

/** The shared workspace fixtures, attributed to `demo-seeder`. */
export function buildSharedSeed(): SeedData {
  return {
    groups: [{ id: SHARED_GROUP_ID, name: "Shared Workspace" }],
    groupMembers: [
      {
        id: SHARED_MEMBER_ID,
        actorId: SEEDER_ACTOR_ID,
        groupId: SHARED_GROUP_ID,
        permissions: [...SEED_PERMISSIONS],
      },
    ],
    entities: [
      entity(SHARED_WORKSPACE_ID, workspace.name, {
        name: "Shared Workspace",
        slug: SHARED_WORKSPACE_SLUG,
        description: "Issues shared with every member.",
      }),
      entity(SAMPLE_ISSUE_ID, issue.name, {
        title: "Welcome to ebb",
        status: "todo",
        priority: "medium",
        assignee_id: null,
      }),
    ],
    entityGroups: [
      {
        id: SHARED_WORKSPACE_MEMBERSHIP_ID,
        entityId: SHARED_WORKSPACE_ID,
        groupId: SHARED_GROUP_ID,
      },
      { id: SAMPLE_ISSUE_MEMBERSHIP_ID, entityId: SAMPLE_ISSUE_ID, groupId: SHARED_GROUP_ID },
    ],
  };
}
