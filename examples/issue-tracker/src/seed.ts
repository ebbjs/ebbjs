/**
 * Bootstrap seed for the issue-tracker demo.
 *
 * Two Actions, each self-contained so the server's group bootstrap
 * exemption authorizes it:
 *
 * 1. The signed-in actor's personal workspace (`grp_<actorId>`) with
 *    their own `groupMember` row, a `workspace` and a `profile`, and one
 *    `entityGroup` per user entity. Attributed to the actor, so the
 *    exemption sees the actor bootstrapping their own group.
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
 * Browser-safe by construction: this module imports only `@ebbjs/core`
 * (pure fetch + msgpack) and never `@ebbjs/server`.
 */

import {
  createAction,
  createClock,
  encodeSync,
  localEvent,
  type Action,
  type FieldValue,
  type UpdateInput,
} from "@ebbjs/core";
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

type Clock = ReturnType<typeof createClock>;

const leaf = (clock: Clock, value: unknown): FieldValue => ({
  value,
  update_id: "seed_update",
  hlc: localEvent(clock),
});

const put = (
  subjectId: string,
  subjectType: string,
  values: Record<string, unknown>,
  clock: Clock,
): UpdateInput => {
  const fields: Record<string, FieldValue> = {};
  for (const [key, value] of Object.entries(values)) {
    fields[key] = leaf(clock, value);
  }
  return {
    subject_id: subjectId,
    subject_type: subjectType,
    method: "put",
    data: { fields },
  };
};

function buildActorSeedUpdates(actorId: string, clock: Clock): UpdateInput[] {
  const ids = deriveActorSeedIds(actorId);
  const workspaceName = `${actorId}'s Workspace`;

  return [
    put(ids.groupId, "group", { name: workspaceName }, clock),
    put(
      ids.memberId,
      "groupMember",
      { actor_id: actorId, group_id: ids.groupId, permissions: [...SEED_PERMISSIONS] },
      clock,
    ),
    put(
      ids.workspaceId,
      workspace.name,
      { name: workspaceName, slug: actorId, description: `Personal workspace for ${actorId}` },
      clock,
    ),
    put(
      ids.workspaceMembershipId,
      "entityGroup",
      { entity_id: ids.workspaceId, group_id: ids.groupId },
      clock,
    ),
    put(
      ids.profileId,
      profile.name,
      { actor_id: actorId, display_name: actorId, avatar_url: "" },
      clock,
    ),
    put(
      ids.profileMembershipId,
      "entityGroup",
      { entity_id: ids.profileId, group_id: ids.groupId },
      clock,
    ),
  ];
}

/** One Action creating the actor's personal workspace, profile, and membership. */
export function buildActorSeedAction(actorId: string): Action {
  const clock = createClock();
  return createAction({ actorId, updates: buildActorSeedUpdates(actorId, clock), clock }).action;
}

function buildSharedSeedUpdates(clock: Clock): UpdateInput[] {
  return [
    put(SHARED_GROUP_ID, "group", { name: "Shared Workspace" }, clock),
    put(
      SHARED_MEMBER_ID,
      "groupMember",
      {
        actor_id: SEEDER_ACTOR_ID,
        group_id: SHARED_GROUP_ID,
        permissions: [...SEED_PERMISSIONS],
      },
      clock,
    ),
    put(
      SHARED_WORKSPACE_ID,
      workspace.name,
      {
        name: "Shared Workspace",
        slug: SHARED_WORKSPACE_SLUG,
        description: "Issues shared with every member.",
      },
      clock,
    ),
    put(
      SHARED_WORKSPACE_MEMBERSHIP_ID,
      "entityGroup",
      { entity_id: SHARED_WORKSPACE_ID, group_id: SHARED_GROUP_ID },
      clock,
    ),
    put(
      SAMPLE_ISSUE_ID,
      issue.name,
      { title: "Welcome to ebb", status: "todo", priority: "medium", assignee_id: null },
      clock,
    ),
    put(
      SAMPLE_ISSUE_MEMBERSHIP_ID,
      "entityGroup",
      { entity_id: SAMPLE_ISSUE_ID, group_id: SHARED_GROUP_ID },
      clock,
    ),
  ];
}

/** One Action creating the shared workspace fixtures, attributed to the seeder. */
export function buildSharedSeedAction(): Action {
  const clock = createClock();
  return createAction({
    actorId: SEEDER_ACTOR_ID,
    updates: buildSharedSeedUpdates(clock),
    clock,
  }).action;
}

/** Rejection reasons a re-seed may safely ignore. */
const isTolerable = (reason: unknown): boolean =>
  reason === "already_exists" || reason === "duplicate_action";

/**
 * Tolerate `already_exists` / `duplicate_action` rejections so a reload
 * re-seeds without failing; any other rejection is fatal.
 */
async function postAction(serverUrl: string, actorId: string, action: Action): Promise<void> {
  const body = encodeSync({ actions: [action] });
  const response = await fetch(`${serverUrl}/sync/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/msgpack",
      "x-ebb-actor-id": actorId,
    },
    body: body as BodyInit,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`seed failed: ${response.status} ${text}`);
  }

  let rejected: readonly { reason?: unknown }[] = [];
  try {
    const parsed = JSON.parse(text) as { rejected?: { reason?: unknown }[] };
    rejected = parsed.rejected ?? [];
  } catch {
    // A non-JSON body on a 2xx is not a rejection.
    return;
  }

  const fatal = rejected.filter((entry) => !isTolerable(entry.reason));
  if (fatal.length > 0) {
    throw new Error(`seed rejected: ${JSON.stringify(fatal)}`);
  }
}

/** Seed the actor's personal workspace, then the shared fixtures. */
export async function seed(serverUrl: string, actorId: string): Promise<void> {
  await postAction(serverUrl, actorId, buildActorSeedAction(actorId));
  await postAction(serverUrl, SEEDER_ACTOR_ID, buildSharedSeedAction());
}
